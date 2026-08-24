use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{canonicalize_path, normalize_path_for_frontend};

const APP_STATE_DIR: &str = ".tmcode";
const LEGACY_APP_STATE_DIR: &str = ".toquemedia-studio";
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

/// Marker de RESTAURO de identidade (2026-07-17): o `.toquemedia-id` é um
/// ficheiro untracked na raiz do projecto — `git clean -fd` (no PTY, ou de
/// qualquer ferramenta externa), rsync ou eliminação manual apagam-no, e a
/// versão antiga cunhava um id NOVO no arranque seguinte: todo o estado
/// (sessões, permissões, memória, tarefas) bifurcava para uma pasta nova
/// ("split-brain" — visto em produção com TRÊS identidades num só dia).
/// Cada state dir guarda o caminho canónico do dono neste marker; quando o
/// id falta no projecto, procuramos um state dir que reclame o caminho e
/// RESTAURAMOS o id antigo em vez de cunhar um novo.
const PROJECT_PATH_MARKER: &str = "project-path.txt";

fn write_project_path_marker(id: &str, canonical: &Path) {
    let Ok(base) = state_base_dir() else { return };
    let dir = base.join(PROJECTS_DIR).join(id);
    let marker = dir.join(PROJECT_PATH_MARKER);
    let want = canonical.to_string_lossy().to_string();
    // Idempotente e barato: só escreve quando falta ou mudou (o ensure corre
    // em todas as resoluções de estado).
    if std::fs::read_to_string(&marker)
        .map(|s| s.trim() == want)
        .unwrap_or(false)
    {
        return;
    }
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(&marker, want.as_bytes());
    }
}

fn restore_project_id_from_markers(canonical: &Path) -> Option<String> {
    let projects = state_base_dir().ok()?.join(PROJECTS_DIR);
    let want = canonical.to_string_lossy().to_string();
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if validate_project_id(&id).is_err() {
            continue;
        }
        let Ok(stored) = std::fs::read_to_string(dir.join(PROJECT_PATH_MARKER)) else {
            continue;
        };
        if stored.trim() != want {
            continue;
        }
        // Vários candidatos (não devia acontecer, mas o passado provou que
        // acontece): ganha o state dir com atividade mais recente.
        let mtime = std::fs::metadata(&dir)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, id));
        }
    }
    best.map(|(_, id)| id)
}

pub(crate) fn ensure_project_id(project_path: &Path) -> Result<String, String> {
    let id_path = project_path.join(PROJECT_ID_FILE);
    if id_path.exists() {
        let id = std::fs::read_to_string(&id_path)
            .map_err(|e| format!("Failed to read .toquemedia-id: {}", e))?;
        let id = id.trim().to_string();
        validate_project_id(&id)?;
        // Auto-heal: state dirs anteriores ao marker ganham-no na primeira
        // resolução — a partir daí a identidade é restaurável.
        write_project_path_marker(&id, project_path);
        return Ok(id);
    }

    // Id em falta: RESTAURAR antes de cunhar — cunhar um novo com estado
    // antigo em disco é perder sessões/permissões/memória do user.
    if let Some(id) = restore_project_id_from_markers(project_path) {
        std::fs::write(&id_path, &id)
            .map_err(|e| format!("Failed to restore .toquemedia-id: {}", e))?;
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    std::fs::write(&id_path, &id).map_err(|e| format!("Failed to create .toquemedia-id: {}", e))?;
    write_project_path_marker(&id, project_path);
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
        let home = dirs::home_dir()
            .ok_or_else(|| "Failed to resolve home directory".to_string())?;
        let current = home.join(APP_STATE_DIR);
        let legacy = home.join(LEGACY_APP_STATE_DIR);
        // One-shot: take over ~/.toquemedia-studio so sessions/checkpoints
        // keep working under ~/.tmcode. Leave the old name if rename fails
        // (e.g. both dirs already exist) — readers still prefer .tmcode.
        if !current.exists() && legacy.exists() {
            let _ = std::fs::rename(&legacy, &current);
        }
        Ok(current)
    }
}

/// Um caminho DENTRO de `.toquemedia/worktrees/<name>` (worktree de tarefa
/// paralela) pertence ao PROJECTO dono — resolver identidade com a raiz do
/// worktree cunhava um `.toquemedia-id` novo lá dentro e bifurcava o estado
/// (sessões/permissões/memória iam para uma pasta paralela que a app nunca
/// lê; visto em produção 2026-07-17). Normaliza ANTES de qualquer id.
pub(crate) fn strip_worktree_suffix(project_path: &str) -> String {
    let normalized = project_path.replace('\\', "/");
    match normalized.find("/.toquemedia/worktrees/") {
        Some(idx) => normalized[..idx].to_string(),
        None => project_path.to_string(),
    }
}

pub(crate) fn project_state_root(project_path: &str) -> Result<PathBuf, String> {
    let project_path = &strip_worktree_suffix(project_path);
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
    let project_path = &strip_worktree_suffix(project_path);
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
    let tmp = root.join(format!(".agent-status.tmp-{}-{}", std::process::id(), seq));
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

// ─── Cross-window focus request ─────────────────────────────────────────────
//
// Multi-window residual 10/10: when the user clicks a project whose agent is
// running in ANOTHER process, we write a focus-request the owner consumes on
// its next heartbeat (≤3s focused / ≤30s background) and brings its window
// to the front. Disk-only bus — same doctrine as agent-status / stop-requests.

const FOCUS_REQUEST_FILE: &str = "focus-request.json";
/// Drop requests older than this (ms) so a dead requester cannot keep
/// re-focusing the owner forever.
const FOCUS_REQUEST_STALE_MS: u64 = 15_000;
/// A `running` badge only counts as a live focus target while its writer
/// heartbeats (3s focused / 30s background) — same ceiling the readers use.
const FOCUS_RUNNING_FRESH_MS: u64 = 90_000;
/// Terminal badges (`done`/`error`) are frozen at run end — no heartbeat
/// proves the owner is alive. Only target them while recent enough that
/// "go back to the window that finished the run" is still the likely
/// intent. Beyond this, a click must OPEN locally instead of being
/// swallowed targeting a dead/restarted pid (the "two clicks to switch"
/// report: every badge written by a previous app instance had a foreign
/// pid and swallowed the first click forever).
const FOCUS_TERMINAL_FRESH_MS: u64 = 10 * 60_000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFocusRequest {
    pub target_pid: u32,
    pub requester_pid: u32,
    pub requested_at: u64,
}

/// PID of THIS app instance. Each TM Code window is an independent OS
/// process, so the pid uniquely identifies the window; the frontend caches
/// it to tell self-owned agent badges from foreign ones WITHOUT an IPC
/// round-trip on every project click (instant in-window switching).
#[tauri::command]
pub fn get_app_pid() -> u32 {
    std::process::id()
}

/// Ask the window that owns `agent-status.json` (or the window lock) for this
/// project to come to the front. Returns Ok(true) when a foreign live owner
/// was targeted, Ok(false) when there is no foreign owner (caller may open
/// locally).
#[tauri::command]
pub async fn request_project_window_focus(project_path: String) -> Result<bool, String> {
    let Some(root) = project_state_root_readonly(&project_path) else {
        return Ok(false);
    };
    let self_pid = std::process::id();
    let mut target_pid: Option<u32> = None;

    if let Ok(content) = std::fs::read_to_string(root.join(AGENT_STATUS_FILE)) {
        if let Ok(status) = serde_json::from_str::<ProjectAgentStatus>(&content) {
            if status.pid != self_pid {
                // Freshness gate (2026-08-22): a badge whose writer can no
                // longer prove liveness must not swallow the click — focus
                // requests aimed at dead pids are never consumed and the
                // user was forced into the second-click fallback.
                let fresh = match status.state.as_str() {
                    "running" => now_ms().saturating_sub(status.updated_at) <= FOCUS_RUNNING_FRESH_MS,
                    "done" | "error" => {
                        now_ms().saturating_sub(status.updated_at) <= FOCUS_TERMINAL_FRESH_MS
                    }
                    _ => false,
                };
                if fresh {
                    target_pid = Some(status.pid);
                }
            }
        }
    }
    if target_pid.is_none() {
        if let Ok(content) = std::fs::read_to_string(root.join(WINDOW_LOCK_FILE)) {
            if let Ok(lock) = serde_json::from_str::<ProjectWindowLock>(&content) {
                // Same staleness ceiling the JS reader applies (90s): a lock
                // from a crashed process must not count as a live owner.
                if lock.pid != self_pid
                    && now_ms().saturating_sub(lock.updated_at) <= FOCUS_RUNNING_FRESH_MS
                {
                    target_pid = Some(lock.pid);
                }
            }
        }
    }
    let Some(target) = target_pid else {
        return Ok(false);
    };

    let root = project_state_root(&project_path)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;
    let req = ProjectFocusRequest {
        target_pid: target,
        requester_pid: self_pid,
        requested_at: now_ms(),
    };
    let json = serde_json::to_string(&req)
        .map_err(|e| format!("Failed to serialize focus request: {}", e))?;
    let seq = STATE_FILE_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = root.join(format!(".focus-request.tmp-{}-{}", self_pid, seq));
    std::fs::write(&tmp, &json).map_err(|e| format!("Failed to write focus request: {}", e))?;
    std::fs::rename(&tmp, root.join(FOCUS_REQUEST_FILE))
        .map_err(|e| format!("Failed to publish focus request: {}", e))?;
    Ok(true)
}

/// Consume a pending focus request aimed at THIS process. Returns true when
/// the caller should bring its main window to the front.
#[tauri::command]
pub async fn take_project_window_focus_request(project_path: String) -> Result<bool, String> {
    let Some(root) = project_state_root_readonly(&project_path) else {
        return Ok(false);
    };
    let file = root.join(FOCUS_REQUEST_FILE);
    let Ok(content) = std::fs::read_to_string(&file) else {
        return Ok(false);
    };
    let Ok(req) = serde_json::from_str::<ProjectFocusRequest>(&content) else {
        let _ = std::fs::remove_file(&file);
        return Ok(false);
    };
    let self_pid = std::process::id();
    let age = now_ms().saturating_sub(req.requested_at);
    if req.target_pid != self_pid || age > FOCUS_REQUEST_STALE_MS {
        // Not for us, or stale — leave foreign requests alone; drop stale own
        // targets so they don't stick forever.
        if req.target_pid == self_pid {
            let _ = std::fs::remove_file(&file);
        }
        return Ok(false);
    }
    let _ = std::fs::remove_file(&file);
    Ok(true)
}
