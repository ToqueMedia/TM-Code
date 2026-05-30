use super::container::{clamp_to_project, ActiveProjectState};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
    #[serde(default)]
    pub timed_out: bool,
}

// Estado global para manter histórico de comandos
type CommandHistory = Mutex<Vec<String>>;
pub type ProcessMap = Mutex<HashMap<u32, std::process::Child>>;

// ─── PTY Session Management ──────────────────────────────────────────────────

/// Holds a live PTY session: the master PTY, a writer for sending input,
/// a reader thread for streaming output, and a handle to kill the child.
/// The session id lives only as the `PtySessionMap` key — no need to store
/// it on the value too.
pub struct PtySession {
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub writer: Box<dyn std::io::Write + Send>,
}

unsafe impl Send for PtySession {}
unsafe impl Sync for PtySession {}

pub type PtySessionMap = Mutex<HashMap<String, Arc<Mutex<PtySession>>>>;
/// Separate child-process map so the exit-detection thread can own the child
/// without holding the session mutex (which would block write/resize ops).
pub type PtyChildMap =
    Mutex<HashMap<String, Arc<Mutex<Option<Box<dyn portable_pty::Child + Send>>>>>>;

// Default terminal dimensions (used until first resize event from xterm.js)
const DEFAULT_PTY_COLS: u16 = 120;
const DEFAULT_PTY_ROWS: u16 = 30;

// ─── Shared execution engine ─────────────────────────────────────────────────

/// Build a host-local shell command.
/// Cached full PATH from the user's login shell.
/// Extracted once (lazily) via `$SHELL -l -c 'printf $PATH'` so that tools
/// installed via brew, nvm, volta, corepack are visible without the side
/// effects of a full login shell (motd, starship prompt, etc.)
///
/// Initialized eagerly at app startup via `init_user_path()` on a background
/// thread so it doesn't block the first command.
static USER_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Call once at app startup (from lib.rs setup) to pre-warm the PATH cache
/// on a background thread. Non-blocking.
pub fn init_user_path() {
    std::thread::spawn(|| {
        get_user_path();
    });
}

pub fn get_user_path() -> Option<&'static str> {
    USER_PATH
        .get_or_init(|| {
            // On Windows, the system PATH is already correct — no shell extraction needed.
            if cfg!(target_os = "windows") {
                eprintln!("[PATH] Windows detected — using inherited PATH");
                return None;
            }

            let user_shell = std::env::var("SHELL").unwrap_or_default();
            eprintln!("[PATH] Extracting user PATH... SHELL={:?}", user_shell);

            // fish has incompatible syntax ($PATH is a list, not colon-delimited).
            // Use zsh or bash as a POSIX fallback for PATH extraction.
            let shells: Vec<String> = if user_shell.ends_with("/fish") {
                vec!["/bin/zsh".into(), "/bin/bash".into()]
            } else if user_shell.is_empty() {
                vec!["/bin/zsh".into()]
            } else {
                vec![user_shell, "/bin/zsh".into()]
            };

            // Try interactive-login first (-i -l) to pick up .zshrc/.bashrc (nvm, volta, brew on M1),
            // then fall back to login-only (-l) which reads .zprofile/.bash_profile.
            let flag_sets: &[&[&str]] = &[&["-i", "-l", "-c"], &["-l", "-c"]];
            for flags in flag_sets {
                for shell in &shells {
                    // Run in a thread with channel-based timeout to avoid hangs
                    // from complex shell configs (oh-my-zsh, compinit, starship, etc.)
                    let shell_for_thread = shell.clone();
                    let flags_vec: Vec<String> = flags.iter().map(|s| s.to_string()).collect();
                    let flags_dbg = format!("{:?}", flags); // for logging
                    let shell_dbg = shell.clone();
                    let (tx, rx) = std::sync::mpsc::channel();

                    std::thread::spawn(move || {
                        let result = std::process::Command::new(&shell_for_thread)
                            .args(&flags_vec)
                            .arg("printf '%s' \"$PATH\"")
                            .stdout(Stdio::piped())
                            .stderr(Stdio::null())
                            .stdin(Stdio::null())
                            .output();
                        let _ = tx.send(result);
                    });

                    match rx.recv_timeout(Duration::from_secs(5)) {
                        Ok(Ok(output)) if output.status.success() => {
                            if let Ok(path) = String::from_utf8(output.stdout) {
                                if !path.is_empty() {
                                    eprintln!(
                                        "[PATH] Success via {} {} ({} chars)",
                                        shell_dbg,
                                        flags_dbg,
                                        path.len()
                                    );
                                    return Some(path);
                                }
                            }
                        }
                        Ok(Ok(output)) => {
                            eprintln!(
                                "[PATH] {} {} exited with {:?}",
                                shell_dbg,
                                flags_dbg,
                                output.status.code()
                            );
                        }
                        Ok(Err(e)) => {
                            eprintln!("[PATH] {} {} spawn error: {}", shell_dbg, flags_dbg, e);
                        }
                        Err(_) => {
                            eprintln!("[PATH] {} {} timed out (5s)", shell_dbg, flags_dbg);
                        }
                    }
                }
            }
            None
        })
        .as_deref()
}

/// Prevent a visible CMD/console window from flashing on Windows.
/// No-op on other platforms.
#[allow(unused_variables)]
fn hide_console_window(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Pick a real interactive shell for `start_interactive_shell`.
///
/// On Windows, prefer PowerShell 7 (`pwsh`) > Windows PowerShell (`powershell`) > `cmd`.
/// `cmd /C` is NOT interactive — it runs a command and exits — so we use `cmd` with no
/// flags or PowerShell with `-NoLogo -NoExit`.
///
/// On Unix, use the user's `$SHELL` (or `/bin/bash`) with `-i`.
fn pick_interactive_shell() -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        // Try pwsh (PowerShell 7+, cross-platform) first
        let mut pwsh_probe = Command::new("pwsh");
        pwsh_probe
            .arg("-Version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console_window(&mut pwsh_probe);
        if pwsh_probe.status().map(|s| s.success()).unwrap_or(false) {
            return (
                "pwsh".to_string(),
                vec!["-NoLogo".to_string(), "-NoExit".to_string()],
            );
        }
        // Fall back to Windows PowerShell (always available on Win 10/11)
        let mut ps_probe = Command::new("powershell");
        ps_probe
            .arg("-Command")
            .arg("$PSVersionTable.PSVersion")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console_window(&mut ps_probe);
        if ps_probe.status().map(|s| s.success()).unwrap_or(false) {
            return (
                "powershell".to_string(),
                vec!["-NoLogo".to_string(), "-NoExit".to_string()],
            );
        }
        // Last resort: cmd.exe with no /C flag (interactive)
        return ("cmd".to_string(), vec![]);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (shell, vec!["-i".to_string()])
    }
}

/// Build a command with sandbox if enabled, otherwise plain host command.
pub fn build_sandboxed_host_command(command: &str, project_path: &PathBuf) -> Command {
    if let Some(cmd) = super::sandbox::sandboxed_command(command, project_path, &[]) {
        eprintln!("[sandbox] Active: {}", &command[..command.len().min(60)]);
        cmd
    } else {
        build_host_command(command, project_path)
    }
}

fn build_host_command(command: &str, cwd: &PathBuf) -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg(command)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        hide_console_window(&mut cmd);
        return cmd;
    }

    // macOS/Linux: use plain sh -c (no login shell side effects) but with the
    // user's full PATH so tools from brew, nvm, volta, corepack are found.
    let mut cmd = Command::new("sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Inject user's full login-shell PATH so tools from brew, nvm, volta are found.
    // If extraction failed, fall back: prepend common tool dirs to the inherited PATH.
    if let Some(path) = get_user_path() {
        cmd.env("PATH", path);
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
        let inherited = std::env::var("PATH").unwrap_or_default();
        // Scan for nvm node binary — resolve the actual installed version
        let nvm_bin = std::fs::read_dir(format!("{}/.nvm/versions/node", home))
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .max_by_key(|e| e.file_name())
                    .map(|e| format!("{}/bin", e.path().display()))
            })
            .unwrap_or_default();

        let extra_dirs = [
            nvm_bin.as_str(),
            &format!("{}/.local/share/pnpm", home),
            &format!("{}/.bun/bin", home),
            &format!("{}/.cargo/bin", home),
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ];
        let prepend: String = extra_dirs
            .iter()
            .filter(|d| !d.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(":");

        cmd.env("PATH", format!("{}:{}", prepend, inherited));
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    cmd
}

/// Spawn a command, stream its output into buffers, and wait with a timeout.
/// Returns `CommandResult` on completion or timeout.
async fn run_command_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Result<CommandResult, String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let child_pid = child.id();

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));

    let stdout_handle = stdout_pipe.map(|pipe| {
        let buf = Arc::clone(&stdout_buf);
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(pipe);
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut b) = buf.lock() {
                            b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        }
                    }
                }
            }
        })
    });

    let stderr_handle = stderr_pipe.map(|pipe| {
        let buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(pipe);
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut b) = buf.lock() {
                            b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                        }
                    }
                }
            }
        })
    });

    let wait_result =
        tokio::time::timeout(timeout, tokio::task::spawn_blocking(move || child.wait())).await;

    match wait_result {
        Ok(Ok(Ok(status))) => {
            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }

            let stdout = stdout_buf.lock().map(|b| b.clone()).unwrap_or_default();
            let stderr = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();

            Ok(CommandResult {
                stdout,
                stderr,
                exit_code: status.code().unwrap_or(-1),
                success: status.success(),
                timed_out: false,
            })
        }
        Ok(Ok(Err(e))) => Err(format!("Failed to execute command: {}", e)),
        Ok(Err(e)) => Err(format!("Task error: {}", e)),
        Err(_) => {
            kill_process_tree(child_pid);

            if let Some(h) = stdout_handle {
                let _ = h.join();
            }
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }

            let stdout = stdout_buf.lock().map(|b| b.clone()).unwrap_or_default();
            let mut stderr = stderr_buf.lock().map(|b| b.clone()).unwrap_or_default();

            let secs = timeout.as_secs();
            stderr.push_str(&format!(
                "\n\n[Timed out after {}s. Use start_dev_server for long-running processes.]",
                secs
            ));

            Ok(CommandResult {
                stdout,
                stderr,
                exit_code: -1,
                success: false,
                timed_out: true,
            })
        }
    }
}

// ─── Process tree kill ───────────────────────────────────────────────────────

/// Kill a process and its entire tree by PID.
/// Sends SIGTERM first for graceful shutdown, then SIGKILL if still alive.
pub(crate) fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", pid)])
            .output();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();

        std::thread::sleep(Duration::from_millis(200));

        let still_alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if still_alive {
            let _ = Command::new("kill")
                .args(["-KILL", &format!("-{}", pid)])
                .output();
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .output();
        }
    }

    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/T", "/F", "/PID", &pid.to_string()]);
        hide_console_window(&mut tk);
        let _ = tk.output();
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Execute a one-shot command with project isolation.
///
/// Routing logic (transparent to all frontend callers):
///   1. Active project → host shell, cwd clamped to project directory
///   2. No active project → host shell, unrestricted
#[tauri::command]
pub async fn execute_command(
    command: String,
    cwd: Option<String>,
    timeout_secs: Option<u64>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<CommandResult, String> {
    if command.trim().is_empty() {
        return Err("Empty command".to_string());
    }

    let timeout = Duration::from_secs(timeout_secs.unwrap_or(300));
    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    if let Some(ref ap) = project {
        // App-level isolation: sandbox the command to the project directory
        let working_dir = match &cwd {
            Some(dir) => PathBuf::from(clamp_to_project(dir, &ap.project_path)),
            None => PathBuf::from(&ap.project_path),
        };
        let cmd = build_sandboxed_host_command(&command, &working_dir);
        return run_command_with_timeout(cmd, timeout).await;
    }

    // No active project: unrestricted host execution
    let working_dir = match cwd {
        Some(dir) => PathBuf::from(dir),
        None => {
            env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?
        }
    };
    let cmd = build_host_command(&command, &working_dir);
    run_command_with_timeout(cmd, timeout).await
}

#[derive(Clone, Serialize)]
struct DevServerOutput {
    pid: u32,
    stream: String,
    data: String,
}

/// Validate a byte slice as UTF-8, emit the valid portion, and handle errors:
/// - Incomplete sequence at the end → save to `leftover` for the next read
/// - Genuinely invalid bytes → replace with U+FFFD and continue
fn emit_utf8_validated(data: &[u8], leftover: &mut Vec<u8>, emit: &dyn Fn(&str)) {
    let mut pos = 0;
    while pos < data.len() {
        match std::str::from_utf8(&data[pos..]) {
            Ok(text) => {
                if !text.is_empty() {
                    emit(text);
                }
                leftover.clear();
                return;
            }
            Err(e) => {
                let valid_end = pos + e.valid_up_to();
                // Emit valid portion before the error
                if valid_end > pos {
                    // Safety: from_utf8 confirmed bytes [pos..valid_end] are valid
                    let text = unsafe { std::str::from_utf8_unchecked(&data[pos..valid_end]) };
                    emit(text);
                }
                match e.error_len() {
                    Some(invalid_len) => {
                        // Genuinely invalid sequence — replace with U+FFFD and skip
                        emit("\u{FFFD}");
                        pos = valid_end + invalid_len;
                    }
                    None => {
                        // Incomplete sequence at the end — save for next read
                        *leftover = data[valid_end..].to_vec();
                        return;
                    }
                }
            }
        }
    }
}

/// Read from a pipe in raw chunks, emit each chunk as a Tauri event.
/// Handles incomplete UTF-8 sequences at 4KB read boundaries by carrying
/// leftover bytes to the next read, so multi-byte characters are never split.
/// Genuinely invalid bytes are replaced with U+FFFD and emitted immediately.
fn stream_pipe_to_events(pipe: &mut dyn Read, pid: u32, stream_name: &str, app: &tauri::AppHandle) {
    let mut buf = [0u8; 4096];
    let mut leftover: Vec<u8> = Vec::new();

    let emit = |text: &str| {
        let _ = app.emit(
            "cmd-output",
            DevServerOutput {
                pid,
                stream: stream_name.into(),
                data: text.to_string(),
            },
        );
    };

    loop {
        match pipe.read(&mut buf) {
            Ok(0) => {
                // EOF — flush any remaining bytes (possibly invalid)
                if !leftover.is_empty() {
                    emit(&String::from_utf8_lossy(&leftover));
                }
                break;
            }
            Ok(n) => {
                if leftover.is_empty() {
                    // Fast path: no leftover — validate directly from stack buffer,
                    // zero allocation when UTF-8 is valid (the common case).
                    emit_utf8_validated(&buf[..n], &mut leftover, &emit);
                } else {
                    // Slow path: prepend leftover bytes
                    let mut combined = std::mem::take(&mut leftover);
                    combined.extend_from_slice(&buf[..n]);
                    emit_utf8_validated(&combined, &mut leftover, &emit);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => continue,
            Err(_) => break,
        }
    }
}

/// Execute a command with streamed output. Unlike `execute_command` which blocks
/// until the command finishes, this spawns the process and streams stdout/stderr
/// line by line via `cmd-output` events. Emits `cmd-exit` with exit code when done.
/// Used by the terminal for commands like `npm install` that produce progressive output.
#[tauri::command]
pub async fn run_streaming_command(
    app: tauri::AppHandle,
    command: String,
    cwd: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("Empty command".to_string());
    }

    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    let mut cmd = if let Some(ref ap) = project {
        let working_dir = PathBuf::from(clamp_to_project(&cwd, &ap.project_path));
        build_sandboxed_host_command(&command, &working_dir)
    } else {
        build_host_command(&command, &PathBuf::from(&cwd))
    };

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start command: {}", e))?;

    let pid = child.id();

    // Stream stdout — chunk-based to capture progress bars (\r without \n).
    // Reads raw from pipe (no BufReader) for minimal latency on small writes.
    // Handles incomplete UTF-8 sequences at chunk boundaries.
    if let Some(mut stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            stream_pipe_to_events(&mut stdout, pid, "stdout", &app_clone);
        });
    }

    // Stream stderr — same chunk-based approach.
    if let Some(mut stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            stream_pipe_to_events(&mut stderr, pid, "stderr", &app_clone);
        });
    }

    // Wait for process exit and emit exit code
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_clone.emit("cmd-exit", serde_json::json!({ "pid": pid, "code": code }));
    });

    Ok(pid)
}

/// Spawn a long-running dev server process and stream its output back to the
/// frontend via Tauri events (`dev-server-output` and `dev-server-exit`).
///
/// Routing:
///   - Active project → host shell, cwd clamped to project directory
///   - No active project → host shell, unrestricted
#[tauri::command(rename_all = "camelCase")]
pub async fn start_dev_server(
    app: tauri::AppHandle,
    command: String,
    cwd: String,
    port: Option<u16>,
    skip_port_env: Option<bool>,
    process_map: State<'_, ProcessMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("Empty command".to_string());
    }

    let server_port = port.unwrap_or(7773);
    let port_str = server_port.to_string();

    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    // Fullstack wrappers (concurrently, npm-run-all, turbo, pnpm -r, etc.)
    // inherit PORT and propagate to BOTH children — the backend grabs the
    // frontend's reserved port, forcing the frontend to auto-increment and
    // leaving the preview pointing at a stale port. For those wrappers we
    // skip PORT entirely and let each sub-script pick from the dedicated
    // TM_FRONTEND_PORT / TM_BACKEND_PORT variables instead.
    //
    // The TypeScript caller may pass `skipPortEnv` to override this heuristic
    // — TS can inspect package.json and catch wrappers that are hidden behind
    // one level of `npm run <script>` indirection. Our string check here is
    // the fallback for when the TS-side detection couldn't run.
    let is_fullstack_wrapper = skip_port_env.unwrap_or_else(|| {
        let cmd_lower = command.to_lowercase();
        cmd_lower.contains("concurrently")
            || cmd_lower.contains("npm-run-all")
            || cmd_lower.contains("run-p ")
            || cmd_lower.contains("turbo run")
            || cmd_lower.contains("turbo dev")
            || (cmd_lower.contains("pnpm") && cmd_lower.contains(" -r"))
            || cmd_lower.contains("nx run-many")
    });

    let mut cmd = if let Some(ref ap) = project {
        // App-level isolation: sandbox the dev server command
        let clamped = clamp_to_project(&cwd, &ap.project_path);
        let mut c = build_sandboxed_host_command(&command, &PathBuf::from(&clamped));
        c.env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1")
            .env("BROWSER", "none")
            .env("HOST", "0.0.0.0")
            .env("HOSTNAME", "0.0.0.0")
            .env("TM_FRONTEND_PORT", "7773")
            .env("TM_BACKEND_PORT", "7777");
        if !is_fullstack_wrapper {
            c.env("PORT", &port_str);
        }
        c
    } else {
        // No active project
        let (shell, flag) = if cfg!(target_os = "windows") {
            ("cmd", "/C")
        } else {
            ("sh", "-c")
        };

        let mut c = Command::new(shell);
        c.arg(flag)
            .arg(&command)
            .current_dir(&cwd)
            .env("FORCE_COLOR", "0")
            .env("NO_COLOR", "1")
            .env("BROWSER", "none")
            .env("HOST", "0.0.0.0")
            .env("HOSTNAME", "0.0.0.0")
            .env("TM_FRONTEND_PORT", "7773")
            .env("TM_BACKEND_PORT", "7777")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if !is_fullstack_wrapper {
            c.env("PORT", &port_str);
        }

        if let Some(path) = get_user_path() {
            c.env("PATH", path);
        }

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            c.process_group(0);
        }

        c
    };

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start dev server: {}", e))?;

    let pid = child.id();

    // ─── Batched output streaming ────────────────────────────────────────
    // Reader threads funnel lines to a single flusher thread via an mpsc
    // channel. The flusher coalesces lines into batches (flush every 100ms
    // OR when 50+ lines accumulate) and emits a single `dev-server-output`
    // event per batch. This dramatically reduces IPC pressure on Windows
    // WebView2, which otherwise saturates the JS event loop and starves
    // setTimeout callbacks (breaking text-delta buffered flushes in the
    // agent stream). Lines are joined with `\n`; the frontend splits back.
    let (tx, rx) = std::sync::mpsc::channel::<(&'static str, String)>();

    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        if tx.send(("stdout", line)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::InvalidData {
                            continue;
                        }
                        break;
                    }
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        if tx.send(("stderr", line)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::InvalidData {
                            continue;
                        }
                        break;
                    }
                }
            }
        });
    }
    // Drop the original sender so the flusher exits when both readers finish.
    drop(tx);

    // Flusher thread: debounce + batch lines → single IPC event per stream.
    {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::sync::mpsc::RecvTimeoutError;
            const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
            const MAX_BUF_LINES: usize = 50;

            let mut stdout_buf: Vec<String> = Vec::new();
            let mut stderr_buf: Vec<String> = Vec::new();
            let mut last_flush = std::time::Instant::now();

            let flush = |app: &tauri::AppHandle,
                         stdout_buf: &mut Vec<String>,
                         stderr_buf: &mut Vec<String>| {
                if !stdout_buf.is_empty() {
                    let _ = app.emit(
                        "dev-server-output",
                        DevServerOutput {
                            pid,
                            stream: "stdout".into(),
                            data: std::mem::take(stdout_buf).join("\n"),
                        },
                    );
                }
                if !stderr_buf.is_empty() {
                    let _ = app.emit(
                        "dev-server-output",
                        DevServerOutput {
                            pid,
                            stream: "stderr".into(),
                            data: std::mem::take(stderr_buf).join("\n"),
                        },
                    );
                }
            };

            loop {
                let elapsed = last_flush.elapsed();
                let timeout = FLUSH_INTERVAL.saturating_sub(elapsed);

                match rx.recv_timeout(timeout) {
                    Ok((stream, line)) => {
                        if stream == "stdout" {
                            stdout_buf.push(line);
                        } else {
                            stderr_buf.push(line);
                        }

                        // Force flush if buffer is getting large (backpressure)
                        if stdout_buf.len() + stderr_buf.len() >= MAX_BUF_LINES {
                            flush(&app_clone, &mut stdout_buf, &mut stderr_buf);
                            last_flush = std::time::Instant::now();
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        flush(&app_clone, &mut stdout_buf, &mut stderr_buf);
                        last_flush = std::time::Instant::now();
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        // Both readers done — flush remaining and exit.
                        flush(&app_clone, &mut stdout_buf, &mut stderr_buf);
                        break;
                    }
                }
            }
        });
    }

    // Wait for process exit in a dedicated thread — only source of dev-server-exit event
    {
        // Take ownership of child for the wait thread
        let app_clone = app.clone();
        let mut map = process_map
            .lock()
            .map_err(|_| "Failed to lock process map")?;
        // We need to store the child in the map for kill_process, but also wait on it.
        // Store a placeholder and spawn the wait thread with the actual child.
        // Actually, we insert the child into the process map and wait on PID via kill -0 polling.
        map.insert(pid, child);

        // Spawn a thread that polls whether the process is still alive.
        // Windows tasklist is slow (~100–200ms per spawn) and creates
        // process-spawn churn that shows up as UI stutter on WebView2.
        // Use a longer interval there; exit detection can tolerate ~2s latency.
        let poll_interval = if cfg!(unix) {
            std::time::Duration::from_millis(500)
        } else {
            std::time::Duration::from_millis(2000)
        };
        std::thread::spawn(move || {
            loop {
                let alive = if cfg!(unix) {
                    Command::new("kill")
                        .args(["-0", &pid.to_string()])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                } else {
                    // Windows: check via tasklist
                    let mut tc = Command::new("tasklist");
                    tc.args(["/FI", &format!("PID eq {}", pid), "/NH"])
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null());
                    hide_console_window(&mut tc);
                    tc.output()
                        .map(|o| {
                            let out = String::from_utf8_lossy(&o.stdout);
                            out.contains(&pid.to_string())
                        })
                        .unwrap_or(false)
                };

                if !alive {
                    let _ = app_clone.emit("dev-server-exit", pid);
                    break;
                }
                std::thread::sleep(poll_interval);
            }
        });
    }

    Ok(pid)
}

/// PTY-based interactive shell — returns a session ID instead of a PID.
/// The shell runs inside a real pseudo-terminal so it knows its dimensions
/// and can format output correctly (tables, progress bars, etc.).
#[tauri::command]
pub async fn start_pty_shell(
    session_id: String,
    cwd: Option<String>,
    pty_map: State<'_, PtySessionMap>,
    child_map: State<'_, PtyChildMap>,
    active_project: State<'_, ActiveProjectState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Idempotency guard: if the session already exists (e.g. React StrictMode
    // double-effect), return Ok without creating a duplicate PTY. This prevents
    // orphaned PTYs and Tauri callback ID errors from concurrent invocations.
    {
        let map = pty_map.lock().map_err(|_| "Failed to lock PTY map")?;
        if map.contains_key(&session_id) {
            return Ok(session_id);
        }
    }

    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    let pty_system = native_pty_system();

    let (shell_cmd, shell_args, working_dir) = if let Some(ref ap) = project {
        // App-level isolation: clamp cwd to project directory
        let working_dir = match &cwd {
            Some(dir) => PathBuf::from(clamp_to_project(dir, &ap.project_path)),
            None => PathBuf::from(&ap.project_path),
        };

        let (shell_cmd, shell_args) = pick_interactive_shell();
        (
            shell_cmd,
            shell_args,
            working_dir.to_string_lossy().to_string(),
        )
    } else {
        // No active project: unrestricted
        let working_dir = match cwd {
            Some(dir) => dir,
            None => env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .map_err(|e| format!("Failed to get current directory: {}", e))?,
        };

        let (shell_cmd, shell_args) = pick_interactive_shell();
        (shell_cmd, shell_args, working_dir)
    };

    // Build command for portable-pty
    let mut cmd = CommandBuilder::new(&shell_cmd);
    cmd.args(&shell_args);
    cmd.cwd(&working_dir);

    // Inherit environment
    for (k, v) in env::vars() {
        cmd.env(k, v);
    }

    // Create PTY with default dimensions
    let pair = pty_system
        .openpty(PtySize {
            rows: DEFAULT_PTY_ROWS,
            cols: DEFAULT_PTY_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to create PTY: {}", e))?;

    // Spawn the shell inside the PTY (on the slave side)
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell in PTY: {}", e))?;

    // Get reader from master for output streaming
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

    // Get writer from master for sending input
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let master = pair.master;

    // Shared flag to prevent duplicate pty-exit events.
    // On Unix the reader thread wins (EOF arrives first); on Windows the
    // child-wait thread wins (ConPTY never delivers EOF).
    let exit_signaled = Arc::new(AtomicBool::new(false));

    // Spawn reader thread: pump PTY output -> Tauri events
    let sid = session_id.clone();
    let app_clone = app.clone();
    let exit_flag_reader = Arc::clone(&exit_signaled);
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(
                        "pty-output",
                        PtyOutputEvent {
                            session_id: sid.clone(),
                            data: text,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        // Only emit if the child-wait thread hasn't already
        if exit_flag_reader
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let _ = app_clone.emit(
                "pty-exit",
                PtyExitEvent {
                    session_id: sid,
                    exit_code: 0,
                },
            );
        }
    });

    let session = PtySession { master, writer };

    let session_arc = Arc::new(Mutex::new(session));
    pty_map
        .lock()
        .map_err(|_| "Failed to lock PTY map")?
        .insert(session_id.clone(), Arc::clone(&session_arc));

    // Store child separately so the exit-detection thread can own it without
    // holding the session mutex (which would block write/resize ops).
    let child_arc: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send>>>> =
        Arc::new(Mutex::new(Some(child)));
    child_map
        .lock()
        .map_err(|_| "Failed to lock child map")?
        .insert(session_id.clone(), Arc::clone(&child_arc));

    // Spawn child-wait thread: monitors process exit independently of PTY EOF.
    // Critical on Windows where ConPTY never closes the master read pipe.
    // Takes ownership of the child via Option::take() — no session lock needed.
    let sid_wait = session_id.clone();
    let app_wait = app.clone();
    let exit_flag_wait = Arc::clone(&exit_signaled);
    std::thread::spawn(move || {
        let code = {
            let child_opt = child_arc.lock().ok().and_then(|mut guard| guard.take());
            match child_opt {
                Some(mut c) => c.wait().ok().map(|s| s.exit_code() as i32).unwrap_or(-1),
                None => return, // child already taken (kill_pty_session ran first)
            }
        };
        if exit_flag_wait
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            let _ = app_wait.emit(
                "pty-exit",
                PtyExitEvent {
                    session_id: sid_wait,
                    exit_code: code,
                },
            );
        }
    });

    Ok(session_id)
}

/// Write input data to a PTY session.
#[tauri::command]
pub async fn write_to_pty(
    session_id: String,
    data: String,
    pty_map: State<'_, PtySessionMap>,
) -> Result<(), String> {
    let map = pty_map.lock().map_err(|_| "Failed to lock PTY map")?;
    let session = map
        .get(&session_id)
        .ok_or_else(|| "PTY session not found".to_string())?;
    let mut s = session.lock().map_err(|_| "Failed to lock session")?;

    let writer: &mut dyn std::io::Write = &mut *s.writer;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

/// Resize a PTY session (called when xterm.js container is resized).
#[tauri::command]
pub async fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    pty_map: State<'_, PtySessionMap>,
) -> Result<(), String> {
    let map = pty_map.lock().map_err(|_| "Failed to lock PTY map")?;
    let session = map
        .get(&session_id)
        .ok_or_else(|| "PTY session not found".to_string())?;
    let s = session.lock().map_err(|_| "Failed to lock session")?;

    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

/// Kill a PTY session.
#[tauri::command]
pub async fn kill_pty_session(
    session_id: String,
    pty_map: State<'_, PtySessionMap>,
    child_map: State<'_, PtyChildMap>,
) -> Result<(), String> {
    // Remove and kill the child process (if still owned by the map).
    if let Some(child_arc) = child_map
        .lock()
        .map_err(|_| "Failed to lock child map")?
        .remove(&session_id)
    {
        if let Ok(mut guard) = child_arc.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
    // Remove the session (master + writer). Dropping master closes the PTY fd.
    pty_map
        .lock()
        .map_err(|_| "Failed to lock PTY map")?
        .remove(&session_id);
    Ok(())
}

/// Event payload for PTY output streaming.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyOutputEvent {
    pub session_id: String,
    pub data: String,
}

/// Event payload for PTY exit.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PtyExitEvent {
    pub session_id: String,
    pub exit_code: i32,
}

/// Check if a URL is reachable (TCP connection accepted + HTTP response).
/// Used to poll dev server readiness from the Rust side, bypassing WebView restrictions.
#[tauri::command]
pub async fn check_server_health(url: String) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    // Any HTTP response (even 404/405) means the server is accepting connections
    match client.get(&url).send().await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Result of a server probe: reachable + content-type header.
/// Used to classify detected URLs as frontend (HTML) vs backend (JSON/other)
/// for fullstack projects that expose multiple URLs.
#[derive(Debug, Serialize, Deserialize)]
pub struct ServerProbeResult {
    /// TCP-reachable AND HTTP responded (any status). Used by the probe loop
    /// to decide "the server is up enough to classify". A 4xx/5xx still
    /// satisfies this — the response was received.
    pub ok: bool,
    /// HTTP status code from the final response (0 when ok=false).
    pub status: u16,
    /// Whether this response can legitimately be classified as a real
    /// frontend page. True only when status is 2xx AND content-type is HTML.
    /// HTML error pages (Express's "Cannot GET /") are reachable but NOT
    /// usable — the dev-server classifier uses this flag to avoid promoting
    /// them to `frontendUrl` and stealing the slot from the real frontend.
    pub usable_as_frontend: bool,
    /// Raw Content-Type header (may be null if not present).
    pub content_type: Option<String>,
    /// Best-effort classification derived from content-type AND status:
    ///   "html" | "json" | "other" | null (when ok=false).
    /// An HTML response with status >= 400 is downgraded to "other" so the
    /// classifier routes it to the backend slot (where errors belong).
    pub kind: Option<String>,
}

/// Probe a URL — TCP reachability + Content-Type inspection.
/// Follows up to 3 redirects so we classify by the FINAL destination's
/// content-type (a backend that 302s from "/" to "/api/v1/health" should
/// classify as JSON, not by the empty 302 body).
#[tauri::command]
pub async fn probe_server(url: String) -> Result<ServerProbeResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;

    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let content_type = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let is_html = content_type
                .as_deref()
                .map(|ct| {
                    let lower = ct.to_lowercase();
                    lower.starts_with("text/html") || lower.starts_with("application/xhtml")
                })
                .unwrap_or(false);
            let is_json = content_type
                .as_deref()
                .map(|ct| ct.to_lowercase().contains("json"))
                .unwrap_or(false);
            let is_2xx = (200..300).contains(&status);

            let kind = if is_html && !is_2xx {
                // 4xx/5xx HTML is an error page (Express's "Cannot GET /",
                // Vite's "Internal Server Error" overlay during boot, etc.).
                // Real frontends serve 2xx HTML for `/`.
                Some("other".to_string())
            } else if is_html {
                Some("html".to_string())
            } else if is_json {
                Some("json".to_string())
            } else if content_type.is_some() {
                Some("other".to_string())
            } else {
                None
            };

            Ok(ServerProbeResult {
                ok: true,
                status,
                usable_as_frontend: is_html && is_2xx,
                content_type,
                kind,
            })
        }
        Err(_) => Ok(ServerProbeResult {
            ok: false,
            status: 0,
            usable_as_frontend: false,
            content_type: None,
            kind: None,
        }),
    }
}

/// Collect PIDs owning `port` on Windows, in ANY connection state
/// (LISTENING, ESTABLISHED, TIME_WAIT owners, etc.). `findstr :<port>`
/// alone matches `:77730` when looking for `:7773`, so we parse the
/// columns and compare the port number exactly.
#[cfg(windows)]
fn windows_pids_on_port(port: u16) -> Vec<u32> {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "netstat", "-aon"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console_window(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut pids: Vec<u32> = Vec::new();

    for line in text.lines() {
        // netstat columns (Windows): Proto  Local  Foreign  State  PID
        // (UDP rows have no State column, PID in column 4).
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }
        let proto = cols[0];
        if proto != "TCP" && proto != "UDP" {
            continue;
        }
        let local = cols[1];
        // Exact port match — reject `:77730` when looking for `:7773`.
        // Local column looks like `0.0.0.0:7773` or `[::1]:7773`.
        let local_port = local.rsplit_once(':').map(|(_, p)| p).unwrap_or("");
        if local_port != port.to_string() {
            continue;
        }
        let pid_str = cols.last().copied().unwrap_or("");
        if let Ok(pid) = pid_str.parse::<u32>() {
            if pid != 0 && !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    pids
}

/// Check if a port is currently held by some process. Platform-specific.
/// This is the light-weight predicate used by kill_port to avoid spawning
/// netstat/lsof 30 times in a polling loop when the port is already free.
fn port_is_occupied(port: u16) -> bool {
    #[cfg(unix)]
    {
        let check = format!("lsof -ti:{}", port);
        Command::new("sh")
            .args(["-c", &check])
            .output()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        !windows_pids_on_port(port).is_empty()
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// Kill any process listening on the given port.
/// Used to free the dev server port before starting a new server.
///
/// Fast path: if the port is already free, return immediately (no subprocess
/// spawn). Previously the polling loop called `netstat -aon` up to 30 times
/// per port — on Windows each spawn is 100-500ms, so a fullstack start could
/// block up to 30 seconds of perceived UI freeze even when nothing needed
/// killing. Now we check once, skip if free, and back off aggressively if
/// the port stays occupied after kill.
#[tauri::command]
pub async fn kill_port(port: u16) -> Result<bool, String> {
    // Fast path: nothing to kill.
    if !port_is_occupied(port) {
        return Ok(true);
    }

    let kill_once = || {
        if cfg!(unix) {
            let cmd = format!("lsof -ti:{} | xargs kill -9 2>/dev/null", port);
            let _ = Command::new("sh").args(["-c", &cmd]).output();
        }
        #[cfg(windows)]
        {
            for pid in windows_pids_on_port(port) {
                // /T kills the entire tree — orphan children (tsc-watch, etc.)
                // that inherited the socket handle are also terminated.
                let mut tk = Command::new("taskkill");
                tk.args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                hide_console_window(&mut tk);
                let _ = tk.output();
            }
        }
    };

    kill_once();

    // Wait for the OS to release the socket. Exponential backoff — first
    // check sooner (the kernel usually releases within ~100ms), then widen
    // so we don't spam netstat if something really is stuck.
    let delays_ms = [100u64, 150, 200, 300, 500, 800, 1000];
    for &delay in &delays_ms {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        if !port_is_occupied(port) {
            return Ok(true);
        }
    }

    // Port still occupied after ~3s — one more aggressive kill pass.
    kill_once();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Report whether we actually freed it.
    let free = if cfg!(unix) {
        let check = format!("lsof -ti:{}", port);
        Command::new("sh")
            .args(["-c", &check])
            .output()
            .map(|o| o.stdout.is_empty())
            .unwrap_or(true)
    } else {
        #[cfg(windows)]
        {
            windows_pids_on_port(port).is_empty()
        }
        #[cfg(not(windows))]
        {
            true
        }
    };
    Ok(free)
}

#[tauri::command]
pub async fn kill_process(pid: u32, process_map: State<'_, ProcessMap>) -> Result<bool, String> {
    {
        let map = process_map
            .lock()
            .map_err(|_| "Failed to lock process map")?;
        if !map.contains_key(&pid) {
            return Err(format!(
                "Cannot kill PID {}: not a process managed by this application",
                pid
            ));
        }
    }

    if cfg!(unix) {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", pid)])
            .output();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let still_alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if still_alive {
            let _ = Command::new("kill")
                .args(["-KILL", &format!("-{}", pid)])
                .output();
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .output();
        }

        // NOTE: port-based kill (lsof -ti:7773 | kill) is intentionally avoided
        // as it can terminate unrelated processes bound to the same port.
    } else {
        let mut tk = Command::new("taskkill");
        tk.args(["/T", "/F", "/PID", &pid.to_string()]);
        hide_console_window(&mut tk);
        let _ = tk.output();
    }

    {
        let mut map = process_map
            .lock()
            .map_err(|_| "Failed to lock process map")?;
        map.remove(&pid);
    }

    Ok(true)
}

#[tauri::command]
pub async fn get_current_directory() -> Result<String, String> {
    let cwd = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
    Ok(cwd.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home directory")?;
    Ok(home_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn change_directory(
    path: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<String, String> {
    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    let effective_path = if let Some(ref ap) = project {
        clamp_to_project(&path, &ap.project_path)
    } else {
        path
    };

    let new_path = PathBuf::from(&effective_path);

    if !new_path.exists() {
        return Err(format!("Directory does not exist: {}", new_path.display()));
    }

    if !new_path.is_dir() {
        return Err(format!("Path is not a directory: {}", new_path.display()));
    }

    let canonical = super::canonicalize_path(&new_path)
        .map_err(|e| format!("Failed to resolve directory: {}", e))?;

    // After canonicalization, re-check that we're still inside the project
    if let Some(ref ap) = project {
        let clamped = clamp_to_project(&canonical.to_string_lossy(), &ap.project_path);
        return Ok(clamped);
    }

    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn command_exists(
    command: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<bool, String> {
    let _project = active_project.lock().map_err(|_| "Lock error")?.clone();

    // Must use the user's full PATH (from login shell) so tools installed
    // via brew, corepack, npm -g, volta, nvm are found.
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("where");
        cmd.arg(&command);
        hide_console_window(&mut cmd);
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to check command existence: {}", e))?;
        Ok(output.status.success())
    } else {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", &format!("which {}", command)]);
        if let Some(path) = get_user_path() {
            cmd.env("PATH", path);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to check command existence: {}", e))?;
        Ok(output.status.success())
    }
}

#[tauri::command]
pub async fn get_environment_variables(
    active_project: State<'_, ActiveProjectState>,
) -> Result<HashMap<String, String>, String> {
    let sensitive_patterns = [
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "PASSWD",
        "KEY",
        "CREDENTIAL",
        "AUTH",
        "PRIVATE",
        "API_KEY",
        "APIKEY",
        "ACCESS_KEY",
        "AWS_SECRET",
        "AWS_SESSION",
        "DATABASE_URL",
        "DB_PASS",
        "ENCRYPTION",
        "SIGNING",
    ];

    let _project = active_project.lock().map_err(|_| "Lock error")?.clone();

    // Host env
    let mut env_vars = HashMap::new();

    for (key, value) in env::vars() {
        let upper = key.to_uppercase();
        let is_sensitive = sensitive_patterns.iter().any(|pat| upper.contains(pat));
        if !is_sensitive {
            env_vars.insert(key, value);
        }
    }

    Ok(env_vars)
}

#[tauri::command]
pub async fn get_completions(
    partial: String,
    cwd: Option<String>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<Vec<String>, String> {
    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    // Resolve working directory
    let working_dir = match (&cwd, &project) {
        (Some(dir), Some(ap)) => PathBuf::from(clamp_to_project(dir, &ap.project_path)),
        (Some(dir), None) => PathBuf::from(dir),
        (None, Some(ap)) => PathBuf::from(&ap.project_path),
        (None, None) => env::current_dir().map_err(|e| format!("Failed to get cwd: {}", e))?,
    };

    // Host mode: resolve path-aware completion
    // The partial may be a bare name ("src") or a path ("src/comp")
    let partial_path = PathBuf::from(&partial);
    let has_path_sep = partial.contains('/') || partial.contains('\\');
    let (search_dir, prefix) = if has_path_sep {
        // Path completion: "src/comp" → search in "src/", filter by "comp"
        let parent = partial_path.parent().unwrap_or(std::path::Path::new(""));
        let file_prefix = partial_path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("");

        let resolved = if parent.is_absolute() {
            parent.to_path_buf()
        } else {
            working_dir.join(parent)
        };
        (resolved, file_prefix.to_string())
    } else {
        // Bare name: search in cwd
        (working_dir.clone(), partial.clone())
    };

    let mut completions = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&search_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                // Skip hidden files unless the user is explicitly typing a dot
                if name.starts_with('.') && !prefix.starts_with('.') {
                    continue;
                }
                if name.starts_with(&prefix) {
                    // Add trailing / for directories
                    let sep = if cfg!(target_os = "windows") {
                        "\\"
                    } else {
                        "/"
                    };
                    let display = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        if has_path_sep {
                            // Reconstruct relative path: "src/" + "components/"
                            let parent_str =
                                partial_path.parent().and_then(|p| p.to_str()).unwrap_or("");
                            format!("{}{}{}{}", parent_str, sep, name, sep)
                        } else {
                            format!("{}{}", name, sep)
                        }
                    } else if has_path_sep {
                        let parent_str =
                            partial_path.parent().and_then(|p| p.to_str()).unwrap_or("");
                        format!("{}{}{}", parent_str, sep, name)
                    } else {
                        name.to_string()
                    };
                    completions.push(display);
                }
            }
        }
    }

    // If no file matches and partial looks like a command (first word), try command completion
    if completions.is_empty() && !partial.contains('/') && !partial.contains('\\') {
        // Shell-escape partial to prevent command injection
        let safe_partial = partial.replace('\'', "'\\''");
        if let Ok(output) = Command::new("bash")
            .args([
                "-c",
                &format!("compgen -c -- '{}' 2>/dev/null | head -20", safe_partial),
            ])
            .output()
        {
            if output.status.success() {
                completions = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|s| s.to_string())
                    .collect();
            }
        }
    }

    completions.truncate(20);
    completions.sort();
    completions.dedup();

    Ok(completions)
}

#[tauri::command]
pub async fn get_command_history(
    history_state: State<'_, CommandHistory>,
) -> Result<Vec<String>, String> {
    let history = history_state.lock().map_err(|_| "Failed to lock history")?;
    Ok(history.clone())
}

#[tauri::command]
pub async fn save_command_to_history(
    command: String,
    history_state: State<'_, CommandHistory>,
) -> Result<(), String> {
    let mut history = history_state.lock().map_err(|_| "Failed to lock history")?;

    if let Some(last) = history.last() {
        if last == &command {
            return Ok(());
        }
    }

    history.push(command);

    const MAX_HISTORY: usize = 1000;
    if history.len() > MAX_HISTORY {
        let len = history.len();
        history.drain(0..len - MAX_HISTORY);
    }

    Ok(())
}

#[tauri::command]
pub async fn clear_command_history(history_state: State<'_, CommandHistory>) -> Result<(), String> {
    let mut history = history_state.lock().map_err(|_| "Failed to lock history")?;
    history.clear();
    Ok(())
}

// Função para inicializar o estado do terminal
pub fn init_terminal_state() -> (CommandHistory, ProcessMap) {
    (Mutex::new(Vec::new()), Mutex::new(HashMap::new()))
}
