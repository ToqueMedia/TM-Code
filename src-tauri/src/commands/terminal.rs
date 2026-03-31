use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};
use super::container::{docker_cmd, recover_colima};

use super::container::{clamp_to_project, host_to_container_path, ActiveProjectState, WORKSPACE_PATH};

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

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
}

// Estado global para manter histórico de comandos
type CommandHistory = Mutex<Vec<String>>;
pub type ProcessMap = Mutex<HashMap<u32, std::process::Child>>;

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
    std::thread::spawn(|| { get_user_path(); });
}

pub fn get_user_path() -> Option<&'static str> {
    USER_PATH.get_or_init(|| {
        let user_shell = std::env::var("SHELL").unwrap_or_default();

        // fish has incompatible syntax ($PATH is a list, not colon-delimited).
        // Use zsh or bash as a POSIX fallback for PATH extraction.
        let shells: Vec<String> = if user_shell.ends_with("/fish") {
            vec!["/bin/zsh".into(), "/bin/bash".into()]
        } else if user_shell.is_empty() {
            vec!["/bin/zsh".into()]
        } else {
            vec![user_shell, "/bin/zsh".into()]
        };

        for shell in &shells {
            if let Ok(output) = std::process::Command::new(shell)
                .args(["-l", "-c", "printf '%s' \"$PATH\""])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
            {
                if output.status.success() {
                    if let Ok(path) = String::from_utf8(output.stdout) {
                        if !path.is_empty() {
                            return Some(path);
                        }
                    }
                }
            }
        }
        None
    }).as_deref()
}

fn build_host_command(command: &str, cwd: &PathBuf) -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .arg(command)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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

    if let Some(path) = get_user_path() {
        cmd.env("PATH", path);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    cmd
}

/// Ensure a Docker container is running. If Docker is unreachable
/// (Colima stale after sleep/wake), triggers automatic recovery.
fn ensure_container_running(container_name: &str) {
    let inspect = docker_cmd()
        .args(["inspect", "-f", "{{.State.Running}}", container_name])
        .output();

    match inspect {
        Ok(out) if out.status.success() => {
            let running = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if running != "true" {
                let _ = docker_cmd().args(["start", container_name]).output();
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
        _ => {
            // Docker unreachable — try Colima recovery
            if recover_colima() {
                // Docker recovered — try to start the container
                let _ = docker_cmd().args(["start", container_name]).output();
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
    }
}

/// Build a `docker exec` command that runs inside a container.
fn build_container_command(command: &str, workdir: &str, container_name: &str) -> Command {
    let mut cmd = docker_cmd();
    let home_env = format!("HOME={}", workdir);
    cmd.args(["exec", "-e", &home_env, "-w", workdir, container_name, "sh", "-c", command])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Execute a one-shot command with project isolation.
///
/// Routing logic (transparent to all frontend callers):
///   1. Docker container active → `docker exec` inside container
///   2. App-level isolation (no Docker) → host shell, cwd clamped to project
///   3. No active project → host shell, unrestricted (shouldn't happen)
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
        if let Some(ref container_name) = ap.container_name {
            // ── Docker mode: ensure container is running, then route through it
            ensure_container_running(container_name);
            let workdir = match &cwd {
                Some(dir) => host_to_container_path(dir, &ap.project_path),
                None => WORKSPACE_PATH.to_string(),
            };
            let cmd = build_container_command(&command, &workdir, container_name);
            return run_command_with_timeout(cmd, timeout).await;
        }

        // ── App-level isolation: clamp cwd to project ────────────────
        let working_dir = match &cwd {
            Some(dir) => PathBuf::from(clamp_to_project(dir, &ap.project_path)),
            None => PathBuf::from(&ap.project_path),
        };
        let cmd = build_host_command(&command, &working_dir);
        return run_command_with_timeout(cmd, timeout).await;
    }

    // ── No active project: unrestricted host execution ───────────────
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
fn emit_utf8_validated(
    data: &[u8],
    leftover: &mut Vec<u8>,
    emit: &dyn Fn(&str),
) {
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
fn stream_pipe_to_events(
    pipe: &mut dyn Read,
    pid: u32,
    stream_name: &str,
    app: &tauri::AppHandle,
) {
    let mut buf = [0u8; 4096];
    let mut leftover: Vec<u8> = Vec::new();

    let emit = |text: &str| {
        let _ = app.emit("cmd-output", DevServerOutput {
            pid, stream: stream_name.into(), data: text.to_string(),
        });
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
        if let Some(ref container_name) = ap.container_name {
            let workdir = host_to_container_path(&cwd, &ap.project_path);
            build_container_command(&command, &workdir, container_name)
        } else {
            let working_dir = PathBuf::from(clamp_to_project(&cwd, &ap.project_path));
            build_host_command(&command, &working_dir)
        }
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
        let code = child.wait()
            .map(|s| s.code().unwrap_or(-1))
            .unwrap_or(-1);
        let _ = app_clone.emit("cmd-exit", serde_json::json!({ "pid": pid, "code": code }));
    });

    Ok(pid)
}

/// Spawn a long-running dev server process and stream its output back to the
/// frontend via Tauri events (`dev-server-output` and `dev-server-exit`).
///
/// Routing:
///   - Docker mode → `docker exec` (ports already forwarded on container)
///   - App-level / no project → host shell (cwd clamped when isolated)
#[tauri::command]
pub async fn start_dev_server(
    app: tauri::AppHandle,
    command: String,
    cwd: String,
    port: Option<u16>,
    process_map: State<'_, ProcessMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("Empty command".to_string());
    }

    let server_port = port.unwrap_or(7773);
    let port_str = server_port.to_string();

    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    let mut cmd = if let Some(ref ap) = project {
        if let Some(ref container_name) = ap.container_name {
            // Docker mode — ensure container is running first
            ensure_container_running(container_name);

            let workdir = host_to_container_path(&cwd, &ap.project_path);
            let mut c = docker_cmd();
            // Kill any orphaned dev server on the target port inside the container,
            // then run the actual command. Use fuser (busybox-compatible) instead of lsof.
            let wrapped = format!(
                "fuser -k {}/tcp 2>/dev/null; {}",
                server_port, command
            );
            let port_env = format!("PORT={}", server_port);
            c.args([
                "exec",
                "-w",
                &workdir,
                "-e",
                "FORCE_COLOR=0",
                "-e",
                "NO_COLOR=1",
                "-e",
                &port_env,
                "-e",
                "BROWSER=none",
                // Bind to 0.0.0.0 so port mapping works from host.
                // Different frameworks read different vars (Vite: HOST, Next: HOSTNAME).
                "-e",
                "HOST=0.0.0.0",
                "-e",
                "HOSTNAME=0.0.0.0",
                container_name,
                "sh",
                "-c",
                &wrapped,
            ]);

            // MUST set own process group so kill_process doesn't kill the IDE
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                c.process_group(0);
            }

            c.stdout(Stdio::piped()).stderr(Stdio::piped());
            c
        } else {
            // App-level isolation: clamp cwd
            let clamped = clamp_to_project(&cwd, &ap.project_path);
            let (shell, flag) = if cfg!(target_os = "windows") {
                ("cmd", "/C")
            } else {
                ("sh", "-c")
            };

            let mut c = Command::new(shell);
            c.arg(flag)
                .arg(&command)
                .current_dir(&clamped)
                .env("FORCE_COLOR", "0")
                .env("NO_COLOR", "1")
                .env("PORT", &port_str)
                .env("BROWSER", "none")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                c.process_group(0);
            }

            c
        }
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
            .env("PORT", &port_str)
            .env("BROWSER", "none")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

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

    // Stream stdout to frontend (resilient to non-UTF-8 lines)
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        let _ = app_clone.emit(
                            "dev-server-output",
                            DevServerOutput {
                                pid,
                                stream: "stdout".into(),
                                data: line,
                            },
                        );
                    }
                    Err(e) => {
                        if e.kind() == std::io::ErrorKind::InvalidData {
                            // Non-UTF-8 line — skip but don't stop reading
                            continue;
                        }
                        // Real IO error (pipe closed, process exited) — stop
                        break;
                    }
                }
            }
            // Don't emit exit here — let the wait thread handle it
        });
    }

    // Stream stderr to frontend (resilient to non-UTF-8 lines)
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line_result in reader.lines() {
                match line_result {
                    Ok(line) => {
                        let _ = app_clone.emit(
                            "dev-server-output",
                            DevServerOutput {
                                pid,
                                stream: "stderr".into(),
                                data: line,
                            },
                        );
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

        // Spawn a thread that waits for the process to actually exit
        std::thread::spawn(move || {
            loop {
                // Check if process is still alive using kill -0
                let alive = Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);

                if !alive {
                    let _ = app_clone.emit("dev-server-exit", pid);
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        });
    }

    Ok(pid)
}

#[tauri::command]
pub async fn start_interactive_shell(
    cwd: Option<String>,
    process_map: State<'_, ProcessMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<ProcessInfo, String> {
    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    if let Some(ref ap) = project {
        if let Some(ref container_name) = ap.container_name {
            // Docker mode: prefer bash if available, fallback to sh
            let workdir = match &cwd {
                Some(dir) => host_to_container_path(dir, &ap.project_path),
                None => WORKSPACE_PATH.to_string(),
            };

            let has_bash = docker_cmd()
                .args(["exec", container_name, "which", "bash"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

            let shell = if has_bash { "bash" } else { "sh" };

            let child = docker_cmd()
                .args([
                    "exec", "-i", "-w", &workdir, container_name, shell,
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to start shell in container: {}", e))?;

            let pid = child.id();
            process_map
                .lock()
                .map_err(|_| "Failed to lock process map")?
                .insert(pid, child);

            return Ok(ProcessInfo {
                pid,
                command: "docker".to_string(),
                args: vec!["exec".into(), container_name.clone(), shell.into()],
                cwd: workdir,
            });
        }

        // App-level isolation: clamp cwd
        let working_dir = match &cwd {
            Some(dir) => PathBuf::from(clamp_to_project(dir, &ap.project_path)),
            None => PathBuf::from(&ap.project_path),
        };

        let (shell_cmd, shell_args) = if cfg!(target_os = "windows") {
            ("cmd".to_string(), vec!["/C".to_string()])
        } else {
            let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            (shell, vec!["-i".to_string()])
        };

        let child = Command::new(&shell_cmd)
            .args(&shell_args)
            .current_dir(&working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start interactive shell: {}", e))?;

        let pid = child.id();
        process_map
            .lock()
            .map_err(|_| "Failed to lock process map")?
            .insert(pid, child);

        return Ok(ProcessInfo {
            pid,
            command: shell_cmd,
            args: shell_args,
            cwd: working_dir.to_string_lossy().to_string(),
        });
    }

    // No active project: unrestricted
    let working_dir = match cwd {
        Some(dir) => PathBuf::from(dir),
        None => {
            env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?
        }
    };

    let (shell_cmd, shell_args) = if cfg!(target_os = "windows") {
        ("cmd".to_string(), vec!["/C".to_string()])
    } else {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (shell, vec!["-i".to_string()])
    };

    let child = Command::new(&shell_cmd)
        .args(&shell_args)
        .current_dir(&working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start interactive shell: {}", e))?;

    let pid = child.id();
    process_map
        .lock()
        .map_err(|_| "Failed to lock process map")?
        .insert(pid, child);

    Ok(ProcessInfo {
        pid,
        command: shell_cmd,
        args: shell_args,
        cwd: working_dir.to_string_lossy().to_string(),
    })
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

/// Kill any process listening on the given port.
/// Used to free the dev server port before starting a new server.
#[tauri::command]
pub async fn kill_port(port: u16) -> Result<bool, String> {
    if cfg!(unix) {
        let cmd = format!("lsof -ti:{} | xargs kill -9 2>/dev/null", port);
        let _ = Command::new("sh")
            .args(["-c", &cmd])
            .output();
    } else {
        let cmd = format!(
            "for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :{} ^| findstr LISTENING') do taskkill /F /PID %a",
            port
        );
        let _ = Command::new("cmd")
            .args(["/C", &cmd])
            .output();
    }

    // Wait until the OS actually frees the port (up to 3s).
    // kill -9 is async — the kernel may take a moment to release the socket.
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let check = format!("lsof -ti:{}", port);
        if let Ok(output) = Command::new("sh").args(["-c", &check]).output() {
            if output.stdout.is_empty() {
                return Ok(true);
            }
        }
    }

    // Port still occupied after 3s — try one more kill
    if cfg!(unix) {
        let cmd = format!("lsof -ti:{} | xargs kill -9 2>/dev/null", port);
        let _ = Command::new("sh").args(["-c", &cmd]).output();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }

    Ok(true)
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

        // NOTE: removed port-based kill (lsof -ti:7773 | kill) — it was killing
        // Colima's SSH port forwarding process, crashing the Docker VM.
    } else {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output();
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

    let canonical = std::fs::canonicalize(&new_path)
        .map_err(|e| format!("Failed to resolve directory: {}", e))?;

    // After canonicalization, re-check that we're still inside the project
    if let Some(ref ap) = project {
        let clamped = clamp_to_project(
            &canonical.to_string_lossy(),
            &ap.project_path,
        );
        return Ok(clamped);
    }

    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn command_exists(
    command: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<bool, String> {
    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    // Docker mode: check inside container (use which as separate arg, no shell interpolation)
    if let Some(ref ap) = project {
        if let Some(ref container_name) = ap.container_name {
            let output = docker_cmd()
                .args(["exec", container_name, "which", &command])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| format!("Failed to check command in container: {}", e))?;
            return Ok(output.success());
        }
    }

    // Host execution (app-level or no isolation)
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = Command::new(which_cmd)
        .arg(&command)
        .output()
        .map_err(|e| format!("Failed to check command existence: {}", e))?;

    Ok(output.status.success())
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

    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    // Docker mode: read env from container
    if let Some(ref ap) = project {
        if let Some(ref container_name) = ap.container_name {
            let output = docker_cmd()
                .args(["exec", container_name, "env"])
                .output()
                .map_err(|e| format!("Failed to get container env: {}", e))?;

            if output.status.success() {
                let mut env_vars = HashMap::new();
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    if let Some((key, value)) = line.split_once('=') {
                        let upper = key.to_uppercase();
                        let is_sensitive =
                            sensitive_patterns.iter().any(|pat| upper.contains(pat));
                        if !is_sensitive {
                            env_vars.insert(key.to_string(), value.to_string());
                        }
                    }
                }
                return Ok(env_vars);
            }
        }
    }

    // Host env (app-level or no isolation)
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
        (None, None) => {
            env::current_dir().map_err(|e| format!("Failed to get cwd: {}", e))?
        }
    };

    // Docker mode: use compgen inside container
    if let Some(ref ap) = project {
        if let Some(ref container_name) = ap.container_name {
            let workdir = match &cwd {
                Some(dir) => host_to_container_path(dir, &ap.project_path),
                None => WORKSPACE_PATH.to_string(),
            };
            // Use bash compgen for smart completion inside container
            // Shell-escape partial to prevent command injection
            let safe_partial = partial.replace('\'', "'\\''");
            let safe_workdir = workdir.replace('\'', "'\\''");
            let script = format!(
                "cd '{}' 2>/dev/null; compgen -f -- '{}' 2>/dev/null | head -20",
                safe_workdir, safe_partial
            );
            let output = docker_cmd()
                .args(["exec", "-w", &workdir, container_name, "bash", "-c", &script])
                .output()
                .map_err(|e| format!("Docker completion failed: {}", e))?;

            if output.status.success() {
                let mut completions: Vec<String> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                completions.sort();
                return Ok(completions);
            }
        }
    }

    // Host mode: resolve path-aware completion
    // The partial may be a bare name ("src") or a path ("src/comp")
    let partial_path = PathBuf::from(&partial);
    let (search_dir, prefix) = if partial.contains('/') {
        // Path completion: "src/comp" → search in "src/", filter by "comp"
        let parent = partial_path.parent().unwrap_or(std::path::Path::new(""));
        let file_prefix = partial_path.file_name()
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
                    let display = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        if partial.contains('/') {
                            // Reconstruct relative path: "src/" + "components/"
                            let parent_str = partial_path.parent()
                                .and_then(|p| p.to_str())
                                .unwrap_or("");
                            format!("{}/{}/", parent_str, name)
                        } else {
                            format!("{}/", name)
                        }
                    } else if partial.contains('/') {
                        let parent_str = partial_path.parent()
                            .and_then(|p| p.to_str())
                            .unwrap_or("");
                        format!("{}/{}", parent_str, name)
                    } else {
                        name.to_string()
                    };
                    completions.push(display);
                }
            }
        }
    }

    // If no file matches and partial looks like a command (first word), try command completion
    if completions.is_empty() && !partial.contains('/') {
        // Shell-escape partial to prevent command injection
        let safe_partial = partial.replace('\'', "'\\''");
        if let Ok(output) = Command::new("bash")
            .args(["-c", &format!("compgen -c -- '{}' 2>/dev/null | head -20", safe_partial)])
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
