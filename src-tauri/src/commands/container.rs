use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, State};

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
#[derive(Debug, Clone)]
pub struct ActiveProject {
    pub project_id: String,
    pub project_path: String,
    pub container_name: Option<String>,
}

pub type ContainerMap = Mutex<HashMap<String, ContainerInfo>>;
pub type ActiveProjectState = Mutex<Option<ActiveProject>>;

const DEFAULT_IMAGE: &str = "node:20-alpine";
pub const WORKSPACE_PATH: &str = "/workspace";

/// Common dev server ports to expose on the container.
const EXPOSED_PORTS: &[u16] = &[3000, 3001, 4200, 5173, 5174, 8000, 8080, 8888];

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
        let rel_str = relative.to_string_lossy();
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
    let output = Command::new("docker")
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
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "Failed to lock active project")?;
    *guard = Some(ActiveProject {
        project_id: project_id.to_string(),
        project_path: project_path.to_string(),
        container_name: container_name.map(|s| s.to_string()),
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
#[tauri::command]
pub async fn check_docker_available() -> Result<bool, String> {
    let result = tokio::task::spawn_blocking(|| {
        Command::new("docker")
            .args(["ps", "--format", "{{.ID}}"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    })
    .await;

    match result {
        Ok(Ok(s)) => Ok(s.success()),
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
    set_active(&active_project, &project_id, &project_path, None)
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
/// - Mounts the project directory at `/workspace`
/// - Exposes common dev server ports
/// - Sets the project as active with Docker routing
/// - Installs basic dev tools in the background (git, bash, curl)
#[tauri::command]
pub async fn create_project_container(
    app: tauri::AppHandle,
    project_id: String,
    project_path: String,
    image: Option<String>,
    container_map: State<'_, ContainerMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<ContainerInfo, String> {
    let img = image.unwrap_or_else(|| DEFAULT_IMAGE.to_string());
    let name = container_name_for_project(&project_id);

    // ── Check for existing container ─────────────────────────────────────
    if let Ok(output) = Command::new("docker")
        .args(["inspect", "--format", "{{.State.Status}}", &name])
        .output()
    {
        if output.status.success() {
            let status = String::from_utf8_lossy(&output.stdout).trim().to_string();

            if status == "running" {
                let container_id = get_container_id(&name).unwrap_or_default();
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

                set_active(&active_project, &project_id, &project_path, Some(&name))?;
                return Ok(info);
            }

            if status == "exited" || status == "created" {
                let start = Command::new("docker")
                    .args(["start", &name])
                    .output()
                    .map_err(|e| format!("Failed to start existing container: {}", e))?;

                if start.status.success() {
                    let container_id = get_container_id(&name).unwrap_or_default();
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

                    set_active(&active_project, &project_id, &project_path, Some(&name))?;
                    return Ok(info);
                }
            }

            let _ = Command::new("docker").args(["rm", "-f", &name]).output();
        }
    }

    // ── Ensure image is available (non-blocking pull) ──────────────────
    let has_image = Command::new("docker")
        .args(["image", "inspect", &img])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !has_image {
        // Pull in a blocking task so the Tauri async runtime isn't starved.
        let img_clone = img.clone();
        let pull_result = tokio::task::spawn_blocking(move || {
            Command::new("docker")
                .args(["pull", &img_clone])
                .output()
        })
        .await
        .map_err(|e| format!("Pull task failed: {}", e))?
        .map_err(|e| format!("Failed to pull image: {}", e))?;

        if !pull_result.status.success() {
            return Err(format!(
                "Failed to pull image {}: {}",
                img,
                String::from_utf8_lossy(&pull_result.stderr)
            ));
        }
    }

    // ── Create container ─────────────────────────────────────────────────
    let base_args: Vec<String> = vec![
        "create".into(),
        "--name".into(),
        name.clone(),
        "-v".into(),
        format!("{}:{}", project_path, WORKSPACE_PATH),
        "-w".into(),
        WORKSPACE_PATH.into(),
        "-e".into(),
        format!("HOME={}", WORKSPACE_PATH),
        "-e".into(),
        "TERM=xterm-256color".into(),
        "--init".into(),
    ];

    let tail_args: Vec<String> = vec![
        img.clone(),
        "tail".into(),
        "-f".into(),
        "/dev/null".into(),
    ];

    // Try with port mappings first; if any port is busy, retry without.
    let mut args_with_ports = base_args.clone();
    for port in EXPOSED_PORTS {
        args_with_ports.push("-p".into());
        args_with_ports.push(format!("{}:{}", port, port));
    }
    args_with_ports.extend(tail_args.clone());

    let create = Command::new("docker")
        .args(&args_with_ports)
        .output()
        .map_err(|e| format!("Failed to create container: {}", e))?;

    let create_stdout = if !create.status.success() {
        let stderr = String::from_utf8_lossy(&create.stderr);

        // Port conflict → retry without port bindings
        if stderr.contains("port is already allocated") || stderr.contains("address already in use")
        {
            let _ = Command::new("docker").args(["rm", "-f", &name]).output();

            let mut args_no_ports = base_args;
            args_no_ports.extend(tail_args);

            let retry = Command::new("docker")
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
    let start = Command::new("docker")
        .args(["start", &name])
        .output()
        .map_err(|e| format!("Failed to start container: {}", e))?;

    if !start.status.success() {
        return Err(format!(
            "Failed to start container: {}",
            String::from_utf8_lossy(&start.stderr)
        ));
    }

    // ── Install common dev tools in background with retry ───────────────
    let bg_name = name.clone();
    let app_handle = app.clone();
    tokio::spawn(async move {
        let container = bg_name;
        let install_cmd = "apk add --no-cache git bash curl python3 2>/dev/null || \
                           (apt-get update -qq && apt-get install -y -qq git bash curl python3 2>/dev/null) || \
                           true";

        for attempt in 1..=2 {
            let c = container.clone();
            let cmd = install_cmd.to_string();
            let result = tokio::task::spawn_blocking(move || {
                Command::new("docker")
                    .args(["exec", &c, "sh", "-c", &cmd])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
            })
            .await;

            match result {
                Ok(Ok(status)) if status.success() => {
                    let _ = app_handle.emit("container-tools-ready", &container);
                    return;
                }
                _ if attempt < 2 => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                _ => {
                    let _ = app_handle.emit("container-tools-failed", &container);
                }
            }
        }
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

    set_active(&active_project, &project_id, &project_path, Some(&name))?;

    Ok(info)
}

/// Stop a project's Docker container gracefully (5s timeout then force).
#[tauri::command]
pub async fn stop_project_container(
    project_id: String,
    container_map: State<'_, ContainerMap>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<bool, String> {
    let name = container_name_for_project(&project_id);

    let stop = Command::new("docker")
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

    let rm = Command::new("docker")
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
    let output = Command::new("docker")
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
        let _ = Command::new("docker")
            .args(["rm", "-f", name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        removed += 1;
    }

    Ok(removed)
}
