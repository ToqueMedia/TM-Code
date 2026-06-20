//! Team collaboration — local persistence for the ephemeral P2P team chat.
//!
//! Chat is P2P (WebRTC mesh + DO relay fallback) and never touches a server.
//! Persistence is purely local + opt-in: each message is appended as one JSON
//! line to `.toquemedia/collab/chat.jsonl` so a member can reopen the project
//! and still see recent team chat. The file is gitignored (`collab/`).
//!
//! (The former changeset code-sharing was replaced by the live-preview tunnel —
//! see `commands/tunnel.rs`.)

use std::path::PathBuf;

use super::canonicalize_path;
use super::checkpoint::ensure_toquemedia_gitignore;

fn chat_log_path(project_path: &str) -> Result<PathBuf, String> {
    let canonical = canonicalize_path(std::path::Path::new(project_path))
        .map_err(|e| format!("Invalid project path: {}", e))?;
    Ok(canonical
        .join(".toquemedia")
        .join("collab")
        .join("chat.jsonl"))
}

/// Append one serialized chat message (a single JSON line, no newlines) to the
/// local chat log. Best-effort: ensures the dir + gitignore first.
#[tauri::command]
pub async fn collab_chat_append(project_path: String, line: String) -> Result<(), String> {
    let path = chat_log_path(&project_path)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create collab dir: {}", e))?;
    }
    let _ = ensure_toquemedia_gitignore(&project_path).await;

    let sanitized = line.replace(['\n', '\r'], " ");
    let mut existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&sanitized);
    existing.push('\n');
    tokio::fs::write(&path, existing)
        .await
        .map_err(|e| format!("Failed to append chat: {}", e))
}

/// Load the last `limit` chat lines (most recent kept). Returns an empty vec
/// when no log exists yet. `limit` of 0 means "no cap".
#[tauri::command]
pub async fn collab_chat_load(project_path: String, limit: usize) -> Result<Vec<String>, String> {
    let path = chat_log_path(&project_path)?;
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read chat log: {}", e)),
    };
    let mut lines: Vec<String> = content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    if limit > 0 && lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn unique_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("tm_collab_{}_{}_{}", tag, std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(p: &std::path::Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[tokio::test]
    async fn chat_append_and_load_with_cap() {
        let dir = unique_dir("chat");
        assert!(collab_chat_load(s(&dir), 0).await.unwrap().is_empty());

        for i in 0..5 {
            collab_chat_append(s(&dir), format!("{{\"text\":\"msg{}\"}}", i))
                .await
                .unwrap();
        }
        // Newlines in a message must not break the one-line-per-message format.
        collab_chat_append(s(&dir), "{\"text\":\"a\nb\"}".to_string())
            .await
            .unwrap();

        let all = collab_chat_load(s(&dir), 0).await.unwrap();
        assert_eq!(all.len(), 6);
        assert_eq!(all[5], "{\"text\":\"a b\"}");

        let last2 = collab_chat_load(s(&dir), 2).await.unwrap();
        assert_eq!(last2.len(), 2);
        assert_eq!(last2[0], "{\"text\":\"msg4\"}");
    }
}
