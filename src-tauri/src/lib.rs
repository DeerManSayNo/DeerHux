#[cfg(not(debug_assertions))]
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(not(debug_assertions))]
use std::net::TcpStream;
#[cfg(not(debug_assertions))]
use std::path::{Path, PathBuf};
#[cfg(not(debug_assertions))]
use std::process::{Child, Command, Stdio};
#[cfg(not(debug_assertions))]
use std::sync::Arc;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
#[cfg(not(debug_assertions))]
use std::time::{Duration, Instant};
#[cfg(all(not(debug_assertions), target_os = "windows"))]
use std::{mem::size_of, os::windows::io::AsRawHandle, os::windows::process::CommandExt};
#[cfg(not(debug_assertions))]
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, TitleBarStyle};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
#[cfg(all(not(debug_assertions), target_os = "windows"))]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
    System::Threading::CreateMutexW,
};

#[cfg(all(not(debug_assertions), target_os = "windows"))]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const QUICK_SESSION_WINDOW_LABEL: &str = "quick-session";
const QUICK_SESSION_OPEN_EVENT: &str = "quick-session://request-open";
const QUICK_SESSION_CLOSE_EVENT: &str = "quick-session://request-close";
const QUICK_SESSION_NEW_EVENT: &str = "quick-session://request-new";
const QUICK_SESSION_WINDOW_WIDTH: f64 = 380.0;
static QUICK_SESSION_SHORTCUT_PRESSED: AtomicBool = AtomicBool::new(false);
static QUICK_SESSION_NEW_SHORTCUT_PRESSED: AtomicBool = AtomicBool::new(false);
static QUICK_SESSION_READY: AtomicBool = AtomicBool::new(false);
static QUICK_SESSION_PENDING_OPEN: AtomicBool = AtomicBool::new(false);
static QUICK_SESSION_PENDING_NEW: AtomicBool = AtomicBool::new(false);
static QUICK_SESSION_CLOSE_REVISION: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
static PREVIOUS_FRONTMOST_PID: Mutex<Option<i32>> = Mutex::new(None);

fn position_quick_session_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let work_area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (QUICK_SESSION_WINDOW_WIDTH * scale).round() as u32;
    let x = work_area.position.x + work_area.size.width as i32 - width as i32;
    window.set_size(tauri::PhysicalSize::new(width, work_area.size.height))?;
    window.set_position(tauri::PhysicalPosition::new(x, work_area.position.y))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn remember_frontmost_application() {
    use objc2_app_kit::NSWorkspace;

    let pid = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|application| application.processIdentifier());
    if let Ok(mut previous) = PREVIOUS_FRONTMOST_PID.lock() {
        *previous = pid;
    }
}

#[cfg(not(target_os = "macos"))]
fn remember_frontmost_application() {}

#[cfg(target_os = "macos")]
fn restore_previous_application() {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    let pid = PREVIOUS_FRONTMOST_PID
        .lock()
        .ok()
        .and_then(|mut previous| previous.take());
    if let Some(pid) = pid {
        if let Some(application) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        {
            application.unhide();
            application.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn restore_previous_application() {}

fn hide_quick_session(app: &tauri::AppHandle, restore_focus: bool) {
    if let Some(window) = app.get_webview_window(QUICK_SESSION_WINDOW_LABEL) {
        if restore_focus {
            // Hand focus back while the drawer is still the key window. If we hide
            // it first, macOS briefly promotes DeerHux's main window before the
            // previous application is activated, which causes a visible flash.
            restore_previous_application();
        }
        let _ = window.hide();
    }
}

#[cfg(target_os = "macos")]
fn set_quick_session_bootstrap_mode(window: &tauri::WebviewWindow, enabled: bool) {
    use objc2_app_kit::NSWindow;

    if let Ok(ns_window_ptr) = window.ns_window() {
        let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
        ns_window.setAlphaValue(if enabled { 0.0 } else { 1.0 });
        ns_window.setIgnoresMouseEvents(enabled);
    }
}

#[cfg(not(target_os = "macos"))]
fn set_quick_session_bootstrap_mode(_window: &tauri::WebviewWindow, _enabled: bool) {}

#[cfg(not(debug_assertions))]
fn wake_quick_session_webview(app: &tauri::AppHandle) {
    let wake_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = wake_app.get_webview_window(QUICK_SESSION_WINDOW_LABEL) else {
            return;
        };
        // WKWebView can defer JavaScript for a window that has never been shown.
        // Make the native host visible but fully transparent and click-through so
        // React can hydrate without flashing or blocking the right edge.
        set_quick_session_bootstrap_mode(&window, true);
        let _ = position_quick_session_window(&window);
        let _ = window.show();
    });

    let fallback_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if QUICK_SESSION_READY.load(Ordering::Acquire) {
            return;
        }
        let main_app = fallback_app.clone();
        let _ = fallback_app.run_on_main_thread(move || {
            if let Some(window) = main_app.get_webview_window(QUICK_SESSION_WINDOW_LABEL) {
                let _ = window.hide();
                set_quick_session_bootstrap_mode(&window, false);
            }
        });
    });
}

#[tauri::command]
fn hide_quick_session_window(app: tauri::AppHandle, restore_focus: bool) {
    hide_quick_session(&app, restore_focus);
}

fn complete_quick_session_ready(app: tauri::AppHandle) {
    let ready_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if QUICK_SESSION_READY.swap(true, Ordering::AcqRel) {
            return;
        }
        let pending_open = QUICK_SESSION_PENDING_OPEN.swap(false, Ordering::AcqRel);
        let request_new = QUICK_SESSION_PENDING_NEW.swap(false, Ordering::AcqRel);
        if let Some(window) = ready_app.get_webview_window(QUICK_SESSION_WINDOW_LABEL) {
            // End the invisible bootstrap before making the drawer logically
            // available. Hiding first also makes open_quick_session_now remember
            // and restore the correct previously focused application.
            let _ = window.hide();
            set_quick_session_bootstrap_mode(&window, false);
        }
        if pending_open {
            open_quick_session_now(&ready_app, request_new);
        }
    });
}

#[tauri::command]
fn mark_quick_session_ready(app: tauri::AppHandle) {
    #[cfg(not(debug_assertions))]
    startup_log("quick-session frontend ready");
    complete_quick_session_ready(app);
}

#[tauri::command]
fn resize_quick_session_window(app: tauri::AppHandle, width: f64) -> Result<(), String> {
    if !width.is_finite() || width <= 0.0 {
        return Err("invalid quick-session width".into());
    }
    let window = app
        .get_webview_window(QUICK_SESSION_WINDOW_LABEL)
        .ok_or_else(|| "quick-session window not found".to_string())?;

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;

        let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
        let ns_window: &NSWindow = unsafe { &*ns_window_ptr.cast() };
        let mut frame = ns_window.frame();
        let right = frame.origin.x + frame.size.width;
        frame.origin.x = right - width;
        frame.size.width = width;
        // Resize the transparent host in one step. Animating the NSWindow frame
        // can outrun WKWebView painting and briefly expose stale/clear frames;
        // the card strip animation is handled by CSS instead.
        ns_window.setFrame_display(frame, true);
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let position = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let physical_width = (width * scale).round() as u32;
        let right = position.x + size.width as i32;
        window
            .set_size(tauri::PhysicalSize::new(physical_width, size.height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(
                right - physical_width as i32,
                position.y,
            ))
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn close_quick_session_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(QUICK_SESSION_WINDOW_LABEL) else {
        return;
    };
    QUICK_SESSION_PENDING_OPEN.store(false, Ordering::Release);
    QUICK_SESSION_PENDING_NEW.store(false, Ordering::Release);
    let close_revision = QUICK_SESSION_CLOSE_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    let _ = window.emit(QUICK_SESSION_CLOSE_EVENT, ());

    // The normal path lets React paint its closed transparent state, then calls
    // hide_quick_session_window. If the quick page has not hydrated or failed to
    // load, that event has no listener; hide natively so an invisible always-on-
    // top window can never keep intercepting the right side of the screen.
    let fallback_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(160));
        let main_app = fallback_app.clone();
        let _ = fallback_app.run_on_main_thread(move || {
            if QUICK_SESSION_CLOSE_REVISION.load(Ordering::Acquire) != close_revision {
                return;
            }
            let still_visible = main_app
                .get_webview_window(QUICK_SESSION_WINDOW_LABEL)
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if still_visible {
                hide_quick_session(&main_app, true);
            } else {
                // The frontend may have hidden the native window through the
                // built-in API already. Focus restoration is still our job and
                // PREVIOUS_FRONTMOST_PID is consumed exactly once.
                restore_previous_application();
            }
        });
    });
}

fn open_quick_session_now(app: &tauri::AppHandle, request_new: bool) {
    QUICK_SESSION_CLOSE_REVISION.fetch_add(1, Ordering::AcqRel);
    let Some(window) = app.get_webview_window(QUICK_SESSION_WINDOW_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        remember_frontmost_application();
        let _ = position_quick_session_window(&window);
        let _ = window.unminimize();
        let _ = window.show();
    }
    let _ = window.set_focus();
    let _ = window.emit(QUICK_SESSION_OPEN_EVENT, ());
    if request_new {
        let _ = window.emit(QUICK_SESSION_NEW_EVENT, ());
    }
}

fn request_open_quick_session(app: &tauri::AppHandle, request_new: bool) {
    QUICK_SESSION_CLOSE_REVISION.fetch_add(1, Ordering::AcqRel);
    if !QUICK_SESSION_READY.load(Ordering::Acquire) {
        QUICK_SESSION_PENDING_OPEN.store(true, Ordering::Release);
        if request_new {
            QUICK_SESSION_PENDING_NEW.store(true, Ordering::Release);
        }
        return;
    }
    open_quick_session_now(app, request_new);
}

fn toggle_quick_session_window(app: &tauri::AppHandle) {
    if !QUICK_SESSION_READY.load(Ordering::Acquire) {
        let already_pending = QUICK_SESSION_PENDING_OPEN.swap(true, Ordering::AcqRel);
        if already_pending {
            QUICK_SESSION_PENDING_OPEN.store(false, Ordering::Release);
            QUICK_SESSION_PENDING_NEW.store(false, Ordering::Release);
        }
        return;
    }
    let visible = app
        .get_webview_window(QUICK_SESSION_WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        close_quick_session_window(app);
        return;
    }
    open_quick_session_now(app, false);
}

#[cfg(target_os = "windows")]
struct OwnedHandle(HANDLE);

#[cfg(target_os = "windows")]
unsafe impl Send for OwnedHandle {}
#[cfg(target_os = "windows")]
unsafe impl Sync for OwnedHandle {}

#[cfg(target_os = "windows")]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CloseHandle(self.0) };
            self.0 = std::ptr::null_mut();
        }
    }
}

#[cfg(target_os = "windows")]
fn acquire_single_instance() -> std::io::Result<Option<OwnedHandle>> {
    #[cfg(debug_assertions)]
    let name: Vec<u16> = "Local\\DeerHux.Desktop.Singleton.Dev\0"
        .encode_utf16()
        .collect();
    #[cfg(not(debug_assertions))]
    let name: Vec<u16> = "Local\\DeerHux.Desktop.Singleton\0"
        .encode_utf16()
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }

    let mutex = OwnedHandle(handle);
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Ok(None);
    }
    Ok(Some(mutex))
}

#[cfg(all(not(debug_assertions), target_os = "windows"))]
fn create_kill_on_close_job() -> std::io::Result<OwnedHandle> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }

    let job = OwnedHandle(handle);
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(job)
}

#[cfg(not(debug_assertions))]
struct BackendProcess {
    pid: u32,
    child: Child,
    #[cfg(target_os = "windows")]
    job: Option<OwnedHandle>,
}

#[cfg(not(debug_assertions))]
struct BackendState {
    child: Mutex<Option<BackendProcess>>,
    stopping: AtomicBool,
    cleaned: AtomicBool,
    startup_logging: Arc<AtomicBool>,
}

#[cfg(not(debug_assertions))]
impl BackendState {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
            cleaned: AtomicBool::new(false),
            startup_logging: Arc::new(AtomicBool::new(true)),
        }
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.startup_logging.store(false, Ordering::Release);
        if self.cleaned.swap(true, Ordering::AcqRel) {
            return;
        }

        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut process) = slot.take() {
                startup_log(format!("stopping backend pid={}", process.pid));
                // Graceful shutdown first: closing the stdin pipe lets the
                // backend exit(0) and persist its compile cache. Only fall
                // back to hard termination if it ignores the signal.
                drop(process.child.stdin.take());
                let mut exited_gracefully = false;
                for _ in 0..30 {
                    if process.child.try_wait().ok().flatten().is_some() {
                        exited_gracefully = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !exited_gracefully {
                    startup_log(format!(
                        "backend pid={} did not exit gracefully, killing",
                        process.pid
                    ));
                    #[cfg(target_os = "windows")]
                    process.job.take();
                    let _ = process.child.kill();
                    let _ = process.child.wait();
                }
                remove_owned_pid_file(process.pid);
            }
        }
    }
}

#[cfg(not(debug_assertions))]
fn agent_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".deerhux").join("agent")
}

#[cfg(not(debug_assertions))]
fn server_pid_path() -> PathBuf {
    agent_dir().join("server.pid")
}

#[cfg(not(debug_assertions))]
fn scheduler_lock_path() -> PathBuf {
    agent_dir().join("scheduler.lock")
}

#[cfg(not(debug_assertions))]
fn startup_log_path() -> PathBuf {
    agent_dir().join("logs").join("desktop-startup.log")
}

/// Opens the log only for one write. In particular, the desktop process does not
/// retain a log handle that prevents rotation/deletion on Windows.
#[cfg(not(debug_assertions))]
fn startup_log(message: impl AsRef<str>) {
    let path = startup_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 1024 * 1024) {
        let rotated = path.with_extension("log.old");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&path, rotated);
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis());
        let _ = writeln!(file, "[{now}] {}", message.as_ref());
    }
}

#[cfg(not(debug_assertions))]
fn redact_backend_log_line(line: &str) -> String {
    let line = line.trim().chars().take(2000).collect::<String>();
    let lowercase = line.to_ascii_lowercase();
    const SENSITIVE_MARKERS: [&str; 6] = [
        "authorization",
        "api-key",
        "api_key",
        "apikey",
        "token",
        "secret",
    ];
    let sensitive_at = SENSITIVE_MARKERS
        .iter()
        .filter_map(|marker| lowercase.find(marker))
        .min();
    match sensitive_at {
        Some(index) => format!("{}[REDACTED]", &line[..index]),
        None => line,
    }
}

/// Drain both pipes for the child lifetime to prevent backpressure. Only the
/// startup window is persisted; later provider/tool output may contain user data.
#[cfg(not(debug_assertions))]
fn capture_backend_output(
    reader: impl Read + Send + 'static,
    stream: &'static str,
    enabled: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if enabled.load(Ordering::Acquire) {
                let line = redact_backend_log_line(&line);
                if !line.is_empty() {
                    startup_log(format!("backend {stream}: {line}"));
                }
            }
        }
    });
}

#[cfg(not(debug_assertions))]
fn find_available_port() -> std::io::Result<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr().map(|addr| addr.port()))
}

#[cfg(not(debug_assertions))]
enum ReadinessProbe {
    Ready,
    Pending,
    Failed(String),
}

#[cfg(not(debug_assertions))]
fn probe_server_readiness(port: u16) -> ReadinessProbe {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(250),
    ) else {
        return ReadinessProbe::Pending;
    };
    // Windows cold starts may spend several seconds loading externalized agent
    // modules through Defender. Wait for one probe instead of piling up retries.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    if stream
        .write_all(
            b"GET /api/health/ready HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return ReadinessProbe::Pending;
    }

    let mut buffer = Vec::with_capacity(4096);
    if stream.take(8192).read_to_end(&mut buffer).is_err() {
        return ReadinessProbe::Pending;
    }
    let Ok(response) = std::str::from_utf8(&buffer) else {
        return ReadinessProbe::Pending;
    };
    let headers = response
        .split_once("\r\n\r\n")
        .map_or(response, |(headers, _)| headers)
        .to_ascii_lowercase();
    let is_deerhux = headers
        .lines()
        .any(|line| line.trim() == "x-deerhux-ready: 1");
    if response.starts_with("HTTP/1.1 200") && is_deerhux {
        return ReadinessProbe::Ready;
    }
    if response.starts_with("HTTP/1.1 503") && is_deerhux {
        let permanent_failure = [
            "node_version_unsupported",
            "agent_directory_unavailable",
            "run_store_unavailable",
        ]
        .iter()
        .any(|code| headers.contains(&format!("x-deerhux-readiness-code: {code}")));
        if !permanent_failure {
            return ReadinessProbe::Pending;
        }
        let body = response.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        let detail = body
            .replace('\r', " ")
            .replace('\n', " ")
            .chars()
            .take(1000)
            .collect::<String>();
        return ReadinessProbe::Failed(format!("后台运行时自检失败：{detail}"));
    }
    ReadinessProbe::Pending
}

#[cfg(not(debug_assertions))]
fn wait_for_server(port: u16, backend: &BackendState) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(60) {
        if backend.stopping.load(Ordering::Acquire) {
            return Err("应用窗口已关闭".into());
        }
        match probe_server_readiness(port) {
            ReadinessProbe::Ready => return Ok(()),
            ReadinessProbe::Failed(error) => return Err(error),
            ReadinessProbe::Pending => {}
        }
        if let Ok(mut slot) = backend.child.lock() {
            if let Some(process) = slot.as_mut() {
                if let Ok(Some(status)) = process.child.try_wait() {
                    return Err(format!("后台服务过早退出（{status}）"));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "等待后台运行时自检超时（60 秒，http://127.0.0.1:{port}/api/health/ready）"
    ))
}

#[cfg(not(debug_assertions))]
fn write_server_pid(pid: u32) -> std::io::Result<()> {
    std::fs::create_dir_all(agent_dir())?;
    std::fs::write(server_pid_path(), pid.to_string())
}

/// Delete only the pid file that still names our child. This prevents one
/// concurrently started desktop instance from deleting another's ownership file.
#[cfg(not(debug_assertions))]
fn remove_owned_pid_file(pid: u32) {
    let path = server_pid_path();
    if std::fs::read_to_string(&path)
        .ok()
        .is_some_and(|value| value.trim() == pid.to_string())
    {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(all(not(debug_assertions), unix))]
fn command_for_pid(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Best-effort compatibility cleanup for old releases. Windows deliberately does
/// no PID probing here: tasklist/wmic were a large startup cost and command-line
/// identity cannot be checked safely without risking PID-reuse kills.
#[cfg(not(debug_assertions))]
fn cleanup_legacy_backend() {
    #[cfg(unix)]
    {
        let path = server_pid_path();
        let pid = std::fs::read_to_string(&path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        if let Some(pid) = pid {
            if command_for_pid(pid).is_some_and(|command| {
                command.contains("deerhux-server.js") || command.contains("next-server")
            }) {
                let _ = Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .status();
            }
            let _ = std::fs::remove_file(path);
        }

        // Builds older than server.pid recorded the Next owner in scheduler.lock.
        // Keep this compatibility path on Unix, where command identity is cheap.
        let scheduler_path = scheduler_lock_path();
        let scheduler_pid = std::fs::read_to_string(&scheduler_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| value.get("pid")?.as_u64())
            .and_then(|pid| u32::try_from(pid).ok());
        if let Some(pid) = scheduler_pid {
            if command_for_pid(pid).is_some_and(|command| {
                command.contains("deerhux-server.js") || command.contains("next-server")
            }) {
                let _ = Command::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .status();
                let _ = std::fs::remove_file(scheduler_path);
            }
        }
    }

    #[cfg(windows)]
    startup_log("legacy cleanup skipped on Windows (safe no-wmic policy)");
}

#[cfg(not(debug_assertions))]
fn node_compile_cache_dir() -> PathBuf {
    // ~/.deerhux/node-compile-cache — one level above agent_dir().
    let dir = agent_dir();
    dir.parent()
        .map(|root| root.join("node-compile-cache"))
        .unwrap_or_else(|| dir.join("node-compile-cache"))
}

#[cfg(not(debug_assertions))]
fn resolve_node(resource_dir: &Path) -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| resource_dir.to_path_buf());

    #[cfg(target_os = "windows")]
    let bundle_node = exe_dir.join("node.exe");
    #[cfg(not(target_os = "windows"))]
    let bundle_node = exe_dir.join("node");

    #[cfg(target_os = "macos")]
    {
        let temp_dir = std::env::temp_dir().join("deerhux-node");
        let destination = temp_dir.join("node");
        let _ = std::fs::create_dir_all(&temp_dir);

        // The sidecar is copied out of the signed app bundle because macOS can
        // otherwise delay its first execution. Do not blindly reuse that copy:
        // after an app upgrade it may still be an older Node runtime.
        let read_version = |path: &Path| {
            Command::new(path)
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        };
        let bundled_version = read_version(&bundle_node);
        let cached_version = read_version(&destination);
        if bundled_version.is_none() || cached_version != bundled_version {
            let pending = temp_dir.join(format!("node.tmp-{}", std::process::id()));
            let copied = std::fs::copy(&bundle_node, &pending)
                .and_then(|_| {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o755))
                })
                .and_then(|_| std::fs::rename(&pending, &destination));
            let _ = std::fs::remove_file(&pending);
            if copied.is_err() {
                return bundle_node;
            }
        }
        destination
    }
    #[cfg(not(target_os = "macos"))]
    bundle_node
}

#[cfg(not(debug_assertions))]
fn show_startup_error(app: &tauri::AppHandle, message: &str) {
    startup_log(format!("startup failed: {message}"));
    if let Some(window) = app.get_webview_window("main") {
        let encoded = serde_json::to_string(message).unwrap_or_else(|_| "\"未知错误\"".into());
        let _ = window.eval(&format!(
            "window.__DEERHUX_STARTUP_ERROR && window.__DEERHUX_STARTUP_ERROR({encoded})"
        ));
    }
}

#[cfg(not(debug_assertions))]
fn start_backend(app: tauri::AppHandle, backend: Arc<BackendState>, process_started: Instant) {
    let result = (|| -> Result<u16, String> {
        if backend.stopping.load(Ordering::Acquire) {
            return Err("应用窗口已关闭".into());
        }

        cleanup_legacy_backend();
        startup_log(format!(
            "legacy cleanup complete +{}ms",
            process_started.elapsed().as_millis()
        ));
        let port = find_available_port().map_err(|error| format!("无法分配本地端口：{error}"))?;
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| format!("无法定位应用资源：{error}"))?;
        let node = resolve_node(&resource_dir);
        let server_js = resource_dir.join("deerhux-server.js");
        let node_version = Command::new(&node)
            .arg("--version")
            .output()
            .map_err(|error| format!("无法执行内置 Node.js：{error}"))?;
        if !node_version.status.success() {
            return Err(format!(
                "内置 Node.js 版本检查失败（{}）",
                node_version.status
            ));
        }
        let node_version = String::from_utf8_lossy(&node_version.stdout)
            .trim()
            .to_string();
        startup_log(format!(
            "runtime app=v{} node={} resource={} port={port}",
            env!("CARGO_PKG_VERSION"),
            node_version,
            resource_dir.display()
        ));
        // V8 compile cache persisted across launches: after the first run,
        // starts skip parsing/compiling ~25MB of bundled JS.
        let compile_cache = node_compile_cache_dir();
        let _ = std::fs::create_dir_all(&compile_cache);

        let mut command = Command::new(&node);
        command
            .arg(&server_js)
            .env("DEERHUX_RESOURCE_DIR", &resource_dir)
            .env("PORT", port.to_string())
            .env("NODE_COMPILE_CACHE", &compile_cache)
            // stdin pipe doubles as a shutdown signal: the launcher exits(0)
            // on stdin EOF, letting Node flush the V8 compile cache to disk
            // (Windows has no deliverable signal; TerminateProcess skips it).
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        #[cfg(target_os = "windows")]
        let job =
            create_kill_on_close_job().map_err(|error| format!("无法创建后台进程保护：{error}"))?;
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动后台服务：{error}"))?;
        let pid = child.id();
        if let Some(stdout) = child.stdout.take() {
            capture_backend_output(stdout, "stdout", Arc::clone(&backend.startup_logging));
        }
        if let Some(stderr) = child.stderr.take() {
            capture_backend_output(stderr, "stderr", Arc::clone(&backend.startup_logging));
        }
        #[cfg(target_os = "windows")]
        if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) } == 0 {
            let error = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("无法绑定后台进程生命周期：{error}"));
        }
        // Publishing the child and pid file is atomic with respect to exit cleanup.
        let mut slot = backend
            .child
            .lock()
            .map_err(|_| "后台进程状态锁损坏".to_string())?;
        if backend.stopping.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("应用窗口已关闭".into());
        }
        write_server_pid(pid).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            remove_owned_pid_file(pid);
            format!("无法记录后台进程：{error}")
        })?;
        *slot = Some(BackendProcess {
            pid,
            child,
            #[cfg(target_os = "windows")]
            job: Some(job),
        });
        drop(slot);

        startup_log(format!(
            "backend spawned pid={pid} +{}ms",
            process_started.elapsed().as_millis()
        ));
        let readiness = wait_for_server(port, &backend);
        backend.startup_logging.store(false, Ordering::Release);
        readiness?;
        Ok(port)
    })();

    match result {
        Ok(port) if !backend.stopping.load(Ordering::Acquire) => {
            startup_log(format!(
                "backend ready +{}ms",
                process_started.elapsed().as_millis()
            ));
            if let Some(window) = app.get_webview_window("main") {
                match format!("http://127.0.0.1:{port}").parse() {
                    Ok(url) => {
                        if let Err(error) = window.navigate(url) {
                            show_startup_error(
                                &app,
                                &format!("后台已启动，但页面打开失败：{error}"),
                            );
                            backend.stop();
                            return;
                        }
                    }
                    Err(error) => show_startup_error(&app, &format!("本地地址无效：{error}")),
                }
            } else {
                backend.stop();
            }
            if let Some(window) = app.get_webview_window(QUICK_SESSION_WINDOW_LABEL) {
                QUICK_SESSION_READY.store(false, Ordering::Release);
                match format!("http://127.0.0.1:{port}/quick-session").parse() {
                    Ok(url) => {
                        if let Err(error) = window.navigate(url) {
                            startup_log(format!("quick-session navigation failed: {error}"));
                            eprintln!("failed to open quick-session window: {error}");
                        } else {
                            wake_quick_session_webview(&app);
                        }
                    }
                    Err(error) => {
                        startup_log(format!("invalid quick-session URL: {error}"));
                        eprintln!("invalid quick-session URL: {error}");
                    }
                }
            }
        }
        Ok(_) => backend.stop(),
        Err(message) => {
            if !backend.stopping.load(Ordering::Acquire) {
                show_startup_error(&app, &message);
            }
            backend.stop();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    let _instance_mutex = match acquire_single_instance() {
        Ok(Some(mutex)) => mutex,
        Ok(None) => return,
        Err(error) => {
            eprintln!("failed to acquire DeerHux single-instance mutex: {error}");
            return;
        }
    };

    #[cfg(not(debug_assertions))]
    let backend = Arc::new(BackendState::new());
    #[cfg(not(debug_assertions))]
    let setup_backend = Arc::clone(&backend);
    #[cfg(not(debug_assertions))]
    let process_started = Instant::now();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if shortcut.matches(Modifiers::ALT, Code::Backquote) {
                        match event.state() {
                            ShortcutState::Pressed => {
                                if !QUICK_SESSION_SHORTCUT_PRESSED.swap(true, Ordering::AcqRel) {
                                    #[cfg(not(debug_assertions))]
                                    startup_log(format!(
                                        "quick-session shortcut pressed (ready={}, pending={})",
                                        QUICK_SESSION_READY.load(Ordering::Acquire),
                                        QUICK_SESSION_PENDING_OPEN.load(Ordering::Acquire)
                                    ));
                                    toggle_quick_session_window(app);
                                }
                            }
                            ShortcutState::Released => {
                                QUICK_SESSION_SHORTCUT_PRESSED.store(false, Ordering::Release);
                            }
                        }
                    } else if shortcut.matches(Modifiers::ALT, Code::KeyQ) {
                        match event.state() {
                            ShortcutState::Pressed => {
                                if !QUICK_SESSION_NEW_SHORTCUT_PRESSED.swap(true, Ordering::AcqRel)
                                {
                                    request_open_quick_session(app, true);
                                }
                            }
                            ShortcutState::Released => {
                                QUICK_SESSION_NEW_SHORTCUT_PRESSED.store(false, Ordering::Release);
                            }
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            hide_quick_session_window,
            mark_quick_session_ready,
            resize_quick_session_window,
        ])
        .setup(move |app| {
            #[cfg(debug_assertions)]
            let webview_url = WebviewUrl::External("http://localhost:30141".parse()?);
            #[cfg(not(debug_assertions))]
            let webview_url = WebviewUrl::App("index.html".into());

            let builder = WebviewWindowBuilder::new(app, "main", webview_url)
                .title("DeerHux")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0);

            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(14.0, 15.0));
            #[cfg(target_os = "windows")]
            let builder = builder.decorations(false);

            let window = builder.build()?;
            #[cfg(not(debug_assertions))]
            let _ = &window;

            #[cfg(debug_assertions)]
            let quick_session_url =
                WebviewUrl::External("http://localhost:30141/quick-session".parse()?);
            #[cfg(not(debug_assertions))]
            let quick_session_url = WebviewUrl::App("index.html".into());
            let quick_session_window =
                WebviewWindowBuilder::new(app, QUICK_SESSION_WINDOW_LABEL, quick_session_url)
                    .title("DeerHux 快捷会话")
                    .inner_size(QUICK_SESSION_WINDOW_WIDTH, 800.0)
                    .min_inner_size(380.0, 480.0)
                    .decorations(false)
                    .transparent(true)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    // The drawer paints its own moving shadow. A native shadow
                    // appears as soon as the transparent NSWindow is shown and
                    // can look like a separate first entrance before the CSS
                    // animation begins.
                    .shadow(false)
                    .visible(false)
                    .on_page_load(|_window, _payload| {
                        #[cfg(not(debug_assertions))]
                        if _payload.event() == PageLoadEvent::Finished
                            && _payload.url().path().trim_end_matches('/') == "/quick-session"
                        {
                            startup_log("quick-session page load finished");
                            let ready_app = _window.app_handle().clone();
                            // The load event runs after deferred scripts, but leave
                            // React one paint turn to install its event listeners.
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(350));
                                complete_quick_session_ready(ready_app);
                            });
                        }
                    })
                    .build()?;
            position_quick_session_window(&quick_session_window)?;

            let quick_session_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Backquote);
            if let Err(error) = app.global_shortcut().register(quick_session_shortcut) {
                #[cfg(not(debug_assertions))]
                startup_log(format!(
                    "failed to register quick-session shortcut: {error}"
                ));
                eprintln!("failed to register quick-session shortcut: {error}");
            }
            let quick_session_new_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::KeyQ);
            if let Err(error) = app.global_shortcut().register(quick_session_new_shortcut) {
                #[cfg(not(debug_assertions))]
                startup_log(format!(
                    "failed to register new quick-session shortcut: {error}"
                ));
                eprintln!("failed to register new quick-session shortcut: {error}");
            }

            #[cfg(debug_assertions)]
            window.open_devtools();
            #[cfg(not(debug_assertions))]
            {
                startup_log(format!(
                    "placeholder visible +{}ms",
                    process_started.elapsed().as_millis()
                ));
                let handle = app.handle().clone();
                let state = Arc::clone(&setup_backend);
                std::thread::spawn(move || start_backend(handle, state, process_started));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_handle, _event| {
        #[cfg(not(debug_assertions))]
        if matches!(
            _event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            backend.stop();
        }
    });
}
