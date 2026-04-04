use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, State};

use super::devcontainer::{self, DevcontainerConfig};

/// Get the Colima socket path if available (macOS only — Colima is a macOS tool).
#[cfg(target_os = "macos")]
fn colima_socket_path() -> Option<String> {
    if let Some(home) = std::env::var_os("HOME") {
        let sock = format!("{}/.colima/default/docker.sock", home.to_string_lossy());
        if Path::new(&sock).exists() {
            return Some(sock);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn colima_socket_path() -> Option<String> { None }

/// Recover Colima from any broken state (macOS only).
/// On Windows/Linux, returns false immediately (Colima is not available).
#[cfg(not(target_os = "macos"))]
pub fn recover_colima() -> bool { false }

/// Recover Colima from any broken state. Escalates through:
/// 1. stop + start (fixes stale socket after sleep/wake)
/// 2. kill residual processes + start (fixes zombie Lima processes)
/// 3. delete -f + start (nuclear — destroys containers, fixes corrupted VM)
#[cfg(target_os = "macos")]
pub fn recover_colima() -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RECOVERING: AtomicBool = AtomicBool::new(false);

    // Prevent concurrent recovery attempts
    if RECOVERING.swap(true, Ordering::SeqCst) {
        // Another thread is already recovering — wait for it
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if !RECOVERING.load(Ordering::SeqCst) {
                return test_docker_connection();
            }
        }
        return false;
    }

    let result = recover_colima_inner();
    RECOVERING.store(false, Ordering::SeqCst);
    result
}

#[cfg(target_os = "macos")]
fn recover_colima_inner() -> bool {
    let has_colima = Command::new("which")
        .arg("colima")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !has_colima { return false; }

    // Attempt 1: gentle restart
    let _ = Command::new("colima").args(["stop"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    std::thread::sleep(std::time::Duration::from_secs(2));
    let _ = Command::new("colima").args(["start"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    std::thread::sleep(std::time::Duration::from_secs(3));

    if test_docker_connection() { return true; }

    // Attempt 2: kill stale Lima processes, clean state, then restart
    let _ = Command::new("colima").args(["stop"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = Command::new("sh").args(["-c", "pkill -9 -f 'limactl hostagent.*colima' 2>/dev/null; pkill -9 -f 'colima daemon' 2>/dev/null"]).status();
    std::thread::sleep(std::time::Duration::from_secs(2));
    let _ = Command::new("colima").args(["start"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    std::thread::sleep(std::time::Duration::from_secs(3));

    if test_docker_connection() { return true; }

    // Attempt 3: nuclear — delete VM and recreate (destroys containers)
    let _ = Command::new("colima").args(["delete", "-f"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    std::thread::sleep(std::time::Duration::from_secs(1));
    let _ = Command::new("colima").args(["start"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    std::thread::sleep(std::time::Duration::from_secs(3));

    test_docker_connection()
}

fn test_docker_connection() -> bool {
    let mut test = Command::new("docker");
    if let Some(sock) = colima_socket_path() {
        test.arg("--host").arg(format!("unix://{}", sock));
    }
    test.args(["ps", "--format", "{{.ID}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn docker_cmd() -> Command {
    let mut cmd = Command::new("docker");

    // Docker Desktop: standard socket, no --host needed (Unix only)
    #[cfg(unix)]
    if Path::new("/var/run/docker.sock").exists() {
        return cmd;
    }

    // Colima: use --host with the Colima socket
    if let Some(sock) = colima_socket_path() {
        cmd.arg("--host");
        cmd.arg(format!("unix://{}", sock));
    }

    cmd
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub container_id: String,
    pub container_name: String,
    pub project_id: String,
    pub project_path: String,
    pub status: String,
    pub image: String,
}

/// Tracks the active project for command isolation.
///
/// - `container_name: Some(name)` → Docker container mode (full isolation)
/// - `container_name: None`       → App-level mode (cwd clamping + virtual paths)
/// - `attached: true`             → External container (do NOT stop on project close)
#[derive(Debug, Clone)]
pub struct ActiveProject {
    pub project_id: String,
    pub project_path: String,
    pub container_name: Option<String>,
    pub attached: bool,
}

pub type ContainerMap = Mutex<HashMap<String, ContainerInfo>>;
pub type ActiveProjectState = Mutex<Option<ActiveProject>>;

const DEFAULT_IMAGE: &str = "node:20-alpine";
pub const WORKSPACE_PATH: &str = "/workspace";

/// Common dev server ports to expose on the container.
const EXPOSED_PORTS: &[u16] = &[7773, 7777, 3000, 3001, 4200, 5173, 8000, 8080, 8888];

// ─── Init ────────────────────────────────────────────────────────────────────

pub fn init_container_state() -> (ContainerMap, ActiveProjectState) {
    (Mutex::new(HashMap::new()), Mutex::new(None))
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/// Translate a host filesystem path to its equivalent inside the container.
///
/// `/Users/me/project/src` with project root `/Users/me/project`
///   → `/workspace/src`
///
/// Uses path-component comparison to prevent traversal attacks
/// (e.g. `/Users/me/project-evil` won't match `/Users/me/project`).
pub fn host_to_container_path(host_path: &str, project_path: &str) -> String {
    let hp = Path::new(host_path);
    let pp = Path::new(project_path);

    if let Ok(relative) = hp.strip_prefix(pp) {
        // Ensure forward slashes for container paths (Linux inside Docker)
        let rel_str = relative.to_string_lossy().replace('\\', "/");
        if rel_str.is_empty() {
            WORKSPACE_PATH.to_string()
        } else {
            format!("{}/{}", WORKSPACE_PATH, rel_str)
        }
    } else {
        WORKSPACE_PATH.to_string()
    }
}

/// Clamp a host path so it cannot escape the project directory.
/// If the path is outside, returns `project_path`.
///
/// Uses `Path::starts_with` which compares by path components,
/// so `/project-evil` won't match `/project`.
pub fn clamp_to_project(host_path: &str, project_path: &str) -> String {
    if Path::new(host_path).starts_with(project_path) {
        host_path.to_string()
    } else {
        project_path.to_string()
    }
}

fn container_name_for_project(project_id: &str) -> String {
    format!("tmcode-{}", project_id)
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn get_container_id(name: &str) -> Result<String, String> {
    let output = docker_cmd()
        .args(["inspect", "--format", "{{.Id}}", name])
        .output()
        .map_err(|e| format!("Failed to get container ID: {}", e))?;

    if output.status.success() {
        let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(id[..12.min(id.len())].to_string())
    } else {
        Err("Container not found".to_string())
    }
}

fn set_active(
    state: &ActiveProjectState,
    project_id: &str,
    project_path: &str,
    container_name: Option<&str>,
    attached: bool,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "Failed to lock active project")?;
    *guard = Some(ActiveProject {
        project_id: project_id.to_string(),
        project_path: project_path.to_string(),
        container_name: container_name.map(|s| s.to_string()),
        attached,
    });
    Ok(())
}

fn clear_active_if_matches(state: &ActiveProjectState, project_id: &str) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "Failed to lock active project")?;
    if let Some(ref ap) = *guard {
        if ap.project_id == project_id {
            *guard = None;
        }
    }
    Ok(())
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Check if Docker CLI is installed AND the daemon is running.
/// Uses `docker ps` as a lightweight probe — it fails fast if the
/// daemon is down, unlike `docker info` which dumps system details.
/// If Docker is unreachable but Colima is installed, automatically
/// restarts Colima to recover from stale sockets after macOS sleep/wake.
#[tauri::command]
pub async fn check_docker_available() -> Result<bool, String> {
    let result = tokio::task::spawn_blocking(|| {
        // Only CHECK if Docker is available — don't auto-start Colima.
        // The user should explicitly start Docker/Colima if they want container isolation.
        docker_cmd()
            .args(["ps", "--format", "{{.ID}}"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
    .await;

    match result {
        Ok(available) => Ok(available),
        _ => Ok(false),
    }
}

/// Activate app-level isolation for a project (no Docker).
///
/// Sets the project as active so that `execute_command` clamps cwd
/// to the project directory and the frontend shows virtual paths.
#[tauri::command]
pub async fn set_active_project(
    project_id: String,
    project_path: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    set_active(&active_project, &project_id, &project_path, None, false)
}

/// Deactivate isolation for a project.
#[tauri::command]
pub async fn clear_active_project(
    project_id: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    clear_active_if_matches(&active_project, &project_id)
}

/// Create and start a Docker container for a project.
///
/// Automatically detects `.devcontainer/devcontainer.json` and uses its
/// configuration (custom image, Dockerfile build, ports, env vars, lifecycle
/// hooks). Falls back to the default `node:20-alpine` image when no
/// devcontainer config is present.
#[tauri::command]
pub async fn create_project_container(
    app: tauri::AppHandle,
    project_id: String,
    project_path: String,
    image: Option<String>,
    container_map: State<'_, ContainerMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<ContainerInfo, String> {
    let name = container_name_for_project(&project_id);

    // ── Detect devcontainer.json ─────────────────────────────────────────
    let devconfig = devcontainer::load_devcontainer_config(&project_path);
    let has_devcontainer = devconfig.is_some();

    // ── Resolve image ────────────────────────────────────────────────────
    let img = resolve_image(&image, &devconfig, &project_path, &name).await?;

    // ── Check for existing container ─────────────────────────────────────
    if let Some(info) = try_adopt_existing(
        &name,
        &project_id,
        &project_path,
        &img,
        &container_map,
        &active_project,
    )? {
        return Ok(info);
    }

    // ── Resolve workspace folder ─────────────────────────────────────────
    let workspace = devconfig
        .as_ref()
        .and_then(|c| c.workspace_folder.clone())
        .unwrap_or_else(|| WORKSPACE_PATH.to_string());

    // ── Build docker create args ─────────────────────────────────────────
    // Resolve symlinks in project_path to prevent mounting arbitrary host dirs
    let resolved_project_path = std::fs::canonicalize(&project_path)
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;
    let resolved_project_str = resolved_project_path.to_string_lossy().to_string();

    let mut base_args: Vec<String> = vec![
        "create".into(),
        "--name".into(),
        name.clone(),
        "-v".into(),
        format!("{}:{}", resolved_project_str, workspace),
        "-w".into(),
        workspace.clone(),
        "-e".into(),
        format!("HOME={}", workspace),
        "-e".into(),
        "TERM=xterm-256color".into(),
        "--init".into(),
    ];

    // Container env vars from devcontainer.json
    if let Some(ref dc) = devconfig {
        if let Some(ref env) = dc.container_env {
            for (key, val) in env {
                base_args.push("-e".into());
                base_args.push(format!("{}={}", key, val));
            }
        }
        if let Some(ref user) = dc.remote_user {
            base_args.push("-u".into());
            base_args.push(user.clone());
        }
    }

    // Port mappings: devcontainer forwardPorts or default set
    let ports: Vec<u16> = devconfig
        .as_ref()
        .and_then(|c| c.forward_ports.clone())
        .unwrap_or_else(|| EXPOSED_PORTS.to_vec());

    let tail_args: Vec<String> = vec![
        img.clone(),
        "tail".into(),
        "-f".into(),
        "/dev/null".into(),
    ];

    // Try with port mappings; retry without on conflict
    let mut args_with_ports = base_args.clone();
    for port in &ports {
        args_with_ports.push("-p".into());
        args_with_ports.push(format!("{}:{}", port, port));
    }
    args_with_ports.extend(tail_args.clone());

    let create = docker_cmd()
        .args(&args_with_ports)
        .output()
        .map_err(|e| format!("Failed to create container: {}", e))?;

    let create_stdout = if !create.status.success() {
        let stderr = String::from_utf8_lossy(&create.stderr);

        if stderr.contains("port is already allocated")
            || stderr.contains("address already in use")
        {
            let _ = docker_cmd().args(["rm", "-f", &name]).output();

            let mut args_no_ports = base_args;
            args_no_ports.extend(tail_args);

            let retry = docker_cmd()
                .args(&args_no_ports)
                .output()
                .map_err(|e| format!("Failed to create container (retry): {}", e))?;

            if !retry.status.success() {
                return Err(format!(
                    "Failed to create container: {}",
                    String::from_utf8_lossy(&retry.stderr)
                ));
            }

            retry.stdout
        } else {
            return Err(format!("Failed to create container: {}", stderr));
        }
    } else {
        create.stdout
    };

    let raw_id = String::from_utf8_lossy(&create_stdout).trim().to_string();
    let container_id = raw_id[..12.min(raw_id.len())].to_string();

    // ── Start container ──────────────────────────────────────────────────
    let start = docker_cmd()
        .args(["start", &name])
        .output()
        .map_err(|e| format!("Failed to start container: {}", e))?;

    if !start.status.success() {
        return Err(format!(
            "Failed to start container: {}",
            String::from_utf8_lossy(&start.stderr)
        ));
    }

    // ── Post-create / post-start lifecycle hooks (background) ────────────
    let bg_name = name.clone();
    let app_handle = app.clone();
    let bg_devconfig = devconfig.clone();
    tokio::spawn(async move {
        let container = bg_name;

        // 1. Install basic tools (unless devcontainer provides its own image)
        if !has_devcontainer {
            let install_cmd = "apk add --no-cache git bash curl python3 2>/dev/null || \
                               (apt-get update -qq && apt-get install -y -qq git bash curl python3 2>/dev/null) || \
                               true";
            for attempt in 1..=2 {
                let c = container.clone();
                let cmd = install_cmd.to_string();
                let result = tokio::task::spawn_blocking(move || {
                    docker_cmd()
                        .args(["exec", &c, "sh", "-c", &cmd])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                })
                .await;
                match result {
                    Ok(Ok(s)) if s.success() => break,
                    _ if attempt < 2 => {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                    _ => {}
                }
            }
        }

        // 2. postCreateCommand
        if let Some(ref dc) = bg_devconfig {
            if let Some(ref cmd) = dc.post_create_command {
                let shell_cmd = cmd.to_shell_string();
                let c = container.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    docker_cmd()
                        .args(["exec", &c, "sh", "-c", &shell_cmd])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                })
                .await;
            }
        }

        // 3. postStartCommand
        if let Some(ref dc) = bg_devconfig {
            if let Some(ref cmd) = dc.post_start_command {
                let shell_cmd = cmd.to_shell_string();
                let c = container.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    docker_cmd()
                        .args(["exec", &c, "sh", "-c", &shell_cmd])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                })
                .await;
            }
        }

        let _ = app_handle.emit("container-tools-ready", &container);
    });

    // ── Update state ─────────────────────────────────────────────────────
    let info = ContainerInfo {
        container_id,
        container_name: name.clone(),
        project_id: project_id.clone(),
        project_path: project_path.clone(),
        status: "running".to_string(),
        image: img,
    };

    container_map
        .lock()
        .map_err(|_| "Lock error")?
        .insert(project_id.clone(), info.clone());

    set_active(&active_project, &project_id, &project_path, Some(&name), false)?;

    Ok(info)
}

// ─── Container creation helpers ──────────────────────────────────────────────

/// Resolve the Docker image to use: Dockerfile build > devcontainer image > explicit > default.
async fn resolve_image(
    explicit: &Option<String>,
    devconfig: &Option<DevcontainerConfig>,
    project_path: &str,
    container_name: &str,
) -> Result<String, String> {
    // 1. Dockerfile build (devcontainer)
    if let Some(ref dc) = devconfig {
        if let Some(ref build) = dc.build {
            let config_base = devcontainer::config_dir(project_path);
            let dockerfile = config_base.join(&build.dockerfile);

            if !dockerfile.is_file() {
                return Err(format!(
                    "Dockerfile not found: {}",
                    dockerfile.display()
                ));
            }

            let context = build
                .context
                .as_ref()
                .map(|c| config_base.join(c))
                .unwrap_or_else(|| config_base.clone());

            let tag = format!("tmcode-devcontainer-{}", container_name);

            let mut args = vec![
                "build".to_string(),
                "-f".to_string(),
                dockerfile.to_string_lossy().to_string(),
                "-t".to_string(),
                tag.clone(),
            ];

            if let Some(ref target) = build.target {
                args.push("--target".into());
                args.push(target.clone());
            }

            if let Some(ref build_args) = build.args {
                for (key, val) in build_args {
                    // Validate key is a safe identifier (prevents injection via key)
                    if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                        return Err(format!("Invalid build-arg key: {}", key));
                    }
                    // Reject values with shell metacharacters that could escape build context
                    if val.contains(';') || val.contains('|') || val.contains('`') || val.contains("$(") {
                        return Err(format!("Invalid build-arg value for {}: contains shell metacharacters", key));
                    }
                    args.push("--build-arg".into());
                    args.push(format!("{}={}", key, val));
                }
            }

            args.push(context.to_string_lossy().to_string());

            let build_result = tokio::task::spawn_blocking(move || {
                docker_cmd().args(&args).output()
            })
            .await
            .map_err(|e| format!("Build task failed: {}", e))?
            .map_err(|e| format!("Docker build failed: {}", e))?;

            if !build_result.status.success() {
                return Err(format!(
                    "Docker build failed:\n{}",
                    String::from_utf8_lossy(&build_result.stderr)
                ));
            }

            return Ok(tag);
        }
    }

    // 2. Image from devcontainer.json
    if let Some(ref dc) = devconfig {
        if let Some(ref img) = dc.image {
            return ensure_image_available(img).await;
        }
    }

    // 3. Explicit image parameter
    if let Some(ref img) = explicit {
        return ensure_image_available(img).await;
    }

    // 4. Default
    ensure_image_available(DEFAULT_IMAGE).await
}

/// Ensure a Docker image is available locally, pulling if needed.
async fn ensure_image_available(image: &str) -> Result<String, String> {
    let has_image = docker_cmd()
        .args(["image", "inspect", image])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !has_image {
        let img = image.to_string();
        let pull = tokio::task::spawn_blocking(move || {
            docker_cmd().args(["pull", &img]).output()
        })
        .await
        .map_err(|e| format!("Pull task failed: {}", e))?
        .map_err(|e| format!("Failed to pull image: {}", e))?;

        if !pull.status.success() {
            return Err(format!(
                "Failed to pull image {}: {}",
                image,
                String::from_utf8_lossy(&pull.stderr)
            ));
        }
    }

    Ok(image.to_string())
}

/// Try to adopt an existing container (running or stopped).
fn try_adopt_existing(
    name: &str,
    project_id: &str,
    project_path: &str,
    img: &str,
    container_map: &State<'_, ContainerMap>,
    active_project: &State<'_, ActiveProjectState>,
) -> Result<Option<ContainerInfo>, String> {
    let output = match docker_cmd()
        .args(["inspect", "--format", "{{.State.Status}}", name])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Ok(None),
    };

    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if status == "running" {
        let container_id = get_container_id(name).unwrap_or_default();
        let info = ContainerInfo {
            container_id,
            container_name: name.to_string(),
            project_id: project_id.to_string(),
            project_path: project_path.to_string(),
            status: "running".to_string(),
            image: img.to_string(),
        };
        container_map
            .lock()
            .map_err(|_| "Lock error")?
            .insert(project_id.to_string(), info.clone());
        set_active(active_project, project_id, project_path, Some(name), false)?;
        return Ok(Some(info));
    }

    if status == "exited" || status == "created" {
        let start = docker_cmd()
            .args(["start", name])
            .output()
            .map_err(|e| format!("Failed to start container: {}", e))?;

        if start.status.success() {
            let container_id = get_container_id(name).unwrap_or_default();
            let info = ContainerInfo {
                container_id,
                container_name: name.to_string(),
                project_id: project_id.to_string(),
                project_path: project_path.to_string(),
                status: "running".to_string(),
                image: img.to_string(),
            };
            container_map
                .lock()
                .map_err(|_| "Lock error")?
                .insert(project_id.to_string(), info.clone());
            set_active(active_project, project_id, project_path, Some(name), false)?;
            return Ok(Some(info));
        }
    }

    // Any other state — remove so we can recreate
    let _ = docker_cmd().args(["rm", "-f", name]).output();
    Ok(None)
}

/// Stop a project's Docker container gracefully (5s timeout then force).
#[tauri::command]
pub async fn stop_project_container(
    project_id: String,
    container_map: State<'_, ContainerMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<bool, String> {
    let name = container_name_for_project(&project_id);

    let stop = docker_cmd()
        .args(["stop", "-t", "5", &name])
        .output()
        .map_err(|e| format!("Failed to stop container: {}", e))?;

    if let Ok(mut map) = container_map.lock() {
        if let Some(info) = map.get_mut(&project_id) {
            info.status = "stopped".to_string();
        }
    }

    clear_active_if_matches(&active_project, &project_id)?;

    Ok(stop.status.success())
}

/// Remove a project's Docker container entirely (force kill + remove).
#[tauri::command]
pub async fn remove_project_container(
    project_id: String,
    container_map: State<'_, ContainerMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<bool, String> {
    let name = container_name_for_project(&project_id);

    let rm = docker_cmd()
        .args(["rm", "-f", &name])
        .output()
        .map_err(|e| format!("Failed to remove container: {}", e))?;

    if let Ok(mut map) = container_map.lock() {
        map.remove(&project_id);
    }

    clear_active_if_matches(&active_project, &project_id)?;

    Ok(rm.status.success())
}

/// Get the status of a project's Docker container.
#[tauri::command]
pub async fn get_container_status(
    project_id: String,
    container_map: State<'_, ContainerMap>,
) -> Result<Option<ContainerInfo>, String> {
    let map = container_map.lock().map_err(|_| "Lock error")?;
    Ok(map.get(&project_id).cloned())
}

/// Get the active container info (Docker mode only).
#[tauri::command]
pub async fn get_active_container_info(
    active_project: State<'_, ActiveProjectState>,
    container_map: State<'_, ContainerMap>,
) -> Result<Option<ContainerInfo>, String> {
    let guard = active_project.lock().map_err(|_| "Lock error")?;
    match &*guard {
        Some(ap) if ap.container_name.is_some() => {
            let map = container_map.lock().map_err(|_| "Lock error")?;
            Ok(map.get(&ap.project_id).cloned())
        }
        _ => Ok(None),
    }
}

/// Stop and remove orphaned `tmcode-*` containers from previous sessions.
///
/// Accepts an optional `exclude_project_id` so that the container for the
/// project currently being opened is NOT removed (avoids race with the
/// background Docker upgrade).
#[tauri::command]
pub async fn cleanup_orphaned_containers(
    exclude_project_id: Option<String>,
) -> Result<u32, String> {
    let output = docker_cmd()
        .args([
            "ps",
            "-a",
            "--filter",
            "name=tmcode-",
            "--format",
            "{{.Names}}",
        ])
        .output();

    let names = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Ok(0),
    };

    let exclude_name = exclude_project_id.map(|id| container_name_for_project(&id));

    let mut removed: u32 = 0;
    for name in names.lines() {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // Skip the container belonging to the project we're about to open
        if let Some(ref excl) = exclude_name {
            if name == excl {
                continue;
            }
        }
        let _ = docker_cmd()
            .args(["rm", "-f", name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        removed += 1;
    }

    Ok(removed)
}

// ─── Attach to Running Container ─────────────────────────────────────────────

/// Info about a running Docker container (for the attach picker).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
    pub created: String,
}

/// List all running Docker containers (for the "Attach" picker UI).
/// Includes all containers — the UI tags `tmcode-*` as managed.
/// Uses spawn_blocking to avoid blocking the Tauri async runtime.
#[tauri::command]
pub async fn list_running_containers() -> Result<Vec<RunningContainer>, String> {
    let result = tokio::task::spawn_blocking(|| {
        docker_cmd()
            .args([
                "ps",
                "--format",
                "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}",
            ])
            .output()
    })
    .await;

    let output = match result {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("Failed to list containers: {}", e)),
        Err(e) => return Err(format!("Task join error: {}", e)),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Docker daemon not available: {}", stderr));
    }

    let mut containers = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 6 {
            continue;
        }
        let name = parts[1].to_string();
        containers.push(RunningContainer {
            id: parts[0][..12.min(parts[0].len())].to_string(),
            name,
            image: parts[2].to_string(),
            status: parts[3].to_string(),
            ports: parts[4].to_string(),
            created: parts[5].to_string(),
        });
    }

    Ok(containers)
}

/// Attach to an existing running container.
///
/// Detects the working directory from the container's config.
/// Marks the project as `attached: true` so that tearDown does NOT
/// stop the container — it lives independently of the IDE.
#[tauri::command]
pub async fn attach_to_container(
    container_name: String,
    project_id: String,
    project_path: String,
    active_project: State<'_, ActiveProjectState>,
    container_map: State<'_, ContainerMap>,
) -> Result<ContainerInfo, String> {
    // Verify container is running
    let status_output = docker_cmd()
        .args(["inspect", "--format", "{{.State.Status}}", &container_name])
        .output()
        .map_err(|e| format!("Failed to inspect container: {}", e))?;

    if !status_output.status.success() {
        return Err(format!("Container '{}' not found", container_name));
    }

    let status = String::from_utf8_lossy(&status_output.stdout)
        .trim()
        .to_string();
    if status != "running" {
        return Err(format!(
            "Container '{}' is not running (status: {})",
            container_name, status
        ));
    }

    // Get container ID, image, and working directory
    let inspect = docker_cmd()
        .args([
            "inspect",
            "--format",
            "{{.Id}}\t{{.Config.Image}}\t{{.Config.WorkingDir}}",
            &container_name,
        ])
        .output()
        .map_err(|e| format!("Failed to inspect container: {}", e))?;

    let inspect_str = String::from_utf8_lossy(&inspect.stdout).trim().to_string();
    let parts: Vec<&str> = inspect_str.split('\t').collect();
    let container_id = parts
        .first()
        .map(|s| s[..12.min(s.len())].to_string())
        .unwrap_or_default();
    let image = parts.get(1).unwrap_or(&"unknown").to_string();
    let working_dir = parts.get(2).unwrap_or(&"").to_string();

    // Use the container's WorkingDir as project_path for path mapping.
    // If no WorkingDir set, fall back to the host project_path.
    let effective_project_path = if working_dir.is_empty() {
        project_path.clone()
    } else {
        // For attached containers, project_path is used by the frontend
        // for display. The actual cwd mapping uses the container's WorkingDir.
        project_path.clone()
    };

    let info = ContainerInfo {
        container_id,
        container_name: container_name.clone(),
        project_id: project_id.clone(),
        project_path: effective_project_path.clone(),
        status: "running".to_string(),
        image,
    };

    // Stop any previously managed tmcode-* container for this project
    let managed_name = container_name_for_project(&project_id);
    if managed_name != container_name {
        let _ = docker_cmd()
            .args(["rm", "-f", &managed_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    container_map
        .lock()
        .map_err(|_| "Lock error")?
        .insert(project_id.clone(), info.clone());

    // Mark as attached so tearDown doesn't stop the external container
    set_active(
        &active_project,
        &project_id,
        &effective_project_path,
        Some(&container_name),
        true, // attached = true
    )?;

    Ok(info)
}

/// Check if the current active project is an attached (external) container.
#[tauri::command]
pub async fn is_attached_container(
    active_project: State<'_, ActiveProjectState>,
) -> Result<bool, String> {
    let guard = active_project.lock().map_err(|_| "Lock error")?;
    Ok(guard.as_ref().map(|ap| ap.attached).unwrap_or(false))
}
