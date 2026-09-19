use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};

const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 24;

struct TerminalProcess {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

impl Drop for TerminalProcess {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
pub struct TerminalState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<TerminalProcess>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

fn shell_command() -> CommandBuilder {
    #[cfg(target_os = "windows")]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string());

    #[cfg(not(target_os = "windows"))]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if Path::new("/bin/zsh").exists() {
            "/bin/zsh"
        } else {
            "/bin/sh"
        }
        .to_string()
    });

    let mut command = CommandBuilder::new(shell);
    command.env_remove("npm_config_prefix");
    command.env_remove("NPM_CONFIG_PREFIX");
    command.env_remove("PREFIX");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command
}

#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    if let Some(path) = cwd.as_deref() {
        if !Path::new(path).is_dir() {
            return Err("终端工作目录不存在".to_string());
        }
    }

    let pty = native_pty_system()
        .openpty(PtySize {
            rows: rows.unwrap_or(DEFAULT_ROWS).max(1),
            cols: cols.unwrap_or(DEFAULT_COLS).max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("创建终端失败: {error}"))?;

    let mut command = shell_command();
    if let Some(path) = cwd.as_deref() {
        command.cwd(path);
    }
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动 shell 失败: {error}"))?;
    drop(pty.slave);

    let writer = pty
        .master
        .take_writer()
        .map_err(|error| format!("连接终端输入失败: {error}"))?;
    let mut reader = pty
        .master
        .try_clone_reader()
        .map_err(|error| format!("连接终端输出失败: {error}"))?;
    let session_id = format!(
        "terminal-{}",
        state.next_id.fetch_add(1, Ordering::Relaxed) + 1
    );
    let process = Arc::new(TerminalProcess {
        writer: Mutex::new(writer),
        master: Mutex::new(pty.master),
        child: Mutex::new(child),
    });
    state
        .sessions
        .lock()
        .map_err(|_| "终端状态不可用".to_string())?
        .insert(session_id.clone(), process);

    let output_session_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: output_session_id.clone(),
                            data: STANDARD.encode(&buffer[..count]),
                        },
                    );
                }
            }
        }
        let _ = app.emit(
            "terminal-exit",
            TerminalExit {
                session_id: output_session_id,
            },
        );
    });

    Ok(session_id)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let process = state
        .sessions
        .lock()
        .map_err(|_| "终端状态不可用".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "终端会话已关闭".to_string())?;
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "终端输入格式无效".to_string())?;
    let mut writer = process
        .writer
        .lock()
        .map_err(|_| "终端输入不可用".to_string())?;
    writer
        .write_all(&bytes)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写入终端失败: {error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let process = state
        .sessions
        .lock()
        .map_err(|_| "终端状态不可用".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "终端会话已关闭".to_string())?;
    let result = process
        .master
        .lock()
        .map_err(|_| "终端尺寸不可用".to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("调整终端尺寸失败: {error}"));
    result
}

#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|_| "终端状态不可用".to_string())?
        .remove(&session_id);
    Ok(())
}
