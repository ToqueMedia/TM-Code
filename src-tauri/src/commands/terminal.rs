use super::container::ActiveProjectState;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveShellInfo {
    pub command: String,
    pub args: Vec<String>,
    pub kind: String,
    pub command_style: String,
    pub platform: String,
    pub warning: Option<String>,
}

// Estado global para manter histórico de comandos
type CommandHistory = Mutex<Vec<String>>;
pub type ProcessMap = Mutex<HashMap<u32, std::process::Child>>;

/// PIDs spawned by `run_streaming_command`, tracked for `kill_process`.
///
/// Why a second registry instead of `ProcessMap` (auditoria 2026-07-28): the
/// map OWNS a `std::process::Child`, but `run_streaming_command` must move its
/// child into a reaper thread to emit `cmd-exit` — it cannot also hand it to
/// the map, and holding the map lock across `wait()` would freeze every other
/// caller. So `kill_process` used to reject EVERY streaming PID with "not a
/// process managed by this application": the agent's command timeouts, aborts
/// and background cancels all failed silently inside `catch {}` while the model
/// was told the process had been killed. It hadn't — it ran on, orphaned.
///
/// Tracking the bare PID restores the kill without weakening the containment
/// check: only processes WE spawned can be targeted, so an arbitrary PID (e.g.
/// hallucinated by the model) is still refused.
static SPAWNED_PIDS: Mutex<std::collections::BTreeSet<u32>> =
    Mutex::new(std::collections::BTreeSet::new());

fn register_spawned_pid(pid: u32) {
    if let Ok(mut pids) = SPAWNED_PIDS.lock() {
        pids.insert(pid);
    }
}

fn forget_spawned_pid(pid: u32) {
    if let Ok(mut pids) = SPAWNED_PIDS.lock() {
        pids.remove(&pid);
    }
}

fn is_spawned_pid(pid: u32) -> bool {
    SPAWNED_PIDS
        .lock()
        .map(|pids| pids.contains(&pid))
        .unwrap_or(false)
}

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
/// Shell PID per session, captured at spawn. Teardown (kill_pty_session + app
/// shutdown) needs it to kill the whole process TREE — an interactive shell puts
/// each job (e.g. `yarn dev`) in its OWN process group via job control, so
/// killing just the shell (portable-pty `child.kill()`) or killpg by the shell's
/// pgid orphans the dev server, which then keeps the port bound (the "servers
/// accumulate on :3001" bug). The exit-wait thread owns the Child object, so the
/// pid cannot be read back from PtyChildMap at teardown — hence this map.
pub type PtyPidMap = Mutex<HashMap<String, u32>>;

// Default terminal dimensions (used until first resize event from xterm.js)
const DEFAULT_PTY_COLS: u16 = 120;
const DEFAULT_PTY_ROWS: u16 = 30;

// ─── Shared execution engine ─────────────────────────────────────────────────

/// Build a host-local shell command.
/// Cached full PATH from the user's login shell.
/// Extracted (lazily) via `$SHELL -l -c 'printf $PATH'` so that tools
/// installed via brew, nvm, volta, corepack are visible without the side
/// effects of a full login shell (motd, starship prompt, etc.)
///
/// SUCCESS-ONLY cache: a failed extraction (every shell timing out because the
/// machine was pegged at app launch, a hung .zshrc, …) is NOT cached — it
/// retries on a later call, throttled by PATH_RETRY_INTERVAL. Caching the
/// failure (the old `OnceLock<Option<String>>`) poisoned the whole session
/// with the minimal fallback PATH — no pyenv/asdf/volta shims — so
/// `python3 --version` exited 127 and the IDE asked users to install tools
/// they had.
///
/// Initialized eagerly at app startup via `init_user_path()` on a background
/// thread so it doesn't block the first command.
static USER_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Timestamp of the last (failed) extraction attempt — throttles retries (one
/// attempt can spawn up to 4 shells × 5 s timeouts) and collapses concurrent
/// callers into a single extractor while the others use the fallback PATH.
static PATH_RETRY_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
const PATH_RETRY_INTERVAL: Duration = Duration::from_secs(60);

/// Call once at app startup (from lib.rs setup) to pre-warm the PATH cache
/// on a background thread. Non-blocking.
pub fn init_user_path() {
    std::thread::spawn(|| {
        get_user_path();
    });
}

pub fn get_user_path() -> Option<&'static str> {
    if let Some(path) = USER_PATH.get() {
        return Some(path.as_str());
    }
    // On Windows, the system PATH is already correct — no shell extraction needed.
    if cfg!(target_os = "windows") {
        return None;
    }
    {
        let mut gate = PATH_RETRY_AT.lock().ok()?;
        if let Some(last) = *gate {
            if last.elapsed() < PATH_RETRY_INTERVAL {
                return None; // recent attempt failed/is running — use fallback for now
            }
        }
        *gate = Some(std::time::Instant::now());
    }
    let extracted = extract_user_path()?;
    Some(USER_PATH.get_or_init(|| extracted).as_str())
}

/// One extraction attempt across the shell/flag matrix. None on total failure.
fn extract_user_path() -> Option<String> {
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

#[cfg(target_os = "windows")]
fn run_probe(command: &str, args: &[&str], timeout: Duration) -> Option<std::process::Output> {
    let mut probe = Command::new(command);
    probe
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console_window(&mut probe);

    let mut child = probe.spawn().ok()?;
    let deadline = std::time::Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn probe_success(command: &str, args: &[&str]) -> bool {
    run_probe(command, args, Duration::from_secs(2))
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn probe_git_bash(command: &str) -> Option<String> {
    run_probe(command, &["-lc", "uname -s"], Duration::from_secs(2))
        .map(|output| {
            if !output.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&output.stdout).to_uppercase();
            if stdout.contains("MINGW") {
                Some("git-bash".to_string())
            } else if stdout.contains("MSYS") {
                Some("msys-bash".to_string())
            } else if stdout.contains("CYGWIN") {
                Some("cygwin-bash".to_string())
            } else {
                None
            }
        })
        .flatten()
}

#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<(String, String)> {
    let mut candidates: Vec<String> = Vec::new();

    if let Ok(program_files) = env::var("ProgramFiles") {
        candidates.push(format!("{}\\Git\\bin\\bash.exe", program_files));
    }
    if let Ok(program_files_x86) = env::var("ProgramFiles(x86)") {
        candidates.push(format!("{}\\Git\\bin\\bash.exe", program_files_x86));
    }
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates.push(format!("{}\\Programs\\Git\\bin\\bash.exe", local_app_data));
    }

    for candidate in candidates {
        if PathBuf::from(&candidate).exists() {
            if let Some(kind) = probe_git_bash(&candidate) {
                return Some((candidate, kind));
            }
        }
    }

    for candidate in ["bash.exe", "bash"] {
        if let Some(kind) = probe_git_bash(candidate) {
            return Some((candidate.to_string(), kind));
        }
    }

    None
}

/// Pick a real interactive shell for PTY sessions.
///
/// On Windows, prefer Git Bash (bundled with the required Git for Windows)
/// before PowerShell so agent commands stay closer to macOS/Linux semantics.
/// If Git Bash is unavailable, fall back to PowerShell 7, Windows PowerShell,
/// then cmd.exe.
///
/// On Unix, use the user's `$SHELL` (or `/bin/bash`) with `-i`.
fn pick_interactive_shell_info() -> InteractiveShellInfo {
    #[cfg(target_os = "windows")]
    {
        if let Some((bash, kind)) = find_git_bash() {
            return InteractiveShellInfo {
                command: bash,
                args: vec!["--login".to_string(), "-i".to_string()],
                kind,
                command_style: "posix".to_string(),
                platform: "windows".to_string(),
                warning: None,
            };
        }

        if probe_success("pwsh", &["-Version"]) {
            return InteractiveShellInfo {
                command: "pwsh".to_string(),
                args: vec!["-NoLogo".to_string(), "-NoExit".to_string()],
                kind: "pwsh".to_string(),
                command_style: "powershell".to_string(),
                platform: "windows".to_string(),
                warning: Some(
                    "Git Bash was not found. Using PowerShell; prefer PowerShell commands."
                        .to_string(),
                ),
            };
        }

        if probe_success("powershell", &["-Command", "$PSVersionTable.PSVersion"]) {
            return InteractiveShellInfo {
                command: "powershell".to_string(),
                args: vec!["-NoLogo".to_string(), "-NoExit".to_string()],
                kind: "powershell".to_string(),
                command_style: "powershell".to_string(),
                platform: "windows".to_string(),
                warning: Some(
                    "Git Bash was not found. Using Windows PowerShell; prefer PowerShell commands."
                        .to_string(),
                ),
            };
        }

        InteractiveShellInfo {
            command: "cmd".to_string(),
            args: vec![],
            kind: "cmd".to_string(),
            command_style: "cmd".to_string(),
            platform: "windows".to_string(),
            warning: Some(
                "Git Bash and PowerShell were not found. Using cmd.exe; POSIX commands may not work."
                    .to_string(),
            ),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let kind = PathBuf::from(&shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("shell")
            .to_string();
        InteractiveShellInfo {
            command: shell,
            args: vec!["-l".to_string(), "-i".to_string()],
            kind,
            command_style: "posix".to_string(),
            platform: env::consts::OS.to_string(),
            warning: None,
        }
    }
}

fn pick_interactive_shell() -> (String, Vec<String>) {
    let info = pick_interactive_shell_info();
    (info.command, info.args)
}

#[tauri::command]
pub async fn get_interactive_shell_info() -> InteractiveShellInfo {
    pick_interactive_shell_info()
}

/// Resultado da sonda de split-brain de porto (ver `check_port_split`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortSplitInfo {
    pub ipv4_reachable: bool,
    pub ipv6_reachable: bool,
    /// true quando AMBAS as famílias respondem com conteúdo DIFERENTE —
    /// dois servidores distintos a partilhar o mesmo número de porto.
    pub split: bool,
}

/// Deteta "port split-brain": dois dev servers no MESMO número de porto em
/// famílias de endereço diferentes (um em `127.0.0.1`, outro em `[::1]`).
///
/// Cenário real (2026-06-11): Vite do projeto A vinculado a `[::1]:5173`
/// (Node ≥17 resolve `localhost` IPv6-first) + Vite do projeto B vinculado a
/// `*:5173` IPv4 — ambos os binds têm sucesso, ambos anunciam
/// "localhost:5173", e o browser (IPv6 primeiro) abre SEMPRE o projeto A.
///
/// Estratégia: GET às duas famílias e comparação de status + prefixo do
/// corpo. Um único servidor dual-stack responde igual nas duas → split=false;
/// servidores diferentes divergem no bundle/título → split=true. Sondas com
/// timeout curto — isto corre uma vez por anúncio de URL no terminal.
#[tauri::command]
pub async fn check_port_split(port: u16) -> PortSplitInfo {
    async fn probe(url: &str) -> Option<(u16, u64)> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(900))
            .build()
            .ok()?;
        let resp = client
            .get(url)
            .header("accept", "text/html")
            .send()
            .await
            .ok()?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.ok()?;
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        bytes[..bytes.len().min(4096)].hash(&mut hasher);
        Some((status, hasher.finish()))
    }

    let url_v4 = format!("http://127.0.0.1:{}/", port);
    let url_v6 = format!("http://[::1]:{}/", port);
    let (v4, v6) = tokio::join!(probe(&url_v4), probe(&url_v6));

    let split = matches!((&v4, &v6), (Some(a), Some(b)) if a != b);
    PortSplitInfo {
        ipv4_reachable: v4.is_some(),
        ipv6_reachable: v6.is_some(),
        split,
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
            // Version-manager shims: without these, a session whose login-shell
            // PATH extraction failed reported pyenv/asdf/volta-managed tools as
            // "command not found" (exit 127) — which the required-tools gate
            // read as "Python/Node not installed".
            &format!("{}/.pyenv/shims", home),
            &format!("{}/.asdf/shims", home),
            &format!("{}/.volta/bin", home),
            &format!("{}/.local/bin", home),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
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
/// Escreve `stdin_data` no stdin do filho e fecha-o quando presente: é o
/// contrato dos HOOKS (porte do cli-vaz) — o payload do evento viaja em JSON no
/// stdin, e é isso que faz um hook escrito para o Claude Code correr aqui sem
/// alterações. Escreve-se ANTES de esperar pela saída; um hook que leia stdin
/// até EOF ficaria bloqueado para sempre de outra forma.
///
/// (Havia um wrapper `run_command_with_timeout` que só chamava isto com
/// `None`. Ficou sem chamadores quando os hooks migraram todos para esta
/// versão, e o clippy do CI — que corre com `-D warnings` — acusava-o como
/// código morto. Passar `None` aqui é igualmente legível.)
async fn run_command_with_timeout_stdin(
    mut cmd: Command,
    timeout: Duration,
    stdin_data: Option<String>,
) -> Result<CommandResult, String> {
    if stdin_data.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    if let Some(data) = stdin_data {
        if let Some(mut pipe) = child.stdin.take() {
            // EPIPE benigno: o hook pode sair sem ler o stdin todo.
            let _ = pipe.write_all(data.as_bytes());
            let _ = pipe.write_all(b"\n");
        }
        // `pipe` sai de escopo aqui e fecha, sinalizando EOF ao filho.
    }

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

/// Kill a PTY shell and EVERY descendant (the dev server and its children),
/// regardless of process group.
///
/// Why not `kill_process_tree` (killpg)? An interactive shell uses job control:
/// each job (`yarn dev`, `npm run dev`, …) gets its OWN process group, distinct
/// from the shell's. So `kill -- -<shellpgid>` — and portable-pty's
/// `child.kill()`, which targets only the shell PID — both leave the dev server
/// running, orphaned and still bound to its port. That is the root cause of
/// "dev servers accumulate on :3001 after I close a terminal". Here we instead
/// walk the descendant tree from the shell pid (every job shares the shell's
/// SESSION) and SIGTERM→SIGKILL each process, so nothing survives the teardown.
pub(crate) fn kill_pty_process_tree(root_pid: u32) {
    #[cfg(unix)]
    {
        // BFS the descendant tree: root → children → grandchildren … via pgrep -P.
        let mut all = vec![root_pid];
        let mut frontier = vec![root_pid];
        while let Some(pid) = frontier.pop() {
            if let Ok(out) = Command::new("pgrep")
                .args(["-P", &pid.to_string()])
                .output()
            {
                for cpid in String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .filter_map(|l| l.trim().parse::<u32>().ok())
                {
                    if !all.contains(&cpid) {
                        all.push(cpid);
                        frontier.push(cpid);
                    }
                }
            }
        }
        // SIGTERM leaves-first (reverse) for graceful shutdown, then SIGKILL any
        // straggler after a short grace period.
        for &pid in all.iter().rev() {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
        }
        std::thread::sleep(Duration::from_millis(200));
        for &pid in all.iter().rev() {
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .output();
        }
    }
    #[cfg(windows)]
    {
        // /T kills the whole tree by PID — children that escaped into their own
        // process groups are still caught.
        let mut tk = Command::new("taskkill");
        tk.args(["/T", "/F", "/PID", &root_pid.to_string()]);
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
    // `stdin`: JSON do evento, escrito no stdin do processo. Usado pelos HOOKS
    // (ver `run_command_with_timeout_stdin`). `None` para todos os outros
    // chamadores, que não passam o campo.
    stdin: Option<String>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<CommandResult, String> {
    if command.trim().is_empty() {
        return Err("Empty command".to_string());
    }

    let timeout = Duration::from_secs(timeout_secs.unwrap_or(300));
    let registry = active_project.lock().map_err(|_| "Lock error")?.clone();

    if !registry.is_empty() {
        // App-level isolation: sandbox the command to whichever OPEN project
        // owns the requested cwd (any of them), not only the active one.
        let working_dir = match &cwd {
            Some(dir) => PathBuf::from(registry.clamp_cwd(dir)),
            None => PathBuf::from(registry.default_cwd().unwrap_or_default()),
        };
        let cmd = build_sandboxed_host_command(&command, &working_dir);
        return run_command_with_timeout_stdin(cmd, timeout, stdin).await;
    }

    // No open project: unrestricted host execution
    let working_dir = match cwd {
        Some(dir) => PathBuf::from(dir),
        None => {
            env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?
        }
    };
    let cmd = build_host_command(&command, &working_dir);
    run_command_with_timeout_stdin(cmd, timeout, stdin).await
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

    let registry = active_project.lock().map_err(|_| "Lock error")?.clone();

    let mut cmd = if !registry.is_empty() {
        let working_dir = PathBuf::from(registry.clamp_cwd(&cwd));
        build_sandboxed_host_command(&command, &working_dir)
    } else {
        build_host_command(&command, &PathBuf::from(&cwd))
    };

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start command: {}", e))?;

    let pid = child.id();
    // Register BEFORE streaming starts: a timeout/abort can fire while the very
    // first chunk is still in flight, and an unregistered PID is unkillable.
    register_spawned_pid(pid);

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
        // Drop the registration once reaped so the set can't grow unbounded and
        // a recycled PID never inherits kill rights from a dead command.
        forget_spawned_pid(pid);
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

    let registry = active_project.lock().map_err(|_| "Lock error")?.clone();

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

    let mut cmd = if !registry.is_empty() {
        // App-level isolation: sandbox the dev server command
        let clamped = registry.clamp_cwd(&cwd);
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
    pid_map: State<'_, PtyPidMap>,
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

    let registry = active_project.lock().map_err(|_| "Lock error")?.clone();

    let pty_system = native_pty_system();

    let (shell_cmd, shell_args, working_dir) = if !registry.is_empty() {
        // App-level isolation: clamp cwd to whichever OPEN project owns it
        let working_dir = match &cwd {
            Some(dir) => PathBuf::from(registry.clamp_cwd(dir)),
            None => PathBuf::from(registry.default_cwd().unwrap_or_default()),
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

    // Set terminal coloring and UTF-8 locale environment variables
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "1");
    cmd.env("CLICOLOR", "1");
    cmd.env("CLICOLOR_FORCE", "1");
    cmd.env("TERM_PROGRAM", "Apple_Terminal");

    // Ensure UTF-8 locale is set so zsh/git/etc. enable full color and unicode support
    let lang = env::var("LANG").unwrap_or_default();
    if lang.is_empty() || lang == "C" || lang == "POSIX" {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let lc_all = env::var("LC_ALL").unwrap_or_default();
    if lc_all.is_empty() || lc_all == "C" || lc_all == "POSIX" {
        cmd.env("LC_ALL", "en_US.UTF-8");
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

    // Capture the shell PID NOW — before the Child is moved into the exit-wait
    // thread (which take()s it). Teardown uses this to kill the whole descendant
    // tree (shell + dev server), so closing a terminal frees the dev port instead
    // of leaking an orphaned server.
    if let Some(pid) = child.process_id() {
        if let Ok(mut pids) = pid_map.lock() {
            pids.insert(session_id.clone(), pid);
        }
    }

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
    pid_map: State<'_, PtyPidMap>,
) -> Result<(), String> {
    // Kill the WHOLE process tree (shell + dev server + its children), not just
    // the shell. Without this, the dev server (a job in its own process group)
    // was orphaned on every close and kept the port bound — which forced manual
    // `lsof | kill`, which in turn could SIGKILL the IDE itself (it holds the
    // port-guard / preview sockets). Killing the tree here breaks that chain.
    let shell_pid = pid_map
        .lock()
        .map_err(|_| "Failed to lock pid map")?
        .remove(&session_id);
    if let Some(pid) = shell_pid {
        // kill_pty_process_tree blocks (SIGTERM grace sleep) — keep it off the
        // async executor thread.
        tokio::task::spawn_blocking(move || kill_pty_process_tree(pid));
    }

    // Best-effort kill of the shell Child if the map still owns it (rare — the
    // exit-wait thread usually take()s it at spawn). Harmless belt-and-suspenders.
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

/// PIDs LISTENING on `port`, EXCLUDING this process (the IDE). The IDE can
/// legitimately hold a socket on a dev port and must NEVER be a kill target:
///   1. The port-guard (port_guard.rs) binds `127.0.0.1:<port>` for common dev
///      ports (3000, 5173, 8080, …) to push new dev servers onto the next free
///      port — those listeners live in THIS process.
///   2. The preview WKWebView keeps a client connection to the running dev
///      server's port.
///
/// The old `lsof -ti:PORT | xargs kill -9` SIGKILLed the IDE in case 1 — and,
/// without `-sTCP:LISTEN`, in case 2 — which is the "app closes the instant I
/// press Stop" crash. SIGKILL leaves no crash report, which is why no .ips ever
/// appeared. Two guards: `-sTCP:LISTEN` drops client sockets (case 2), and the
/// self-PID filter is the hard guarantee we never kill ourselves (case 1).
fn external_listener_pids(port: u16) -> Vec<u32> {
    let self_pid = std::process::id();
    #[cfg(unix)]
    {
        Command::new("sh")
            .args(["-c", &format!("lsof -t -a -iTCP:{} -sTCP:LISTEN", port)])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|l| l.trim().parse::<u32>().ok())
                    .filter(|&pid| pid != self_pid)
                    .collect::<Vec<u32>>()
            })
            .unwrap_or_default()
    }
    #[cfg(windows)]
    {
        // windows_pids_on_port matches by LOCAL port, so the preview webview's
        // client connection (ephemeral local port) is already excluded; the
        // port-guard's listener IS included, so drop self here too.
        windows_pids_on_port(port)
            .into_iter()
            .filter(|&pid| pid != self_pid)
            .collect()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = self_pid;
        Vec::new()
    }
}

/// Whether some EXTERNAL process (not the IDE itself) holds `port`. Light-weight
/// predicate used by kill_port to skip work when there is nothing to free.
fn port_is_occupied(port: u16) -> bool {
    !external_listener_pids(port).is_empty()
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

    // Only ever kill EXTERNAL listeners — never this process. external_listener_pids
    // already filtered out the IDE's own PID (port-guard listener / preview
    // connection), so what remains is a genuine foreign dev server on the port.
    let kill_once = || {
        for pid in external_listener_pids(port) {
            #[cfg(unix)]
            {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
            }
            #[cfg(windows)]
            {
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

    // Report whether we freed it — nothing EXTERNAL still listening. Our own
    // port-guard listener never counts (external_listener_pids excludes self),
    // so a port the IDE intentionally reserves doesn't trap kill_port here.
    let free = external_listener_pids(port).is_empty();
    Ok(free)
}

#[tauri::command]
pub async fn kill_process(pid: u32, process_map: State<'_, ProcessMap>) -> Result<bool, String> {
    {
        let map = process_map
            .lock()
            .map_err(|_| "Failed to lock process map")?;
        // Two ownership registries, one guarantee: `ProcessMap` holds long-running
        // children we own outright (dev servers), `SPAWNED_PIDS` the streaming
        // commands whose Child lives in a reaper thread. A PID in neither was not
        // spawned by us and is still refused.
        if !map.contains_key(&pid) && !is_spawned_pid(pid) {
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
    forget_spawned_pid(pid);

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
    let registry = active_project.lock().map_err(|_| "Lock error")?.clone();

    let effective_path = if !registry.is_empty() {
        registry.clamp_cwd(&path)
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

    // After canonicalization, re-check that we're still inside an open project
    if !registry.is_empty() {
        let clamped = registry.clamp_cwd(&canonical.to_string_lossy());
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
    let registry = active_project.lock().map_err(|_| "Lock error")?.clone();

    // Resolve working directory against the union of open projects.
    let working_dir = match &cwd {
        Some(dir) if !registry.is_empty() => PathBuf::from(registry.clamp_cwd(dir)),
        Some(dir) => PathBuf::from(dir),
        None if !registry.is_empty() => PathBuf::from(registry.default_cwd().unwrap_or_default()),
        None => env::current_dir().map_err(|e| format!("Failed to get cwd: {}", e))?,
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
