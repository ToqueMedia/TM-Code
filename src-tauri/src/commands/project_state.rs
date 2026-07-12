use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{canonicalize_path, normalize_path_for_frontend};

const APP_STATE_DIR: &str = ".toquemedia-studio";
const PROJECTS_DIR: &str = "projects";
const PROJECT_ID_FILE: &str = ".toquemedia-id";
const AGENT_STATUS_FILE: &str = "agent-status.json";

const MIGRATE_DIRS: &[&str] = &["sessions", "checkpoints", "collab", "memory"];
const MIGRATE_FILES: &[&str] = &[
    "editor-state.json",
    "permissions.json",
    "tasks.json",
    "http-client.json",
    "deploy-state.json",
];

fn validate_project_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err(format!("Invalid project id length: {}", id.len()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("Invalid project id: {}", id));
    }
    if id.starts_with('.') || id.contains("..") {
        return Err(format!("Invalid project id: {}", id));
    }
    Ok(())
}

pub(crate) fn ensure_project_id(project_path: &Path) -> Result<String, String> {
    let id_path = project_path.join(PROJECT_ID_FILE);
    if id_path.exists() {
        let id = std::fs::read_to_string(&id_path)
            .map_err(|e| format!("Failed to read .toquemedia-id: {}", e))?;
        let id = id.trim().to_string();
        validate_project_id(&id)?;
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    std::fs::write(&id_path, &id).map_err(|e| format!("Failed to create .toquemedia-id: {}", e))?;
    Ok(id)
}

fn state_base_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(dirs::data_local_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
            .join("TM Code"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(dirs::home_dir()
            .ok_or_else(|| "Failed to resolve home directory".to_string())?
            .join(APP_STATE_DIR))
    }
}

pub(crate) fn project_state_root(project_path: &str) -> Result<PathBuf, String> {
    let project = Path::new(project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical =
        canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;
    let project_id = ensure_project_id(&canonical)?;
    Ok(state_base_dir()?.join(PROJECTS_DIR).join(project_id))
}

/// Read-only variant of `project_state_root`: resolves the state dir ONLY if
/// the project already has a `.toquemedia-id`. Never creates the id file or
/// the state dir — listing recents (agent-status polling) must not leave
/// side effects in projects the user merely has in the sidebar.
pub(crate) fn project_state_root_readonly(project_path: &str) -> Option<PathBuf> {
    let project = Path::new(project_path);
    if !project.is_dir() {
        return None;
    }
    let canonical = canonicalize_path(project).ok()?;
    let id = std::fs::read_to_string(canonical.join(PROJECT_ID_FILE)).ok()?;
    let id = id.trim().to_string();
    validate_project_id(&id).ok()?;
    Some(state_base_dir().ok()?.join(PROJECTS_DIR).join(id))
}

pub(crate) fn legacy_project_state_dir(project_path: &str) -> Result<PathBuf, String> {
    let project = Path::new(project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical =
        canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;
    Ok(canonical.join(".toquemedia"))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("Failed to create {:?}: {}", dst, e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Failed to read {:?}: {}", src, e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry in {:?}: {}", src, e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let ty = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {:?}: {}", src_path, e))?;
        if ty.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if ty.is_file() {
            if dst_path.exists() {
                continue;
            }
            if let Some(parent) = dst_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create {:?}: {}", parent, e))?;
            }
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {:?} to {:?}: {}", src_path, dst_path, e))?;
        }
    }
    Ok(())
}

fn copy_file_if_present(src: &Path, dst: &Path) -> Result<bool, String> {
    if !src.exists() {
        return Ok(false);
    }
    if dst.exists() {
        return Ok(true);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {:?}: {}", parent, e))?;
    }
    std::fs::copy(src, dst).map_err(|e| format!("Failed to copy {:?} to {:?}: {}", src, dst, e))?;
    Ok(true)
}

fn remove_legacy_dir_if_empty(dir: &Path) {
    let Ok(mut entries) = std::fs::read_dir(dir) else {
        return;
    };
    if entries.next().is_none() {
        let _ = std::fs::remove_dir(dir);
    }
}

#[tauri::command]
pub async fn get_project_state_dir(project_path: String) -> Result<String, String> {
    let root = project_state_root(&project_path)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;
    Ok(normalize_path_for_frontend(&root))
}

#[tauri::command]
pub async fn migrate_project_state(project_path: String) -> Result<(), String> {
    let root = project_state_root(&project_path)?;
    let legacy = legacy_project_state_dir(&project_path)?;
    if !legacy.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;

    for name in MIGRATE_DIRS {
        let src = legacy.join(name);
        if !src.exists() {
            continue;
        }
        let dst = root.join(name);
        copy_dir_recursive(&src, &dst)?;
        std::fs::remove_dir_all(&src)
            .map_err(|e| format!("Failed to remove migrated {:?}: {}", src, e))?;
    }

    for name in MIGRATE_FILES {
        let src = legacy.join(name);
        let dst = root.join(name);
        if copy_file_if_present(&src, &dst)? {
            std::fs::remove_file(&src)
                .map_err(|e| format!("Failed to remove migrated {:?}: {}", src, e))?;
        }
    }

    let gitignore = legacy.join(".gitignore");
    if gitignore.exists() {
        let _ = std::fs::remove_file(&gitignore);
    }
    remove_legacy_dir_if_empty(&legacy);
    Ok(())
}

// ─── Agent run status (per-project, cross-process) ──────────────────────────
//
// Multi-window parallel work: each TM Code window is an independent OS
// process (see lib.rs `open_new_instance`), so the only channel other windows
// have to learn "the agent is working on project X" is disk. The window
// running the agent mirrors its run state into `agent-status.json` inside the
// project's app-managed state dir; every window polls it to render the badge
// in the recents lists.
//
// Liveness contract: `updated_at` doubles as a heartbeat. A `running` entry
// older than the frontend staleness window (PROJECT_AGENT_STATUS_STALE_MS)
// means the writer crashed and readers ignore it. `done`/`error` persist
// until acknowledged (frontend writes `idle`) or until the owning window
// closes gracefully (WindowEvent::Destroyed calls
// `clear_project_agent_status`).

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentStatus {
    /// "running" | "done" | "error" | "idle"
    pub state: String,
    /// Short excerpt of the task (last user message) for the badge tooltip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Epoch ms of the last write — heartbeat for `running`.
    pub updated_at: u64,
    /// PID of the writing process (diagnostics; readers key off updated_at).
    pub pid: u32,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn set_project_agent_status(
    project_path: String,
    state: String,
    label: Option<String>,
) -> Result<(), String> {
    if !matches!(state.as_str(), "running" | "done" | "error" | "idle") {
        return Err(format!("Invalid agent status state: {}", state));
    }
    let root = project_state_root(&project_path)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;
    let status = ProjectAgentStatus {
        state,
        label,
        updated_at: now_ms(),
        pid: std::process::id(),
    };
    let json = serde_json::to_string(&status)
        .map_err(|e| format!("Failed to serialize agent status: {}", e))?;
    // temp + rename: readers in OTHER processes poll this file — they must
    // never observe a torn write (a parse failure reads as "no status").
    let tmp = root.join(format!(".agent-status.tmp-{}", std::process::id()));
    std::fs::write(&tmp, &json).map_err(|e| format!("Failed to write agent status: {}", e))?;
    std::fs::rename(&tmp, root.join(AGENT_STATUS_FILE))
        .map_err(|e| format!("Failed to publish agent status: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn get_project_agent_statuses(
    project_paths: Vec<String>,
) -> Result<std::collections::HashMap<String, ProjectAgentStatus>, String> {
    let mut out = std::collections::HashMap::new();
    for path in project_paths {
        let Some(root) = project_state_root_readonly(&path) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(root.join(AGENT_STATUS_FILE)) else {
            continue;
        };
        if let Ok(status) = serde_json::from_str::<ProjectAgentStatus>(&content) {
            // Keyed by the caller's path string (not canonical) so the
            // frontend can match against its own recents entries directly.
            out.insert(path, status);
        }
    }
    Ok(out)
}

/// Best-effort removal of the status file — called from the
/// WindowEvent::Destroyed handler. Once this process dies nothing can
/// heartbeat the file, so an explicit remove beats making every other window
/// wait out the reader-side staleness timeout.
pub(crate) fn clear_project_agent_status(project_path: &str) {
    if let Some(root) = project_state_root_readonly(project_path) {
        let _ = std::fs::remove_file(root.join(AGENT_STATUS_FILE));
    }
}
