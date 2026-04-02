//! Process-level sandbox for agent commands.
//!
//! - macOS: `sandbox-exec` with Seatbelt profile
//! - Linux: `bwrap` (bubblewrap) with bind mounts
//! - Windows: app-level path clamping only (no OS-level sandbox)
//!
//! OFF by default. Toggled via UI → `sandbox_set_enabled`.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

static SANDBOX_ENABLED: AtomicBool = AtomicBool::new(false);
static SANDBOX_CHECKED: AtomicBool = AtomicBool::new(false);
static SANDBOX_TOOLS_OK: AtomicBool = AtomicBool::new(false);

pub fn is_sandbox_enabled() -> bool {
    SANDBOX_ENABLED.load(Ordering::Relaxed)
}

pub fn is_sandbox_available() -> bool {
    if SANDBOX_CHECKED.load(Ordering::Relaxed) {
        return SANDBOX_TOOLS_OK.load(Ordering::Relaxed);
    }
    let ok = check_tools();
    SANDBOX_TOOLS_OK.store(ok, Ordering::Relaxed);
    SANDBOX_CHECKED.store(true, Ordering::Relaxed);
    ok
}

fn check_tools() -> bool {
    #[cfg(target_os = "macos")]
    {
        Command::new("sandbox-exec")
            .args(["-p", "(version 1)(allow default)", "/usr/bin/true"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("bwrap")
            .arg("--version")
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(target_os = "windows")]
    {
        // Check if WSL2 + bwrap are available
        is_wsl2_available()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    { false }
}

#[cfg(target_os = "windows")]
fn is_wsl2_available() -> bool {
    Command::new("wsl")
        .args(["--status"])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
        &&
    Command::new("wsl")
        .args(["bwrap", "--version"])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Returns Some(Command) if sandbox is enabled+available, None otherwise.
pub fn sandboxed_command(
    command: &str,
    project_path: &Path,
    extra_writable: &[&str],
) -> Option<Command> {
    if !is_sandbox_enabled() || !is_sandbox_available() {
        return None;
    }

    #[cfg(target_os = "macos")]
    { Some(macos::build(command, project_path, extra_writable)) }

    #[cfg(target_os = "linux")]
    { Some(linux::build(command, project_path, extra_writable)) }

    #[cfg(target_os = "windows")]
    { windows::build(command, project_path, extra_writable) }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    { None }
}

/// Sanitize a path for embedding in Seatbelt profile strings.
/// Escapes `"` and `\` to prevent injection.
fn sanitize_path(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

// ── macOS ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    pub fn build(command: &str, project_path: &Path, extra_writable: &[&str]) -> Command {
        let home = sanitize_path(&std::env::var("HOME").unwrap_or_else(|_| "/Users/unknown".into()));
        let project = sanitize_path(&project_path.to_string_lossy());

        let extra = extra_writable.iter()
            .map(|p| format!("(allow file-write* (subpath \"{}\"))", sanitize_path(p)))
            .collect::<Vec<_>>()
            .join("\n");

        // Allow-by-default, deny sensitive paths.
        // More permissive than deny-default but actually works — tools like node, npm,
        // git need dozens of mach services and file paths that are impossible to whitelist.
        let profile = format!(r#"(version 1)
(allow default)

;; === STEP 1: Block other users ===
(deny file-read* (subpath "/Users"))

;; === STEP 2: Allow own home (tools, configs) ===
(allow file-read* (subpath "{home}"))

;; === STEP 3: Deny home writes (blanket) ===
(deny file-write* (subpath "{home}"))

;; === STEP 4: Re-allow writes to project + caches ===
(allow file-write* (subpath "{project}"))
(allow file-write*
    (subpath "{home}/.npm")
    (subpath "{home}/.local/share/pnpm")
    (subpath "{home}/.bun/install")
    (subpath "{home}/.node-gyp")
)

;; === STEP 5: DENY credentials (MUST be LAST — overrides step 2 allow) ===
(deny file-read* file-write*
    (subpath "{home}/.ssh")
    (subpath "{home}/.aws")
    (subpath "{home}/.gnupg")
    (subpath "{home}/.docker")
    (subpath "{home}/.kube")
    (subpath "{home}/.azure")
    (subpath "{home}/.config/gh")
    (subpath "{home}/.config/gcloud")
    (subpath "{home}/.password-store")
    (subpath "{home}/.1password")
    (subpath "{home}/Library/Keychains")
)
(deny file-read*
    (literal "{home}/.netrc")
    (literal "{home}/.git-credentials")
    (literal "{home}/.npmrc")
    (literal "{home}/.pypirc")
    (literal "{home}/.bash_history")
    (literal "{home}/.zsh_history")
)

{extra}
"#);

        let mut cmd = Command::new("sandbox-exec");
        cmd.arg("-p").arg(&profile)
            .arg("sh").arg("-c").arg(command)
            .current_dir(project_path)
            .stdout(Stdio::piped()).stderr(Stdio::piped());

        if let Some(path) = super::super::terminal::get_user_path() {
            cmd.env("PATH", path);
        }

        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        cmd
    }
}

// ── Linux ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    pub fn build(command: &str, project_path: &Path, extra_writable: &[&str]) -> Command {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/unknown".into());
        let project = project_path.to_string_lossy();

        let mut cmd = Command::new("bwrap");
        cmd.args([
            "--ro-bind", "/", "/",
            "--bind", &*project, &*project,
            "--bind", "/tmp", "/tmp",
            "--dev", "/dev",
            "--proc", "/proc",
            "--unshare-pid",
            "--die-with-parent",
        ]);

        // Block sensitive directories
        let sensitive_dirs = [
            ".ssh", ".aws", ".gnupg", ".docker",
            ".config/gh", ".config/gcloud",
            ".kube", ".azure",
            ".password-store", ".1password",
        ];
        for dir in &sensitive_dirs {
            let p = format!("{}/{}", home, dir);
            if Path::new(&p).exists() {
                cmd.arg("--tmpfs").arg(&p);
            }
        }

        // Block sensitive files (use /dev/null bind since --tmpfs only works on dirs)
        let sensitive_files = [
            ".bash_history", ".zsh_history", ".python_history",
            ".netrc", ".git-credentials",
            ".npmrc", ".pypirc", ".m2/settings.xml",
            ".env", ".env.local",
        ];
        for file in &sensitive_files {
            let p = format!("{}/{}", home, file);
            if Path::new(&p).exists() {
                cmd.arg("--ro-bind").arg("/dev/null").arg(&p);
            }
        }

        // Tool caches (read-write — npm/pnpm/bun need cache write)
        let cache_dirs = [".npm", ".local/share/pnpm", ".bun/install", ".node-gyp"];
        for dir in &cache_dirs {
            let p = format!("{}/{}", home, dir);
            if Path::new(&p).exists() {
                cmd.arg("--bind").arg(&p).arg(&p);
            }
        }

        for path in extra_writable {
            cmd.arg("--bind").arg(path).arg(path);
        }

        cmd.arg("sh").arg("-c").arg(command);
        cmd.current_dir(project_path)
            .stdout(Stdio::piped()).stderr(Stdio::piped());

        if let Some(path) = super::super::terminal::get_user_path() {
            cmd.env("PATH", path);
        }

        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        cmd
    }
}

// ── Windows (via WSL2 + bwrap) ─────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows {
    use super::*;

    pub fn build(command: &str, project_path: &Path, extra_writable: &[&str]) -> Option<Command> {
        if !super::is_wsl2_available() {
            return None;
        }

        let project = project_path.to_string_lossy();
        // Convert Windows path to WSL path: C:\Users\me\project → /mnt/c/Users/me/project
        let wsl_project = windows_to_wsl_path(&project);

        let mut bwrap_args = format!(
            "bwrap --ro-bind / / --bind {} {} --bind /tmp /tmp --dev /dev --proc /proc --unshare-pid --die-with-parent",
            wsl_project, wsl_project
        );

        // Block sensitive dirs
        let home = "$HOME";
        for dir in &[".ssh", ".aws", ".gnupg", ".docker", ".kube", ".azure"] {
            bwrap_args.push_str(&format!(" --tmpfs {}/{}", home, dir));
        }

        for path in extra_writable {
            let wsl_path = windows_to_wsl_path(path);
            bwrap_args.push_str(&format!(" --bind {} {}", wsl_path, wsl_path));
        }

        bwrap_args.push_str(&format!(" sh -c '{}'", command.replace('\'', "'\\''")));

        let mut cmd = Command::new("wsl");
        cmd.arg("bash").arg("-c").arg(&bwrap_args)
            .current_dir(project_path)
            .stdout(Stdio::piped()).stderr(Stdio::piped());

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);

        Some(cmd)
    }

    fn windows_to_wsl_path(path: &str) -> String {
        // C:\Users\me\project → /mnt/c/Users/me/project
        if path.len() >= 2 && path.as_bytes()[1] == b':' {
            let drive = (path.as_bytes()[0] as char).to_lowercase().next().unwrap();
            format!("/mnt/{}{}", drive, path[2..].replace('\\', "/"))
        } else {
            path.replace('\\', "/")
        }
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn sandbox_set_enabled(enabled: bool) {
    eprintln!("[sandbox] {} by user", if enabled { "Enabled" } else { "Disabled" });
    SANDBOX_ENABLED.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn sandbox_check_deps() -> SandboxDeps {
    let mut missing: Vec<String> = Vec::new();
    let mut hints: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        // sandbox-exec is built-in, always available
    }

    #[cfg(target_os = "linux")]
    {
        if !Command::new("bwrap").arg("--version")
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false)
        {
            missing.push("bubblewrap (bwrap)".into());
            hints.push("Install: sudo apt install bubblewrap".into());
        }
    }

    #[cfg(target_os = "windows")]
    {
        if !Command::new("wsl").args(["--status"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false)
        {
            missing.push("WSL2".into());
            hints.push("Install: wsl --install".into());
        } else if !Command::new("wsl").args(["bwrap", "--version"])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false)
        {
            missing.push("bubblewrap inside WSL".into());
            hints.push("Run in WSL: sudo apt install bubblewrap".into());
        }
    }

    SandboxDeps { ok: missing.is_empty(), missing, hints }
}

#[derive(serde::Serialize)]
pub struct SandboxDeps {
    pub ok: bool,
    pub missing: Vec<String>,
    pub hints: Vec<String>,
}

#[tauri::command]
pub fn sandbox_status() -> SandboxInfo {
    SandboxInfo {
        enabled: is_sandbox_enabled(),
        available: is_sandbox_available(),
        platform: if cfg!(target_os = "macos") { "macos" }
                  else if cfg!(target_os = "linux") { "linux" }
                  else if cfg!(target_os = "windows") { "windows" }
                  else { "unsupported" },
    }
}

#[derive(serde::Serialize)]
pub struct SandboxInfo {
    pub enabled: bool,
    pub available: bool,
    pub platform: &'static str,
}
