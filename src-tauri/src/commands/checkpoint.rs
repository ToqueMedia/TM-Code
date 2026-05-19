use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::canonicalize_path;

/// Metadata about a single checkpoint.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointMeta {
    pub id: String,
    pub session_id: String,
    pub timestamp: u64,
    pub tool_call_id: String,
    pub tool_name: String,
    pub description: String,
    pub files: Vec<CheckpointFileMeta>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileMeta {
    pub file_path: String,
    pub file_path_hash: String,
    pub operation: String, // "write" | "create" | "delete" | "rename"
    /// `true` when `content_before` was null (file didn't exist before).
    pub was_new: bool,
    /// For rename operations: the new path after renaming.
    pub new_path: Option<String>,
}

/// Baseline entry: points to the checkpoint that holds the original content.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct BaselineEntry {
    pub checkpoint_id: String,
    pub file_path_hash: String,
    pub was_new: bool,
}

/// Full index stored per session.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct CheckpointIndex {
    pub checkpoints: Vec<CheckpointMeta>,
    /// Session baseline: filePath → pointer to the checkpoint snapshot.
    #[serde(default)]
    pub baseline: std::collections::HashMap<String, BaselineEntry>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
//
// Checkpoints live INSIDE the project at `<project>/.toquemedia/checkpoints/`
// (migrated 2026-05 from `~/.toquemedia-studio/checkpoints/{projectHash}/`).
//
// Why move into the project:
//   - Travels with the project. Move/zip/copy the folder → checkpoints come too.
//     The legacy home-dir tree was keyed by project_hash, so a project moved
//     to another machine effectively lost its checkpoints (the hash on the
//     new machine differed).
//   - Project-scoped lifetime. Project deletion automatically clears its
//     checkpoints — no orphans accumulating in `~/.toquemedia-studio/`.
//   - Inspectable / debuggable. Developer can look at the snapshot files
//     directly without spelunking through a hashed home-dir tree.
//
// Each session still gets its own subdirectory under
// `.toquemedia/checkpoints/<sessionId>/`. Snapshot files live under
// `.toquemedia/checkpoints/<sessionId>/files/<checkpointId>/`.
//
// The `.toquemedia/checkpoints/` directory is gitignored by default
// (see `ensure_toquemedia_gitignore`) — snapshots are throwaway recovery
// state, not source of truth.

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err(format!("Invalid session id length: {}", session_id.len()));
    }
    if !session_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("Invalid session id characters: {}", session_id));
    }
    if session_id.starts_with('.') || session_id.contains("..") {
        return Err(format!("Session id cannot start with . or contain .. ({})", session_id));
    }
    Ok(())
}

fn validate_checkpoint_id(checkpoint_id: &str) -> Result<(), String> {
    // Same shape as session_id — alphanum + - _ . only, no path traversal.
    validate_session_id(checkpoint_id).map_err(|e| e.replace("session id", "checkpoint id"))
}

fn validate_file_path_hash(hash: &str) -> Result<(), String> {
    if hash.is_empty() || hash.len() > 128 {
        return Err(format!("Invalid file path hash length: {}", hash.len()));
    }
    // Hex / base64url-ish — alphanum + - _ . only.
    if !hash.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid file path hash characters: {}", hash));
    }
    Ok(())
}

fn checkpoints_root(project_path: &str) -> Result<PathBuf, String> {
    let project = Path::new(project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical = canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;
    let dir = canonical.join(".toquemedia").join("checkpoints");
    if !dir.starts_with(&canonical) {
        return Err("Resolved checkpoints path escapes project root".to_string());
    }
    Ok(dir)
}

fn session_dir(project_path: &str, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(checkpoints_root(project_path)?.join(session_id))
}

fn file_dir(
    project_path: &str,
    session_id: &str,
    checkpoint_id: &str,
) -> Result<PathBuf, String> {
    validate_checkpoint_id(checkpoint_id)?;
    Ok(session_dir(project_path, session_id)?
        .join("files")
        .join(checkpoint_id))
}

/// Ensure `<project>/.toquemedia/.gitignore` exists and contains all
/// entries that must NOT be committed to git: throwaway recovery state
/// (checkpoints/) plus per-conversation history that may contain sensitive
/// prompts or pasted code (sessions/, queue-operations.jsonl).
///
/// Idempotent — checks each entry independently before appending, so it's
/// safe to call on every save without growing the file. Best-effort:
/// failures are logged at the call site, never break the save.
///
/// Files that ARE committable (tasks.json, permissions.json,
/// http-client.json) intentionally do NOT appear here — they're project
/// context that should travel via git the same way as PLAN.md / TODO.md.
async fn ensure_toquemedia_gitignore(project_path: &str) -> Result<(), String> {
    const ENTRIES: &[(&str, &str)] = &[
        (
            "checkpoints/",
            "# Agent recovery snapshots — throwaway state, never source of truth.",
        ),
        (
            "sessions/",
            "# Conversation history — may contain sensitive prompts or pasted code.",
        ),
        (
            "queue-operations.jsonl",
            "# Per-turn queue operation log — debug-only, not portable.",
        ),
        (
            "editor-state.json",
            "# Unsaved editor buffers — recovery state, never source of truth.",
        ),
    ];

    let project = Path::new(project_path);
    let canonical = canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;
    let gitignore = canonical.join(".toquemedia").join(".gitignore");
    if let Some(parent) = gitignore.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create .toquemedia/: {}", e))?;
    }

    let existing = tokio::fs::read_to_string(&gitignore).await.unwrap_or_default();
    let present: std::collections::HashSet<&str> = existing
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();

    let mut to_add: Vec<(&str, &str)> = Vec::new();
    for &(entry, comment) in ENTRIES {
        if !present.contains(entry) {
            to_add.push((entry, comment));
        }
    }
    if to_add.is_empty() {
        return Ok(());
    }

    let mut merged = existing;
    if !merged.is_empty() && !merged.ends_with('\n') {
        merged.push('\n');
    }
    for (entry, comment) in to_add {
        merged.push_str(comment);
        merged.push('\n');
        merged.push_str(entry);
        merged.push('\n');
    }

    tokio::fs::write(&gitignore, merged)
        .await
        .map_err(|e| format!("Failed to write .toquemedia/.gitignore: {}", e))?;
    Ok(())
}

/// Public Tauri command — exposes `ensure_toquemedia_gitignore` to the TS
/// layer so session/queue persistence (which writes through plain
/// write_file, not the agent-state surface) can opt in too. Idempotent.
#[tauri::command]
pub async fn ensure_toquemedia_gitignore_cmd(project_path: String) -> Result<(), String> {
    ensure_toquemedia_gitignore(&project_path).await
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Save a single file snapshot (content before modification).
#[tauri::command]
pub async fn save_checkpoint_file(
    project_path: String,
    session_id: String,
    checkpoint_id: String,
    file_path_hash: String,
    content: String,
) -> Result<(), String> {
    validate_file_path_hash(&file_path_hash)?;
    let dir = file_dir(&project_path, &session_id, &checkpoint_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create checkpoint dir: {}", e))?;

    // Best-effort gitignore — don't fail the save if this write fails.
    let _ = ensure_toquemedia_gitignore(&project_path).await;

    let file = dir.join(format!("{}.snapshot", file_path_hash));
    tokio::fs::write(&file, content)
        .await
        .map_err(|e| format!("Failed to write snapshot: {}", e))?;
    Ok(())
}

/// Mark that a file was created (didn't exist before) so revert can delete it.
#[tauri::command]
pub async fn save_checkpoint_new_marker(
    project_path: String,
    session_id: String,
    checkpoint_id: String,
    file_path_hash: String,
) -> Result<(), String> {
    validate_file_path_hash(&file_path_hash)?;
    let dir = file_dir(&project_path, &session_id, &checkpoint_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create checkpoint dir: {}", e))?;

    let _ = ensure_toquemedia_gitignore(&project_path).await;

    let file = dir.join(format!("{}.new", file_path_hash));
    tokio::fs::write(&file, "")
        .await
        .map_err(|e| format!("Failed to write new marker: {}", e))?;
    Ok(())
}

/// Load file content from a checkpoint snapshot.
#[tauri::command]
pub async fn load_checkpoint_file(
    project_path: String,
    session_id: String,
    checkpoint_id: String,
    file_path_hash: String,
) -> Result<String, String> {
    validate_file_path_hash(&file_path_hash)?;
    let dir = file_dir(&project_path, &session_id, &checkpoint_id)?;
    let file = dir.join(format!("{}.snapshot", file_path_hash));
    tokio::fs::read_to_string(&file)
        .await
        .map_err(|e| format!("Failed to read snapshot: {}", e))
}

/// Persist the checkpoint index for a session.
/// Uses write-to-temp-then-rename for atomicity — a crash mid-write
/// won't corrupt the existing index.
#[tauri::command]
pub async fn save_checkpoint_index(
    project_path: String,
    session_id: String,
    index_json: String,
) -> Result<(), String> {
    let dir = session_dir(&project_path, &session_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create session dir: {}", e))?;

    let _ = ensure_toquemedia_gitignore(&project_path).await;

    let file = dir.join("checkpoint_index.json");
    let tmp = dir.join("checkpoint_index.json.tmp");

    tokio::fs::write(&tmp, &index_json)
        .await
        .map_err(|e| format!("Failed to write temp index: {}", e))?;

    tokio::fs::rename(&tmp, &file)
        .await
        .map_err(|e| format!("Failed to rename temp index: {}", e))?;

    Ok(())
}

/// Load the checkpoint index for a session.
#[tauri::command]
pub async fn load_checkpoint_index(
    project_path: String,
    session_id: String,
) -> Result<String, String> {
    let dir = session_dir(&project_path, &session_id)?;
    let file = dir.join("checkpoint_index.json");

    match tokio::fs::read_to_string(&file).await {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(r#"{"checkpoints":[]}"#.to_string())
        }
        Err(e) => Err(format!("Failed to read index: {}", e)),
    }
}

/// Delete snapshot files for a single checkpoint.
#[tauri::command]
pub async fn delete_checkpoint_files(
    project_path: String,
    session_id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    let dir = file_dir(&project_path, &session_id, &checkpoint_id)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete checkpoint files: {}", e)),
    }
}

/// Delete all checkpoint data for a session.
#[tauri::command]
pub async fn delete_checkpoint_session(
    project_path: String,
    session_id: String,
) -> Result<(), String> {
    let dir = session_dir(&project_path, &session_id)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete checkpoint session: {}", e)),
    }
}

/// Delete ALL checkpoint data for a project (every session, every snapshot).
/// Called from the project-deletion flow so checkpoints don't outlive the
/// project they reference. Idempotent — NotFound is treated as success.
///
/// Note: post-migration this is essentially a no-op-with-cleanup — when the
/// caller deletes the project directory itself, the `.toquemedia/checkpoints/`
/// folder goes with it. This command is kept for callers that want to wipe
/// snapshots WITHOUT deleting the project (e.g. "Clear all checkpoints"
/// button in settings, if added).
#[tauri::command]
pub async fn delete_checkpoint_project(project_path: String) -> Result<(), String> {
    let dir = checkpoints_root(&project_path)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete project checkpoints: {}", e)),
    }
}
