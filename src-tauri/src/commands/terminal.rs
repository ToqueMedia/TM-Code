use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};

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
type ProcessMap = Mutex<HashMap<u32, std::process::Child>>;

// ─── Shared execution engine ─────────────────────────────────────────────────

/// Build a host-local shell command.
fn build_host_command(command: &str, cwd: &PathBuf) -> Command {
    let (shell, flag) = if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };

    let mut cmd = Command::new(shell);
    cmd.arg(flag)
        .arg(command)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    cmd
}

/// Build a `docker exec` command that runs inside a container.
fn build_container_command(command: &str, workdir: &str, container_name: &str) -> Command {
    let mut cmd = Command::new("docker");
    cmd.args(["exec", "-w", workdir, container_name, "sh", "-c", command])
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
            // ── Docker mode: route through container ─────────────────
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
    process_map: State<'_, ProcessMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<u32, String> {
    if command.trim().is_empty() {
        return Err("Empty command".to_string());
    }

    let project = active_project.lock().map_err(|_| "Lock error")?.clone();

    let mut cmd = if let Some(ref ap) = project {
        if let Some(ref container_name) = ap.container_name {
            // Docker mode
            let workdir = host_to_container_path(&cwd, &ap.project_path);
            let mut c = Command::new("docker");
            c.args([
                "exec",
                "-w",
                &workdir,
                "-e",
                "FORCE_COLOR=0",
                "-e",
                "NO_COLOR=1",
                "-e",
                "BROWSER=none",
                container_name,
                "sh",
                "-c",
                &command,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                c.process_group(0);
            }

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
                .env("PORT", "5174")
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
            .env("PORT", "5174")
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

    // Stream stdout to frontend
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_clone.emit(
                    "dev-server-output",
                    DevServerOutput {
                        pid,
                        stream: "stdout".into(),
                        data: line,
                    },
                );
            }
            let _ = app_clone.emit("dev-server-exit", pid);
        });
    }

    // Stream stderr to frontend
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_clone.emit(
                    "dev-server-output",
                    DevServerOutput {
                        pid,
                        stream: "stderr".into(),
                        data: line,
                    },
                );
            }
        });
    }

    {
        let mut map = process_map
            .lock()
            .map_err(|_| "Failed to lock process map")?;
        map.insert(pid, child);
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

            let has_bash = Command::new("docker")
                .args(["exec", container_name, "which", "bash"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);

            let shell = if has_bash { "bash" } else { "sh" };

            let child = Command::new("docker")
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

        let _ = Command::new("sh")
            .args(["-c", "lsof -ti:5174 | xargs -r kill -9 2>/dev/null"])
            .output();
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
            let output = Command::new("docker")
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
            let output = Command::new("docker")
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

    // Docker mode: list files inside container
    if let Some(ref ap) = project {
        if let Some(ref container_name) = ap.container_name {
            let workdir = match &cwd {
                Some(dir) => host_to_container_path(dir, &ap.project_path),
                None => WORKSPACE_PATH.to_string(),
            };
            let output = Command::new("docker")
                .args([
                    "exec",
                    "-w",
                    &workdir,
                    container_name,
                    "ls",
                    "-1A",
                ])
                .output()
                .map_err(|e| format!("Failed to list files in container: {}", e))?;

            if output.status.success() {
                let mut completions: Vec<String> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter(|name| name.starts_with(&partial))
                    .map(|s| s.to_string())
                    .collect();
                completions.truncate(20);
                completions.sort();
                return Ok(completions);
            }
        }
    }

    // Host mode: read filesystem (clamp cwd if isolated)
    let working_dir = match (&cwd, &project) {
        (Some(dir), Some(ap)) => PathBuf::from(clamp_to_project(dir, &ap.project_path)),
        (Some(dir), None) => PathBuf::from(dir),
        (None, Some(ap)) => PathBuf::from(&ap.project_path),
        (None, None) => {
            env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?
        }
    };

    let mut completions = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&working_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with(&partial) {
                    completions.push(name.to_string());
                }
            }
        }
    }

    completions.truncate(20);
    completions.sort();

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
