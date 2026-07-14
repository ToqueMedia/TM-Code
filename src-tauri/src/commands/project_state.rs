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
    /// Task title for the tree row. The frontend anchors this to the
    /// session's FIRST user message (or the user's manual rename) — it must
    /// stay stable for the whole run, never drift with later messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Optional user-written task description (session metadata) — shown as
    /// the row tooltip in other windows. Absent on files written before
    /// 2026-07-14.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Epoch ms of the last write — heartbeat for `running`.
    pub updated_at: u64,
    /// Epoch ms when the run STARTED (set on `running` writes, preserved by
    /// heartbeats) — lets other windows show "a trabalhar · 12m". Optional
    /// for backwards compat with files written before 2026-07-13.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    /// PID of the writing process (diagnostics; readers key off updated_at).
    pub pid: u32,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Monotonic suffix for state temp files: two concurrent invokes from the
/// SAME process (heartbeat tick + run-end transition) must never share a
/// temp path, or one write could truncate the other's inode mid-publish.
static STATE_FILE_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub async fn set_project_agent_status(
    project_path: String,
    state: String,
    label: Option<String>,
    only_if_own: Option<bool>,
    started_at: Option<u64>,
    description: Option<String>,
) -> Result<(), String> {
    if !matches!(state.as_str(), "running" | "done" | "error" | "idle") {
        return Err(format!("Invalid agent status state: {}", state));
    }
    let root = project_state_root(&project_path)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;

    // only_if_own: "only touch state this process owns". Used by the
    // frontend's idle-clears so a window leaving a project never stamps
    // over the truthful badge of ANOTHER window that has the same project
    // open and running. No file (nothing owned) → skip too, instead of
    // materialising a noise `idle` file.
    if only_if_own == Some(true) {
        let Ok(existing) = std::fs::read_to_string(root.join(AGENT_STATUS_FILE)) else {
            return Ok(());
        };
        match serde_json::from_str::<ProjectAgentStatus>(&existing) {
            Ok(prev) if prev.pid != std::process::id() => return Ok(()),
            _ => {}
        }
    }

    let status = ProjectAgentStatus {
        state,
        label,
        description,
        updated_at: now_ms(),
        started_at,
        pid: std::process::id(),
    };
    let json = serde_json::to_string(&status)
        .map_err(|e| format!("Failed to serialize agent status: {}", e))?;
    // temp + rename: readers in OTHER processes poll this file — they must
    // never observe a torn write (a parse failure reads as "no status").
    let seq = STATE_FILE_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = root.join(format!(
        ".agent-status.tmp-{}-{}",
        std::process::id(),
        seq
    ));
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

// ─── Project window lock (double-open guard, cross-process) ─────────────────
//
// One project open in TWO windows means two processes over the same state
// dir (sessions last-write-wins) and two agents over the same working tree.
// The owning window heartbeats `window-lock.json`; openProject consults
// `check_project_window_lock` and WARNS before opening a project whose lock
// is fresh and foreign. Deliberately a warning, not a hard lock: a rigid
// lock surviving a crash would strand the user out of their own project —
// the frontend's staleness window (same 90s as the agent badge) arbitrates
// dead owners, and `WindowEvent::Destroyed` releases on graceful close.

const WINDOW_LOCK_FILE: &str = "window-lock.json";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWindowLock {
    pub pid: u32,
    /// Epoch ms of the last heartbeat — liveness signal for readers.
    pub updated_at: u64,
}

#[tauri::command]
pub async fn acquire_project_window_lock(project_path: String) -> Result<(), String> {
    let root = project_state_root(&project_path)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;
    let lock = ProjectWindowLock {
        pid: std::process::id(),
        updated_at: now_ms(),
    };
    let json = serde_json::to_string(&lock)
        .map_err(|e| format!("Failed to serialize window lock: {}", e))?;
    let seq = STATE_FILE_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = root.join(format!(".window-lock.tmp-{}-{}", std::process::id(), seq));
    std::fs::write(&tmp, &json).map_err(|e| format!("Failed to write window lock: {}", e))?;
    std::fs::rename(&tmp, root.join(WINDOW_LOCK_FILE))
        .map_err(|e| format!("Failed to publish window lock: {}", e))?;
    Ok(())
}

/// Returns the lock ONLY when it belongs to ANOTHER process — the caller
/// asks "is somebody ELSE here?", so an own/absent/unreadable lock is None.
/// Freshness is the frontend's call (staleness window shared with the badge).
#[tauri::command]
pub async fn check_project_window_lock(
    project_path: String,
) -> Result<Option<ProjectWindowLock>, String> {
    let Some(root) = project_state_root_readonly(&project_path) else {
        return Ok(None);
    };
    let Ok(content) = std::fs::read_to_string(root.join(WINDOW_LOCK_FILE)) else {
        return Ok(None);
    };
    match serde_json::from_str::<ProjectWindowLock>(&content) {
        Ok(lock) if lock.pid != std::process::id() => Ok(Some(lock)),
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn release_project_window_lock(project_path: String) -> Result<(), String> {
    release_project_window_lock_owned(&project_path);
    Ok(())
}

/// Ownership-aware removal — shared with the WindowEvent::Destroyed handler.
/// A foreign lock (another window still on this project) is left alone; an
/// unparseable one is removed (torn garbage helps nobody).
pub(crate) fn release_project_window_lock_owned(project_path: &str) {
    if let Some(root) = project_state_root_readonly(project_path) {
        let file = root.join(WINDOW_LOCK_FILE);
        if let Ok(existing) = std::fs::read_to_string(&file) {
            if let Ok(lock) = serde_json::from_str::<ProjectWindowLock>(&existing) {
                if lock.pid != std::process::id() {
                    return;
                }
            }
            let _ = std::fs::remove_file(file);
        }
    }
}

/// Best-effort removal of the status file — called from the
/// WindowEvent::Destroyed handler. Once this process dies nothing can
/// heartbeat the file, so an explicit remove beats making every other window
/// wait out the reader-side staleness timeout.
///
/// Ownership-aware: if the file was written by ANOTHER (possibly live)
/// process — two windows on the same project — leave it alone; removing it
/// would erase their truthful badge. An unparseable file is removed (torn
/// garbage helps nobody).
pub(crate) fn clear_project_agent_status(project_path: &str) {
    if let Some(root) = project_state_root_readonly(project_path) {
        let file = root.join(AGENT_STATUS_FILE);
        if let Ok(existing) = std::fs::read_to_string(&file) {
            if let Ok(prev) = serde_json::from_str::<ProjectAgentStatus>(&existing) {
                if prev.pid != std::process::id() {
                    return;
                }
            }
            let _ = std::fs::remove_file(file);
        }
    }
}
