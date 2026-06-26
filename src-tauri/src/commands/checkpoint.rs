use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::project_state::project_state_root;

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
// Checkpoints are tool state, not project source. They live in the app's
// per-project state directory keyed by `.toquemedia-id`, so new projects stay
// clean while existing projects can be migrated safely from the legacy
// project-local state location.

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
        return Err(format!(
            "Session id cannot start with . or contain .. ({})",
            session_id
        ));
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
    if !hash
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid file path hash characters: {}", hash));
    }
    Ok(())
}

fn checkpoints_root(project_path: &str) -> Result<PathBuf, String> {
    Ok(project_state_root(project_path)?.join("checkpoints"))
}

fn session_dir(project_path: &str, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    Ok(checkpoints_root(project_path)?.join(session_id))
}

fn file_dir(project_path: &str, session_id: &str, checkpoint_id: &str) -> Result<PathBuf, String> {
    validate_checkpoint_id(checkpoint_id)?;
    Ok(session_dir(project_path, session_id)?
        .join("files")
        .join(checkpoint_id))
}

/// Legacy no-op kept so older frontend code can call it safely.
pub(crate) async fn ensure_toquemedia_gitignore(project_path: &str) -> Result<(), String> {
    let _ = project_path;
    Ok(())
}

/// Public Tauri command kept for compatibility with older frontend code.
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
/// This command is kept for callers that want to wipe snapshots WITHOUT
/// deleting the project (e.g. "Clear all checkpoints" button in settings, if
/// added). Project deletion should call it because state now lives outside the
/// project tree.
#[tauri::command]
pub async fn delete_checkpoint_project(project_path: String) -> Result<(), String> {
    let dir = checkpoints_root(&project_path)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete project checkpoints: {}", e)),
    }
}
