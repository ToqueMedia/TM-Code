//! Memory directory commands — persistent agent memory across sessions.
//!
//! Ported from claude-vaz's `memdir/` system. Two scopes coexist:
//!
//!   - **Project memory**: `<project>/.toquemedia/memory/` — committable,
//!     travels with the project. Holds `project_*` and `reference_*` entries
//!     that describe ongoing work, repo conventions, where to look up X.
//!
//!   - **User memory**: `~/.toquemedia-studio/memory/` — cross-project,
//!     scoped to this IDE installation. Holds `user_*` (who the developer is)
//!     and `feedback_*` (corrections / validated approaches) entries that
//!     should apply regardless of which project is open.
//!
//! Each scope has one `MEMORY.md` index file + N topic files. The index is
//! injected into the system prompt every turn; topic files are read on-
//! demand by the agent via `read_memory_file`.
//!
//! Path containment: every command canonicalises the scope root and
//! refuses operations that resolve outside it (no symlinks honoured to
//! `..`, no nested directories below `memory/`, validated filenames only).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::canonicalize_path;

/// Memory scope — `Project` is `<project>/.toquemedia/memory/`, `User` is
/// `~/.toquemedia-studio/memory/`. The TS layer picks the scope per file.
#[derive(Debug, Clone, Copy)]
enum MemoryScope {
    Project,
    User,
}

fn parse_scope(s: &str) -> Result<MemoryScope, String> {
    match s {
        "project" => Ok(MemoryScope::Project),
        "user" => Ok(MemoryScope::User),
        _ => Err(format!(
            "Invalid memory scope: {} (expected 'project' or 'user')",
            s
        )),
    }
}

/// Memory filenames are limited to `[A-Za-z0-9._-]+` with no dot-prefix
/// and no parent-traversal sequences. Bound at 80 chars (memdir convention).
fn validate_memory_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("Memory filename cannot be empty".to_string());
    }
    if filename.len() > 80 {
        return Err(format!(
            "Memory filename too long ({} chars)",
            filename.len()
        ));
    }
    if !filename
        .chars()
        .all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!("Invalid memory filename: {}", filename));
    }
    if filename.starts_with('.') || filename.contains("..") {
        return Err(format!(
            "Memory filename cannot start with . or contain .. ({})",
            filename
        ));
    }
    // .md extension required to match the convention; index file is "MEMORY.md".
    if !filename.ends_with(".md") {
        return Err(format!("Memory filename must end with .md ({})", filename));
    }
    Ok(())
}

fn memory_root(
    scope: MemoryScope,
    project_path: Option<&str>,
    subdirectory: Option<&str>,
) -> Result<PathBuf, String> {
    match scope {
        MemoryScope::Project => {
            let project = project_path.ok_or("Project memory requires projectPath")?;
            let p = Path::new(project);
            if !p.exists() || !p.is_dir() {
                return Err(format!("Project path does not exist: {}", project));
            }
            let canonical =
                canonicalize_path(p).map_err(|e| format!("Invalid project path: {}", e))?;
            let mut dir = canonical.join(".toquemedia").join("memory");
            if let Some(sub) = subdirectory {
                // Validate subdirectory: alphanumeric, hyphens, underscores only
                if !sub
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
                {
                    return Err(format!("Invalid subdirectory name: {}", sub));
                }
                dir = dir.join(sub);
            }
            if !dir.starts_with(&canonical) {
                return Err("Resolved memory path escapes project root".to_string());
            }
            Ok(dir)
        }
        MemoryScope::User => {
            if subdirectory.is_some() {
                return Err("User-scope memory does not support subdirectory (sub-agents are project-bound)".to_string());
            }
            let home = dirs::home_dir().ok_or("Could not determine home directory")?;
            Ok(home.join(".toquemedia-studio").join("memory"))
        }
    }
}

fn memory_file_path(
    scope: MemoryScope,
    project_path: Option<&str>,
    filename: &str,
    subdirectory: Option<&str>,
) -> Result<PathBuf, String> {
    validate_memory_filename(filename)?;
    let root = memory_root(scope, project_path, subdirectory)?;
    let file = root.join(filename);
    // Defense-in-depth: even after filename validation, confirm the join
    // didn't escape (covers the theoretical case of a Windows-specific
    // path-magic char passing the char-class check).
    if !file.starts_with(&root) {
        return Err("Resolved memory file path escapes scope root".to_string());
    }
    Ok(file)
}

fn unique_sibling_tmp_path(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("memory");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    path.with_file_name(format!("{filename}.{pid}.{nanos}.tmp"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileEntry {
    pub filename: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

/// Read a single memory file's content (raw markdown including frontmatter).
/// Returns `Ok(None)` when the file does not exist — first-use scenarios
/// don't need to surface a misleading error.
#[tauri::command]
pub async fn read_memory_file(
    scope: String,
    project_path: Option<String>,
    filename: String,
    subdirectory: Option<String>,
) -> Result<Option<String>, String> {
    let scope = parse_scope(&scope)?;
    let path = memory_file_path(
        scope,
        project_path.as_deref(),
        &filename,
        subdirectory.as_deref(),
    )?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Failed to read memory file {}: {}", filename, e))
}

/// Write a memory file. Creates the scope directory on first write.
/// Atomic: writes to a unique sibling temp file then renames. The unique name
/// prevents concurrent writes to the same memory file from stealing each
/// other's temp file and failing the losing commit with ENOENT.
#[tauri::command]
pub async fn write_memory_file(
    scope: String,
    project_path: Option<String>,
    filename: String,
    content: String,
    subdirectory: Option<String>,
) -> Result<(), String> {
    let scope = parse_scope(&scope)?;
    let path = memory_file_path(
        scope,
        project_path.as_deref(),
        &filename,
        subdirectory.as_deref(),
    )?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create memory dir: {}", e))?;
    }
    let tmp = unique_sibling_tmp_path(&path);
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {}", filename, e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to commit {}: {}", filename, e))?;
    Ok(())
}

/// Delete a memory file. Idempotent — NotFound is treated as success
/// (matches the `forget_memory` semantics: "make sure this is gone").
#[tauri::command]
pub async fn delete_memory_file(
    scope: String,
    project_path: Option<String>,
    filename: String,
    subdirectory: Option<String>,
) -> Result<(), String> {
    let scope = parse_scope(&scope)?;
    let path = memory_file_path(
        scope,
        project_path.as_deref(),
        &filename,
        subdirectory.as_deref(),
    )?;
    match std::fs::remove_file(&path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to delete {}: {}", filename, e)),
    }
}

/// List every memory file in a scope. Returns filename + size + mtime so
/// the TS layer can decide what to inject without re-reading the index.
/// Returns an empty vec when the scope dir doesn't exist yet.
#[tauri::command]
pub async fn list_memory_files(
    scope: String,
    project_path: Option<String>,
    subdirectory: Option<String>,
) -> Result<Vec<MemoryFileEntry>, String> {
    let scope = parse_scope(&scope)?;
    let root = memory_root(scope, project_path.as_deref(), subdirectory.as_deref())?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let read = match std::fs::read_dir(&root) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = match path.file_name().and_then(|s| s.to_str()) {
            Some(f) => f.to_string(),
            None => continue,
        };
        if !filename.ends_with(".md") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size_bytes = metadata.len();
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(MemoryFileEntry {
            filename,
            size_bytes,
            mtime_ms,
        });
    }
    Ok(out)
}
