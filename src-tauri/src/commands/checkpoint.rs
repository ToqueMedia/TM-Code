use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
// Helpers
// ---------------------------------------------------------------------------

fn checkpoints_base() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".toquemedia-studio").join("checkpoints"))
}

fn session_dir(project_hash: &str, session_id: &str) -> Result<PathBuf, String> {
    let base = checkpoints_base()?;
    Ok(base.join(project_hash).join(session_id))
}

fn file_dir(project_hash: &str, session_id: &str, checkpoint_id: &str) -> Result<PathBuf, String> {
    let sd = session_dir(project_hash, session_id)?;
    Ok(sd.join("files").join(checkpoint_id))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Save a single file snapshot (content before modification).
#[tauri::command]
pub async fn save_checkpoint_file(
    project_hash: String,
    session_id: String,
    checkpoint_id: String,
    file_path_hash: String,
    content: String,
) -> Result<(), String> {
    let dir = file_dir(&project_hash, &session_id, &checkpoint_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create checkpoint dir: {}", e))?;

    let file = dir.join(format!("{}.snapshot", file_path_hash));
    tokio::fs::write(&file, content)
        .await
        .map_err(|e| format!("Failed to write snapshot: {}", e))?;
    Ok(())
}

/// Mark that a file was created (didn't exist before) so revert can delete it.
#[tauri::command]
pub async fn save_checkpoint_new_marker(
    project_hash: String,
    session_id: String,
    checkpoint_id: String,
    file_path_hash: String,
) -> Result<(), String> {
    let dir = file_dir(&project_hash, &session_id, &checkpoint_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create checkpoint dir: {}", e))?;

    let file = dir.join(format!("{}.new", file_path_hash));
    tokio::fs::write(&file, "")
        .await
        .map_err(|e| format!("Failed to write new marker: {}", e))?;
    Ok(())
}

/// Load file content from a checkpoint snapshot.
#[tauri::command]
pub async fn load_checkpoint_file(
    project_hash: String,
    session_id: String,
    checkpoint_id: String,
    file_path_hash: String,
) -> Result<String, String> {
    let dir = file_dir(&project_hash, &session_id, &checkpoint_id)?;
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
    project_hash: String,
    session_id: String,
    index_json: String,
) -> Result<(), String> {
    let dir = session_dir(&project_hash, &session_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Failed to create session dir: {}", e))?;

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
    project_hash: String,
    session_id: String,
) -> Result<String, String> {
    let dir = session_dir(&project_hash, &session_id)?;
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
    project_hash: String,
    session_id: String,
    checkpoint_id: String,
) -> Result<(), String> {
    let dir = file_dir(&project_hash, &session_id, &checkpoint_id)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete checkpoint files: {}", e)),
    }
}

/// Delete all checkpoint data for a session.
#[tauri::command]
pub async fn delete_checkpoint_session(
    project_hash: String,
    session_id: String,
) -> Result<(), String> {
    let dir = session_dir(&project_hash, &session_id)?;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete checkpoint session: {}", e)),
    }
}
