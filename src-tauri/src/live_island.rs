//! DeerHux 灵动岛 (macOS dynamic island) host.
//!
//! Ported from AIControls' `live_island.rs`. The upstream module is a TCP server
//! that ingests Claude Code / OpenCode / pi-agent hook payloads and renders rows
//! for *every* agent on the machine. DeerHux keeps only the parts it needs:
//!
//!   * No TCP listener. DeerHux's own Node server pushes rows through the
//!     `live_island_push_events` command, so nothing listens on a fixed port and
//!     no other agent can feed the island.
//!   * No Claude Code hook install/remove, no OpenCode plugin, no pi-agent
//!     extension injection. Those all mutate files outside DeerHux.
//!   * No cross-application focus/activation (`focus_bundles_for_agent`). Rows
//!     belong to DeerHux sessions, so clicking one focuses DeerHux.
//!   * No permission-approval drawer. DeerHux confirms destructive actions in its
//!     own UI, not in the island.
//!
//! Concurrency: DeerHux runs many sessions at once inside a single Node process.
//! Rows are keyed by session id and merged idempotently, so an arbitrary number
//! of concurrent sessions can push updates without racing each other. The Node
//! side sends absolute timestamps, which keeps elapsed-time rendering stable
//! regardless of when a batch actually arrives.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

#[cfg(target_os = "macos")]
use crate::live_island_macos::configure_live_island_window;

pub const LIVE_ISLAND_WINDOW_LABEL: &str = "live-island";
const LIVE_ISLAND_SNAPSHOT_EVENT: &str = "live-island-snapshot-changed";
const LIVE_ISLAND_HOVER_EVENT: &str = "live-island-hover-changed";
const LIVE_ISLAND_LAYOUT_EVENT: &str = "live-island-layout-changed";
const LIVE_ISLAND_SETTINGS_EVENT: &str = "live-island-settings-changed";
const LIVE_ISLAND_HOVER_POLL_MS: u64 = 16;
const LIVE_ISLAND_SETTINGS_PATH: &str = "live_island_setting.json";

const LIVE_ISLAND_WIDTH: f64 = 460.0;
const LIVE_ISLAND_MIN_HEIGHT: f64 = 34.0;
const LIVE_ISLAND_ROW_HEIGHT: f64 = 26.0;
const LIVE_ISLAND_VERTICAL_PADDING: f64 = 4.0;
const LIVE_ISLAND_DRAWER_HEIGHT_BUFFER: f64 = 2.0;
const LIVE_ISLAND_PROJECT_MAX_CHARS: usize = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LiveIslandRowStatus {
    Thinking,
    Reading,
    Editing,
    Writing,
    Running,
    Searching,
    Done,
    Interrupted,
    Error,
    Waiting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LiveIslandScale {
    Small,
    Medium,
    Large,
    Xlarge,
}

impl Default for LiveIslandScale {
    fn default() -> Self {
        Self::Medium
    }
}

impl LiveIslandScale {
    fn factor(&self) -> f64 {
        match self {
            Self::Small => 0.88,
            Self::Medium => 1.0,
            Self::Large => 1.18,
            Self::Xlarge => 1.35,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveIslandRow {
    pub id: String,
    pub project: String,
    pub status: LiveIslandRowStatus,
    pub detail: String,
    pub prompt: String,
    pub started_at: u64,
    pub last_active_at: u64,
    pub detail_started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_elapsed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_detail_elapsed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveIslandLayout {
    pub has_notch: bool,
    pub notch_width: f64,
}

impl Default for LiveIslandLayout {
    fn default() -> Self {
        Self {
            has_notch: false,
            notch_width: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveIslandSnapshot {
    pub rows: Vec<LiveIslandRow>,
    pub scale: LiveIslandScale,
    #[serde(default)]
    pub layout: LiveIslandLayout,
    /// Whether the island is currently enabled in DeerHux settings.
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveIslandEvent {
    /// Session id. Reused as the row key so concurrent sessions never collide.
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub project: Option<String>,
    pub status: Option<LiveIslandRowStatus>,
    pub detail: Option<String>,
    pub prompt: Option<String>,
    pub started_at: Option<u64>,
    pub last_active_at: Option<u64>,
    pub detail_started_at: Option<u64>,
    pub frozen_elapsed: Option<u64>,
    pub frozen_detail_elapsed: Option<u64>,
    pub delay_ms: Option<u64>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone)]
struct LiveIslandTrackedRow {
    row: LiveIslandRow,
    remove_at: Option<u64>,
}

#[derive(Debug, Default)]
struct LiveIslandState {
    rows: HashMap<String, LiveIslandTrackedRow>,
    /// Session ids the user dismissed, mapped to the run `started_at` at dismiss
    /// time. A later run of the same session is allowed through again.
    dismissed_ids: HashMap<String, u64>,
    scale: LiveIslandScale,
    version: u64,
}

#[derive(Debug, Default)]
struct LiveIslandWindowState {
    hovered: bool,
    row_count: usize,
    scale: LiveIslandScale,
    /// Logical px — measured by the webview when the drawer is open.
    drawer_height: f64,
}

static LIVE_ISLAND_WINDOW_STATE: OnceLock<Mutex<LiveIslandWindowState>> = OnceLock::new();
static LIVE_ISLAND_ROWS_STATE: OnceLock<Arc<Mutex<LiveIslandState>>> = OnceLock::new();
static LIVE_ISLAND_HOVER_RUNNING: OnceLock<Arc<AtomicBool>> = OnceLock::new();
static LIVE_ISLAND_FRONTEND_READY: AtomicBool = AtomicBool::new(false);

fn live_island_rows_state() -> Option<Arc<Mutex<LiveIslandState>>> {
    LIVE_ISLAND_ROWS_STATE.get().cloned()
}

impl LiveIslandState {
    /// Returns false when the user dismissed this session for the current run.
    fn allow_dismissed_session(&mut self, id: &str, event_started_at: Option<u64>) -> bool {
        let Some(&dismissed_started) = self.dismissed_ids.get(id) else {
            return true;
        };
        let Some(incoming) = event_started_at else {
            return false;
        };
        if incoming > dismissed_started {
            self.dismissed_ids.remove(id);
            true
        } else {
            false
        }
    }

    fn apply_event(&mut self, event: LiveIslandEvent) {
        match event.event_type.as_str() {
            "update" => self.apply_update(event),
            "remove" => {
                if let Some(id) = event.id {
                    self.dismissed_ids.remove(&id);
                    if self.rows.remove(&id).is_some() {
                        self.version += 1;
                    }
                }
            }
            "done-retract" => {
                if let Some(id) = event.id {
                    if let Some(tracked) = self.rows.get_mut(&id) {
                        let now = now_ms();
                        let was_interrupted =
                            tracked.row.status == LiveIslandRowStatus::Interrupted;
                        if tracked.row.status != LiveIslandRowStatus::Error {
                            tracked.row.status = LiveIslandRowStatus::Done;
                            if tracked.row.detail.is_empty() || was_interrupted {
                                tracked.row.detail = "Done · 完成".to_string();
                            }
                        }
                        if tracked.row.frozen_elapsed.is_none() {
                            tracked.row.frozen_elapsed =
                                Some(now.saturating_sub(tracked.row.started_at));
                        }
                        tracked.row.last_active_at = now;
                        tracked.remove_at = Some(now + event.delay_ms.unwrap_or(5_000));
                        self.version += 1;
                    }
                }
            }
            _ => {}
        }
    }

    fn apply_update(&mut self, event: LiveIslandEvent) {
        let Some(id) = event.id else {
            return;
        };
        if !self.allow_dismissed_session(&id, event.started_at) {
            return;
        }
        let Some(status) = event.status else {
            return;
        };

        let now = now_ms();
        let project = truncate(
            event.project.unwrap_or_else(|| "DeerHux".to_string()),
            LIVE_ISLAND_PROJECT_MAX_CHARS,
        );
        let detail = truncate(event.detail.unwrap_or_default(), 80);
        let prompt = truncate(event.prompt.unwrap_or_default(), 64);
        let existing = self.rows.get(&id).map(|tracked| tracked.row.clone());
        let started_at = event
            .started_at
            .or_else(|| existing.as_ref().map(|row| row.started_at))
            .unwrap_or(now);
        let last_active_at = event
            .last_active_at
            .or_else(|| existing.as_ref().map(|row| row.last_active_at))
            .unwrap_or(now);
        let cwd = event
            .cwd
            .filter(|s| !s.is_empty())
            .or_else(|| existing.as_ref().and_then(|row| row.cwd.clone()));
        let detail_started_at = event
            .detail_started_at
            .or_else(|| existing.as_ref().map(|row| row.detail_started_at))
            .unwrap_or(started_at);

        let next = LiveIslandRow {
            id: id.clone(),
            project,
            status,
            detail,
            prompt,
            started_at,
            last_active_at,
            detail_started_at,
            frozen_elapsed: event.frozen_elapsed,
            frozen_detail_elapsed: event.frozen_detail_elapsed,
            cwd,
        };

        let changed = existing.as_ref() != Some(&next);
        let remove_at = self.rows.get(&id).and_then(|tracked| tracked.remove_at);
        self.rows.insert(
            id,
            LiveIslandTrackedRow {
                row: next,
                remove_at,
            },
        );
        if changed {
            self.version += 1;
        }
    }

    fn cleanup_expired(&mut self) {
        let now = now_ms();
        let before = self.rows.len();
        self.rows.retain(|_, row| match row.remove_at {
            Some(deadline) => deadline > now,
            None => true,
        });
        if self.rows.len() != before {
            self.version += 1;
        }
    }

    fn snapshot(&self) -> LiveIslandSnapshot {
        let mut rows = self
            .rows
            .values()
            .map(|tracked| tracked.row.clone())
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| {
            status_rank(&a.status)
                .cmp(&status_rank(&b.status))
                .then_with(|| a.project.cmp(&b.project))
                .then_with(|| a.id.cmp(&b.id))
        });
        LiveIslandSnapshot {
            rows,
            scale: self.scale.clone(),
            layout: LiveIslandLayout::default(),
            enabled: true,
        }
    }

    fn clear(&mut self) {
        if !self.rows.is_empty() {
            self.rows.clear();
            self.version += 1;
        }
        self.dismissed_ids.clear();
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn live_island_window_state() -> &'static Mutex<LiveIslandWindowState> {
    LIVE_ISLAND_WINDOW_STATE.get_or_init(|| Mutex::new(LiveIslandWindowState::default()))
}

fn status_rank(status: &LiveIslandRowStatus) -> u8 {
    match status {
        LiveIslandRowStatus::Waiting => 0,
        LiveIslandRowStatus::Reading => 1,
        LiveIslandRowStatus::Editing => 2,
        LiveIslandRowStatus::Writing => 3,
        LiveIslandRowStatus::Running => 4,
        LiveIslandRowStatus::Searching => 5,
        LiveIslandRowStatus::Thinking => 6,
        LiveIslandRowStatus::Interrupted => 7,
        LiveIslandRowStatus::Error => 8,
        LiveIslandRowStatus::Done => 9,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_millis(0))
        .as_millis() as u64
}

fn truncate(input: String, max_chars: usize) -> String {
    let compact = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    let mut count = 0;
    for ch in compact.chars() {
        if count >= max_chars {
            out.push('…');
            return out;
        }
        out.push(ch);
        count += 1;
    }
    out
}

fn current_live_island_layout() -> LiveIslandLayout {
    #[cfg(target_os = "macos")]
    {
        let notch = crate::live_island_macos::query_notch_layout();
        return LiveIslandLayout {
            has_notch: notch.has_notch,
            notch_width: notch.notch_width,
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        LiveIslandLayout::default()
    }
}

fn enrich_snapshot_layout(snapshot: &mut LiveIslandSnapshot) {
    snapshot.layout = current_live_island_layout();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn live_island_setting_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve(LIVE_ISLAND_SETTINGS_PATH, BaseDirectory::AppData)
        .map_err(|e| format!("无法解析灵动岛设置路径: {e}"))
}

pub fn get_live_island_setting(app: &AppHandle) -> Result<bool, String> {
    let path = live_island_setting_path(app)?;
    if !path.is_file() {
        // Default: enabled. The island only appears while a session is running.
        return Ok(true);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<bool>(&text).map_err(|e| format!("读取灵动岛设置失败: {e}"))
}

fn save_live_island_setting(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let path = live_island_setting_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建设置目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&enabled).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入灵动岛设置失败: {e}"))
}

fn live_island_scale_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve("live_island_scale.json", BaseDirectory::AppData)
        .map_err(|e| format!("无法解析灵动岛缩放设置路径: {e}"))
}

fn get_live_island_scale(app: &AppHandle) -> Result<LiveIslandScale, String> {
    let path = live_island_scale_path(app)?;
    if !path.is_file() {
        return Ok(LiveIslandScale::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<LiveIslandScale>(&text)
        .map_err(|e| format!("读取灵动岛缩放设置失败: {e}"))
}

fn save_live_island_scale(app: &AppHandle, scale: &LiveIslandScale) -> Result<(), String> {
    let path = live_island_scale_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建设置目录失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(scale).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入灵动岛缩放设置失败: {e}"))
}

// ---------------------------------------------------------------------------
// Window geometry
// ---------------------------------------------------------------------------

fn compact_visible_row_count(session_count: usize) -> usize {
    match session_count {
        0 => 0,
        1 | 2 => 1,
        count => count.div_ceil(2),
    }
}

fn live_island_anchor_logical_height(visible_row_count: usize, scale: &LiveIslandScale) -> f64 {
    let island_scale = scale.factor();
    (visible_row_count as f64 * LIVE_ISLAND_ROW_HEIGHT * island_scale
        + LIVE_ISLAND_VERTICAL_PADDING * island_scale)
        .max(LIVE_ISLAND_MIN_HEIGHT * island_scale)
}

fn live_island_menu_bar_top_offset(monitor: &tauri::Monitor, window_height: u32) -> i32 {
    let monitor_position = monitor.position();
    let work_area = monitor.work_area();
    let menu_bar_height = (work_area.position.y - monitor_position.y).max(0);
    let window_height = window_height as i32;
    if window_height <= menu_bar_height {
        (menu_bar_height - window_height) / 2
    } else {
        2
    }
    .max(0)
}

fn live_island_screen_position(
    app: &AppHandle,
    width: u32,
    anchor_height: u32,
) -> PhysicalPosition<i32> {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let monitor_position = monitor.position();
            let monitor_size = monitor.size();
            let x = monitor_position.x + (monitor_size.width as i32 - width as i32) / 2;
            // Anchor to the pill height so expanding the drawer grows downward only.
            let y_offset = live_island_menu_bar_top_offset(&monitor, anchor_height);
            PhysicalPosition::new(x, monitor_position.y + y_offset)
        })
        .unwrap_or_else(|| PhysicalPosition::new(0, 0))
}

fn emit_live_island_layout(window: &tauri::WebviewWindow) {
    let layout = current_live_island_layout();
    let _ = window.emit(LIVE_ISLAND_LAYOUT_EVENT, &layout);
}

fn sync_live_island_window(
    app: &AppHandle,
    visible_row_count: usize,
    scale: &LiveIslandScale,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LIVE_ISLAND_WINDOW_LABEL) else {
        return Ok(());
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let island_scale = scale.factor();
    // Compact mode collapses many concurrent sessions into fewer visual rows.
    let row_count = compact_visible_row_count(visible_row_count);

    let (hovered, drawer_height) = live_island_window_state()
        .lock()
        .map(|state| {
            if state.hovered && state.row_count > 0 {
                let drawer = if state.drawer_height > 0.0 {
                    state.drawer_height
                } else {
                    // Bootstrap until the webview reports measured drawer height.
                    48.0
                };
                (true, drawer)
            } else {
                (false, 0.0)
            }
        })
        .unwrap_or((false, 0.0));

    let width = (LIVE_ISLAND_WIDTH * island_scale * scale_factor)
        .ceil()
        .max(1.0) as u32;
    let logical_height = (row_count as f64 * LIVE_ISLAND_ROW_HEIGHT * island_scale
        + LIVE_ISLAND_VERTICAL_PADDING * island_scale)
        .max(LIVE_ISLAND_MIN_HEIGHT * island_scale)
        + if hovered {
            drawer_height + LIVE_ISLAND_DRAWER_HEIGHT_BUFFER * island_scale
        } else {
            0.0
        };
    let height = (logical_height * scale_factor).ceil().max(1.0) as u32;
    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_ignore_cursor_events(row_count == 0);

    if let Ok(mut state) = live_island_window_state().lock() {
        state.row_count = row_count;
        state.scale = scale.clone();
        if visible_row_count == 0 {
            state.hovered = false;
            state.drawer_height = 0.0;
        }
    }

    let anchor_height = (live_island_anchor_logical_height(row_count, scale) * scale_factor)
        .round()
        .max(1.0) as u32;
    let pos = live_island_screen_position(app, width, anchor_height);
    let _ = window.set_position(pos);
    #[cfg(target_os = "macos")]
    configure_live_island_window(&window);
    emit_live_island_layout(&window);
    Ok(())
}

fn hide_live_island(app: &AppHandle) -> Result<(), String> {
    if let Ok(mut state) = live_island_window_state().lock() {
        state.hovered = false;
        state.row_count = 0;
        state.drawer_height = 0.0;
    }
    if let Some(window) = app.get_webview_window(LIVE_ISLAND_WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
        let _ = window.set_ignore_cursor_events(true);
    }
    Ok(())
}

pub fn create_live_island_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LIVE_ISLAND_WINDOW_LABEL).is_some() {
        return Ok(());
    }

    let pos = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            // WebviewWindowBuilder::position accepts logical coordinates, while
            // Monitor::position/size are physical pixels. Convert explicitly or
            // a Retina display places the 460px island mostly off the right edge.
            let scale = monitor.scale_factor();
            let monitor_position = monitor.position().to_logical::<f64>(scale);
            let monitor_size = monitor.size().to_logical::<f64>(scale);
            let x = monitor_position.x + (monitor_size.width - LIVE_ISLAND_WIDTH) / 2.0;
            let physical_height = (LIVE_ISLAND_MIN_HEIGHT * scale).ceil() as u32;
            let y_offset =
                live_island_menu_bar_top_offset(&monitor, physical_height) as f64 / scale;
            (x, monitor_position.y + y_offset)
        })
        .unwrap_or((0.0, 0.0));

    // DeerHux serves its UI from a loopback Next.js server, so the island window
    // starts on the bundled placeholder and is navigated to `/live-island` once
    // the backend is ready (same lifecycle as the quick-session window).
    #[cfg(debug_assertions)]
    let url = WebviewUrl::External("http://localhost:30141/live-island".parse().unwrap());
    #[cfg(not(debug_assertions))]
    let url = WebviewUrl::App("index.html".into());

    let window = WebviewWindowBuilder::new(app, LIVE_ISLAND_WINDOW_LABEL, url)
        .title("DeerHux 灵动岛")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        // Start hidden at construction time so WebKit can finish loading the
        // background page. Building visible and immediately calling hide()
        // can cancel the first navigation before the SSE bridge subscribes.
        .visible(false)
        .accept_first_mouse(true)
        .focused(false)
        .focusable(false)
        .inner_size(LIVE_ISLAND_WIDTH, LIVE_ISLAND_MIN_HEIGHT)
        .position(pos.0, pos.1)
        .build()
        .map_err(|e| format!("创建灵动岛窗口失败: {e}"))?;

    // Pass clicks through until the global hover watcher detects the cursor over the island.
    let _ = window.set_ignore_cursor_events(true);
    #[cfg(target_os = "macos")]
    configure_live_island_window(&window);
    Ok(())
}

pub fn show_live_island(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LIVE_ISLAND_WINDOW_LABEL).is_none() {
        create_live_island_window(app)?;
    }
    if let Some(window) = app.get_webview_window(LIVE_ISLAND_WINDOW_LABEL) {
        #[cfg(target_os = "macos")]
        configure_live_island_window(&window);
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Snapshot publishing
// ---------------------------------------------------------------------------

fn publish_live_island_snapshot(app: &AppHandle, mut snapshot: LiveIslandSnapshot) {
    let visible_row_count = snapshot.rows.len();
    let scale = snapshot.scale.clone();
    let app_handle = app.clone();
    let task_app = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        enrich_snapshot_layout(&mut snapshot);
        // Broadcast to every window so the settings panel can mirror state, and
        // the island window renders the rows.
        let _ = task_app.emit(LIVE_ISLAND_SNAPSHOT_EVENT, &snapshot);
        if visible_row_count > 0
            && snapshot.enabled
            && LIVE_ISLAND_FRONTEND_READY.load(Ordering::Acquire)
        {
            let _ = sync_live_island_window(&task_app, visible_row_count, &scale);
            let _ = show_live_island(&task_app);
        } else {
            let _ = hide_live_island(&task_app);
        }
    });
}

/// Re-emit the current snapshot, e.g. after the user toggles the setting.
pub fn refresh_live_island(app: &AppHandle) -> Result<(), String> {
    let enabled = get_live_island_setting(app)?;
    let Some(state_arc) = live_island_rows_state() else {
        let layout = current_live_island_layout();
        let _ = app.emit(
            LIVE_ISLAND_SETTINGS_EVENT,
            serde_json::json!({ "enabled": enabled, "layout": layout }),
        );
        return Ok(());
    };

    let mut snapshot = {
        let mut state = state_arc
            .lock()
            .map_err(|_| "灵动岛状态锁定失败".to_string())?;
        state.cleanup_expired();
        state.snapshot()
    };
    snapshot.scale = get_live_island_scale(app).unwrap_or_default();
    snapshot.enabled = enabled;
    publish_live_island_snapshot(app, snapshot);
    Ok(())
}

/// Called by the island webview after React has installed all host listeners.
/// Replaying the retained snapshot closes both startup orderings: rows may
/// arrive before the page is ready, or the page may become ready first.
#[tauri::command]
pub fn mark_live_island_ready(app: AppHandle) -> Result<(), String> {
    LIVE_ISLAND_FRONTEND_READY.store(true, Ordering::Release);
    refresh_live_island(&app)
}

// ---------------------------------------------------------------------------
// Hover tracking
// ---------------------------------------------------------------------------

fn dispatch_live_island_hover(app: &AppHandle, hovered: bool) {
    let app_handle = app.clone();
    let task_app = app_handle.clone();
    let _ = app_handle.run_on_main_thread(move || {
        let _ = apply_live_island_hovered(&task_app, hovered);
    });
}

fn apply_live_island_hovered(app: &AppHandle, hovered: bool) -> Result<(), String> {
    let (row_count, scale, was_hovered) = {
        let mut state = live_island_window_state()
            .lock()
            .map_err(|_| "灵动岛状态锁定失败".to_string())?;
        let was_hovered = state.hovered;
        state.hovered = hovered;
        if !hovered {
            state.drawer_height = 0.0;
        }
        (state.row_count, state.scale.clone(), was_hovered)
    };

    if row_count > 0 {
        sync_live_island_window(app, row_count, &scale)?;
    }

    if was_hovered && !hovered {
        if let Some(window) = app.get_webview_window(LIVE_ISLAND_WINDOW_LABEL) {
            let _ = window.emit(
                LIVE_ISLAND_HOVER_EVENT,
                serde_json::json!({ "inside": false, "x": -1.0, "y": -1.0 }),
            );
        }
    }

    Ok(())
}

/// Polls the cursor against the island window so clicks can pass through the
/// transparent area while the pill itself stays interactive.
///
/// Runs on a dedicated OS thread: the poll interval is 16ms and the work is
/// pure window geometry, so keeping it off the async runtime avoids waking the
/// executor every frame while sessions are streaming.
pub fn start_live_island_hover_watcher(app: AppHandle) {
    let running = LIVE_ISLAND_HOVER_RUNNING
        .get_or_init(|| Arc::new(AtomicBool::new(true)))
        .clone();
    std::thread::spawn(move || {
        let mut last_inside: Option<bool> = None;
        let mut last_payload_key: Option<(bool, i32, i32)> = None;

        while running.load(Ordering::SeqCst) {
            let payload = app
                .get_webview_window(LIVE_ISLAND_WINDOW_LABEL)
                .and_then(|window| {
                    if !window.is_visible().unwrap_or(false) {
                        return None;
                    }
                    let cursor = app.cursor_position().ok()?;
                    let position = window.outer_position().ok()?;
                    let size = window.outer_size().ok()?;
                    let left = position.x as f64;
                    let top = position.y as f64;
                    let right = left + size.width as f64;
                    let bottom = top + size.height as f64;
                    let inside = cursor.x >= left
                        && cursor.x <= right
                        && cursor.y >= top
                        && cursor.y <= bottom;
                    Some((inside, cursor.x as i32, cursor.y as i32))
                })
                .unwrap_or((false, -1, -1));

            let (inside, x, y) = payload;
            if Some(inside) != last_inside {
                last_inside = Some(inside);
                dispatch_live_island_hover(&app, inside);
            }
            if Some((inside, x, y)) != last_payload_key {
                if let Some(window) = app.get_webview_window(LIVE_ISLAND_WINDOW_LABEL) {
                    let _ = window.emit(
                        LIVE_ISLAND_HOVER_EVENT,
                        serde_json::json!({ "inside": inside, "x": x, "y": y }),
                    );
                }
                last_payload_key = Some((inside, x, y));
            }

            std::thread::sleep(Duration::from_millis(LIVE_ISLAND_HOVER_POLL_MS));
        }
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Ingest a batch of rows from DeerHux's Node server.
///
/// The caller sends only the sessions it currently knows about; every event is
/// applied idempotently by session id, so concurrent sessions can interleave
/// freely and repeated batches converge to the same state.
#[tauri::command]
pub fn live_island_push_events(app: AppHandle, events: Vec<LiveIslandEvent>) -> Result<(), String> {
    let Some(state_arc) = live_island_rows_state() else {
        return Err("灵动岛未初始化".to_string());
    };

    let enabled = get_live_island_setting(&app).unwrap_or(true);
    let retract_delays = events
        .iter()
        .filter(|event| event.event_type == "done-retract")
        .map(|event| event.delay_ms.unwrap_or(5_000))
        .collect::<Vec<_>>();

    let mut snapshot = {
        let mut state = state_arc
            .lock()
            .map_err(|_| "灵动岛状态锁定失败".to_string())?;
        for event in events {
            state.apply_event(event);
        }
        state.cleanup_expired();
        state.snapshot()
    };
    snapshot.scale = get_live_island_scale(&app).unwrap_or_default();
    snapshot.enabled = enabled;

    // When the island is disabled we still keep row state so re-enabling is
    // instant, but never show or resize the window.
    if enabled {
        publish_live_island_snapshot(&app, snapshot);
    }
    // A retract deadline must wake the state machine even when no later agent
    // event arrives. Otherwise cleanup_expired() is never called and completed
    // rows remain visible indefinitely.
    for delay_ms in retract_delays {
        let refresh_app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
            let _ = refresh_live_island(&refresh_app);
        });
    }
    Ok(())
}

/// Drop rows for sessions that no longer exist on the Node side.
#[tauri::command]
pub fn live_island_clear(app: AppHandle) -> Result<(), String> {
    let Some(state_arc) = live_island_rows_state() else {
        return Ok(());
    };
    let mut snapshot = {
        let mut state = state_arc
            .lock()
            .map_err(|_| "灵动岛状态锁定失败".to_string())?;
        state.clear();
        state.snapshot()
    };
    snapshot.scale = get_live_island_scale(&app).unwrap_or_default();
    snapshot.enabled = get_live_island_setting(&app).unwrap_or(true);
    if snapshot.enabled {
        publish_live_island_snapshot(&app, snapshot);
    } else {
        let _ = hide_live_island(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn get_live_island_setting_command(app: AppHandle) -> Result<bool, String> {
    get_live_island_setting(&app)
}

#[tauri::command]
pub fn set_live_island_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    save_live_island_setting(&app, enabled)?;
    if !enabled {
        let _ = hide_live_island(&app);
        let _ = app.emit(
            LIVE_ISLAND_SETTINGS_EVENT,
            serde_json::json!({ "enabled": false, "layout": current_live_island_layout() }),
        );
        return Ok(());
    }
    refresh_live_island(&app)
}

#[tauri::command]
pub fn get_live_island_scale_command(app: AppHandle) -> Result<LiveIslandScale, String> {
    get_live_island_scale(&app)
}

#[tauri::command]
pub fn set_live_island_scale(app: AppHandle, scale: LiveIslandScale) -> Result<(), String> {
    save_live_island_scale(&app, &scale)?;
    refresh_live_island(&app)
}

/// Report the drawer's measured height so the window can grow to fit it.
#[tauri::command]
pub fn set_live_island_drawer_height(app: AppHandle, drawer_height: f64) -> Result<(), String> {
    let drawer_height = drawer_height.max(0.0);
    let (row_count, scale, should_sync) = {
        let mut state = live_island_window_state()
            .lock()
            .map_err(|_| "灵动岛状态锁定失败".to_string())?;
        let changed = (state.drawer_height - drawer_height).abs() >= 0.5;
        state.drawer_height = drawer_height;
        (
            state.row_count,
            state.scale.clone(),
            state.hovered && state.row_count > 0 && changed,
        )
    };

    if should_sync {
        sync_live_island_window(&app, row_count, &scale)?;
    }
    Ok(())
}

/// Hide a row until that session's next run starts.
#[tauri::command]
pub fn dismiss_live_island_row(app: AppHandle, row_id: String) -> Result<(), String> {
    let row_id = row_id.trim().to_string();
    if row_id.is_empty() {
        return Err("无效的会话 ID".to_string());
    }

    let Some(state_arc) = live_island_rows_state() else {
        return Err("灵动岛未初始化".to_string());
    };

    let mut snapshot = {
        let mut state = state_arc
            .lock()
            .map_err(|_| "灵动岛状态锁定失败".to_string())?;
        let dismissed_started = state
            .rows
            .get(&row_id)
            .map(|tracked| tracked.row.started_at)
            .unwrap_or_else(now_ms);
        state
            .dismissed_ids
            .insert(row_id.clone(), dismissed_started);
        if state.rows.remove(&row_id).is_none() {
            return Ok(());
        }
        state.version += 1;
        state.cleanup_expired();
        state.snapshot()
    };
    snapshot.scale = get_live_island_scale(&app).unwrap_or_default();
    snapshot.enabled = get_live_island_setting(&app).unwrap_or(true);
    publish_live_island_snapshot(&app, snapshot);
    Ok(())
}

/// Bring DeerHux's main window forward for a row (no cross-app activation).
#[tauri::command]
pub fn focus_live_island_row(app: AppHandle, _row_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

/// Called once during setup: seed state, then hide until a session runs.
pub fn init_live_island(app: &AppHandle) {
    LIVE_ISLAND_FRONTEND_READY.store(false, Ordering::Release);
    let state = Arc::new(Mutex::new(LiveIslandState {
        scale: get_live_island_scale(app).unwrap_or_default(),
        ..Default::default()
    }));
    let _ = LIVE_ISLAND_ROWS_STATE.set(Arc::clone(&state));
    let _ = create_live_island_window(app);
    let _ = hide_live_island(app);
    start_live_island_hover_watcher(app.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn island_width_stays_compact_around_the_physical_notch() {
        assert_eq!(LIVE_ISLAND_WIDTH, 460.0);
        assert!(LIVE_ISLAND_WIDTH > 248.0);
    }

    #[test]
    fn concurrent_sessions_are_paired_across_the_notch() {
        assert_eq!(compact_visible_row_count(0), 0);
        assert_eq!(compact_visible_row_count(1), 1);
        assert_eq!(compact_visible_row_count(2), 1);
        assert_eq!(compact_visible_row_count(3), 2);
        assert_eq!(compact_visible_row_count(4), 2);
    }
}
