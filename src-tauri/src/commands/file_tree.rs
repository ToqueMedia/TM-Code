use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{canonicalize_path, normalize_path_for_frontend};

// File tree node types
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FileTreeNode {
    Directory {
        name: String,
        path: String,
        children: Vec<FileTreeNode>,
        expanded: bool,
        metadata: FileMetadata,
    },
    File {
        name: String,
        path: String,
        extension: Option<String>,
        metadata: FileMetadata,
    },
}

// File metadata
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub size: u64,
    pub created: String,
    pub modified: String,
    pub is_hidden: bool,
    pub permissions: String,
}

// File tree filter options
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeFilter {
    pub show_hidden: bool,
    pub extensions: Option<Vec<String>>,
    pub max_depth: Option<usize>,
}

// File operation results
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    pub success: bool,
    pub message: String,
    pub path: String,
}

// Error types specific to file tree operations
#[derive(Debug, thiserror::Error, serde::Serialize)]
pub enum FileTreeError {
    #[error("IO error: {0}")]
    Io(String),
    #[error("Path not found: {0}")]
    PathNotFound(String),
    #[error("Permission denied: {0}")]
    #[allow(dead_code)]
    PermissionDenied(String),
    #[error("Invalid operation: {0}")]
    InvalidOperation(String),
}

impl From<std::io::Error> for FileTreeError {
    fn from(err: std::io::Error) -> Self {
        FileTreeError::Io(err.to_string())
    }
}

pub type Result<T, E = FileTreeError> = std::result::Result<T, E>;

/// Maximum file size allowed for reading (50 MB)
const MAX_READ_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// Maximum decompression output size (100 MB) to prevent zip bombs
pub const MAX_DECOMPRESS_SIZE: usize = 100 * 1024 * 1024;

/// Validates that a resolved path stays within the allowed project root.
/// Prevents path traversal attacks (e.g., "../../etc/passwd").
#[allow(dead_code)]
pub fn validate_path_within_root(path: &Path, root: &Path) -> Result<PathBuf> {
    let canonical_root = canonicalize_path(root).map_err(|_| {
        FileTreeError::PathNotFound(format!("Root path not found: {}", root.display()))
    })?;

    // For paths that don't exist yet (create operations), canonicalize the parent
    let canonical_path = if path.exists() {
        canonicalize_path(path).map_err(|_| {
            FileTreeError::PathNotFound(format!("Path not found: {}", path.display()))
        })?
    } else {
        let parent = path.parent().ok_or_else(|| {
            FileTreeError::InvalidOperation("Cannot resolve parent directory".to_string())
        })?;
        let canonical_parent = canonicalize_path(parent).map_err(|_| {
            FileTreeError::PathNotFound(format!("Parent path not found: {}", parent.display()))
        })?;
        let file_name = path
            .file_name()
            .ok_or_else(|| FileTreeError::InvalidOperation("Invalid file name".to_string()))?;
        canonical_parent.join(file_name)
    };

    if !canonical_path.starts_with(&canonical_root) {
        return Err(FileTreeError::InvalidOperation(format!(
            "Access denied: path '{}' is outside the project root",
            path.display()
        )));
    }

    Ok(canonical_path)
}

/// Validates a standalone path by canonicalizing it and checking for symlink abuse.
/// Used for commands that don't have a project root context (read_file, write_file, etc.)
fn validate_path_safe(path: &Path) -> Result<PathBuf> {
    // Block paths with ".." components before they reach the filesystem
    for component in path.components() {
        if let std::path::Component::ParentDir = component {
            return Err(FileTreeError::InvalidOperation(
                "Path traversal ('..') is not allowed".to_string(),
            ));
        }
    }

    if path.exists() {
        canonicalize_path(path)
            .map_err(|_| FileTreeError::PathNotFound(format!("{}", path.display())))
    } else {
        // For new files, canonicalize the parent
        let parent = path.parent().ok_or_else(|| {
            FileTreeError::InvalidOperation("Cannot resolve parent directory".to_string())
        })?;
        if parent.as_os_str().is_empty() {
            return Err(FileTreeError::InvalidOperation(
                "Cannot resolve path without parent directory".to_string(),
            ));
        }
        let canonical_parent = canonicalize_path(parent).map_err(|_| {
            FileTreeError::PathNotFound(format!("Parent not found: {}", parent.display()))
        })?;
        let file_name = path
            .file_name()
            .ok_or_else(|| FileTreeError::InvalidOperation("Invalid file name".to_string()))?;
        Ok(canonical_parent.join(file_name))
    }
}

// Convert SystemTime to ISO string
fn system_time_to_iso(st: SystemTime) -> String {
    let duration = st.duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}", duration.as_secs())
}

// Create a FileMetadata from std::fs::Metadata
fn create_file_metadata(metadata: std::fs::Metadata, path: &Path) -> FileMetadata {
    let permissions = {
        #[cfg(unix)]
        {
            format!("{:o}", metadata.permissions().mode() & 0o777)
        }
        #[cfg(not(unix))]
        {
            if metadata.permissions().readonly() {
                "read-only"
            } else {
                "read-write"
            }
            .to_string()
        }
    };

    FileMetadata {
        size: metadata.len(),
        created: metadata
            .created()
            .map(system_time_to_iso)
            .unwrap_or_else(|_| "".to_string()),
        modified: metadata
            .modified()
            .map(system_time_to_iso)
            .unwrap_or_else(|_| "".to_string()),
        is_hidden: path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with('.'))
            .unwrap_or(false),
        permissions,
    }
}

// Build a file tree recursively
#[tauri::command]
pub fn build_file_tree(root_path: String, filter: Option<FileTreeFilter>) -> Result<FileTreeNode> {
    let path = Path::new(&root_path);

    if !path.exists() {
        return Err(FileTreeError::PathNotFound(root_path));
    }

    if !path.is_dir() {
        return Err(FileTreeError::InvalidOperation(
            "Path is not a directory".to_string(),
        ));
    }

    let canonical_root =
        canonicalize_path(path).map_err(|_| FileTreeError::PathNotFound(root_path.clone()))?;

    let mut visited = HashSet::new();
    visited.insert(canonical_root.clone());

    // Enforce a default max_depth of 20 to prevent unbounded recursion
    let filter_with_default = match filter {
        Some(mut f) => {
            if f.max_depth.is_none() {
                f.max_depth = Some(20);
            }
            Some(f)
        }
        None => Some(FileTreeFilter {
            show_hidden: true,
            extensions: None,
            max_depth: Some(20),
        }),
    };

    build_tree_node(&canonical_root, &filter_with_default, 0, &mut visited)
}

// Recursive helper to build tree nodes
fn build_tree_node(
    path: &Path,
    filter: &Option<FileTreeFilter>,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
) -> Result<FileTreeNode> {
    let metadata = std::fs::metadata(path)?;

    if metadata.is_file() {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let extension = path
            .extension()
            .map(|ext| ext.to_string_lossy().to_string());

        return Ok(FileTreeNode::File {
            name,
            path: normalize_path_for_frontend(path),
            extension,
            metadata: create_file_metadata(metadata, path),
        });
    }

    // Handle directory
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // Check filters
    if let Some(filter_opts) = filter {
        // Check max depth
        if let Some(max_depth) = filter_opts.max_depth {
            if depth >= max_depth {
                return Ok(FileTreeNode::Directory {
                    name,
                    path: normalize_path_for_frontend(path),
                    children: vec![],
                    expanded: false,
                    metadata: create_file_metadata(metadata, path),
                });
            }
        }
    }

    // Read directory entries
    let mut children = Vec::new();
    let entries = std::fs::read_dir(path)?;

    for entry in entries {
        let entry = entry?;
        let entry_path = entry.path();

        // Detect symlinks and prevent infinite loops
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            if let Ok(canonical) = canonicalize_path(&entry_path) {
                if !visited.insert(canonical) {
                    // Already visited this target — skip to prevent cycle
                    continue;
                }
            } else {
                // Broken symlink — skip
                continue;
            }
        }

        // Skip hidden files if not showing hidden
        if let Some(filter_opts) = filter {
            if !filter_opts.show_hidden {
                if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.') {
                        continue;
                    }
                }
            }
        }

        // Recursively build child nodes
        match build_tree_node(&entry_path, filter, depth + 1, visited) {
            Ok(child_node) => children.push(child_node),
            Err(_) => {
                // Skip entries that can't be read (permissions, broken links, etc.)
                // Silently continue to build partial tree rather than fail entirely
            }
        }
    }

    // Sort children (directories first, then alphabetically)
    children.sort_by(|a, b| match (a, b) {
        (FileTreeNode::Directory { .. }, FileTreeNode::File { .. }) => std::cmp::Ordering::Less,
        (FileTreeNode::File { .. }, FileTreeNode::Directory { .. }) => std::cmp::Ordering::Greater,
        _ => {
            let name_a = match a {
                FileTreeNode::Directory { name, .. } => name,
                FileTreeNode::File { name, .. } => name,
            };
            let name_b = match b {
                FileTreeNode::Directory { name, .. } => name,
                FileTreeNode::File { name, .. } => name,
            };
            name_a.cmp(name_b)
        }
    });

    Ok(FileTreeNode::Directory {
        name,
        path: normalize_path_for_frontend(path),
        children,
        expanded: false,
        metadata: create_file_metadata(metadata, path),
    })
}

// Create a new file or directory
#[tauri::command]
pub fn create_file_or_directory(
    parent_path: String,
    name: String,
    is_directory: bool,
) -> Result<FileOperationResult> {
    // Reject names that attempt path traversal
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err(FileTreeError::InvalidOperation(
            "Name must not contain path separators or '..'".to_string(),
        ));
    }

    let parent = Path::new(&parent_path);
    validate_path_safe(parent)?;
    let full_path = parent.join(&name);

    if full_path.exists() {
        return Err(FileTreeError::InvalidOperation(format!(
            "Path already exists: {}",
            full_path.display()
        )));
    }

    let result = if is_directory {
        std::fs::create_dir(&full_path).map(|_| FileOperationResult {
            success: true,
            message: "Directory created successfully".to_string(),
            path: normalize_path_for_frontend(&full_path),
        })
    } else {
        std::fs::File::create(&full_path).map(|_| FileOperationResult {
            success: true,
            message: "File created successfully".to_string(),
            path: normalize_path_for_frontend(&full_path),
        })
    };

    result.map_err(FileTreeError::from)
}

// Delete a file or directory
#[tauri::command]
pub fn delete_file_or_directory(path: String) -> Result<FileOperationResult> {
    let file_path = Path::new(&path);
    let canonical = validate_path_safe(file_path)?;

    if !canonical.exists() {
        return Err(FileTreeError::PathNotFound(path));
    }

    let result = if canonical.is_dir() {
        std::fs::remove_dir_all(&canonical).map(|_| FileOperationResult {
            success: true,
            message: "Directory deleted successfully".to_string(),
            path: path.clone(),
        })
    } else {
        std::fs::remove_file(&canonical).map(|_| FileOperationResult {
            success: true,
            message: "File deleted successfully".to_string(),
            path: path.clone(),
        })
    };

    result.map_err(FileTreeError::from)
}

// Rename a file or directory
#[tauri::command]
pub fn rename_file_or_directory(old_path: String, new_name: String) -> Result<FileOperationResult> {
    // Reject names that attempt path traversal
    if new_name.contains("..") || new_name.contains('/') || new_name.contains('\\') {
        return Err(FileTreeError::InvalidOperation(
            "Name must not contain path separators or '..'".to_string(),
        ));
    }

    let old_path_obj = Path::new(&old_path);
    let canonical_old = validate_path_safe(old_path_obj)?;

    if !canonical_old.exists() {
        return Err(FileTreeError::PathNotFound(old_path));
    }

    let parent = canonical_old.parent().ok_or_else(|| {
        FileTreeError::InvalidOperation("Cannot rename root directory".to_string())
    })?;

    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(FileTreeError::InvalidOperation(format!(
            "Destination already exists: {}",
            new_path.display()
        )));
    }

    std::fs::rename(&canonical_old, &new_path)
        .map(|_| FileOperationResult {
            success: true,
            message: "Renamed successfully".to_string(),
            path: normalize_path_for_frontend(&new_path),
        })
        .map_err(FileTreeError::from)
}

// Read file content (async — does not block the Tauri command queue)
#[tauri::command]
pub async fn read_file(path: String) -> Result<String> {
    let file_path = Path::new(&path);
    let canonical = validate_path_safe(file_path)?;

    if !canonical.exists() {
        return Err(FileTreeError::PathNotFound(path));
    }

    if canonical.is_dir() {
        return Err(FileTreeError::InvalidOperation(
            "Path is a directory".to_string(),
        ));
    }

    // Prevent reading excessively large files into memory
    let metadata = tokio::fs::metadata(&canonical).await?;
    if metadata.len() > MAX_READ_FILE_SIZE {
        return Err(FileTreeError::InvalidOperation(format!(
            "File too large ({:.1} MB). Maximum allowed: {:.0} MB",
            metadata.len() as f64 / (1024.0 * 1024.0),
            MAX_READ_FILE_SIZE as f64 / (1024.0 * 1024.0)
        )));
    }

    tokio::fs::read_to_string(&canonical).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidData {
            FileTreeError::InvalidOperation("Cannot read binary file as text".to_string())
        } else {
            FileTreeError::from(e)
        }
    })
}

// Write file content (async — does not block the Tauri command queue)
#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<()> {
    let file_path = Path::new(&path);
    let canonical = validate_path_safe(file_path)?;

    // Create parent directories if they don't exist
    if let Some(parent) = canonical.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    tokio::fs::write(&canonical, content)
        .await
        .map_err(FileTreeError::from)
}

// Create a new file
#[tauri::command]
pub fn create_file(path: String, content: Option<String>) -> Result<()> {
    let file_path = Path::new(&path);
    let safe_path = validate_path_safe(file_path)?;

    if safe_path.exists() {
        return Err(FileTreeError::InvalidOperation(format!(
            "File already exists: {}",
            safe_path.display()
        )));
    }

    // Create parent directories if they don't exist
    if let Some(parent) = safe_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let content = content.unwrap_or_default();
    std::fs::write(&safe_path, content).map_err(FileTreeError::from)
}

// Copy a file or directory
#[tauri::command]
pub fn copy_file_or_directory(
    source_path: String,
    destination_path: String,
) -> Result<FileOperationResult> {
    let source = Path::new(&source_path);
    let destination = Path::new(&destination_path);
    let canonical_source = validate_path_safe(source)?;
    let safe_destination = validate_path_safe(destination)?;

    if !canonical_source.exists() {
        return Err(FileTreeError::PathNotFound(source_path));
    }

    if safe_destination.exists() {
        return Err(FileTreeError::InvalidOperation(format!(
            "Destination already exists: {}",
            destination_path
        )));
    }

    let result = if canonical_source.is_dir() {
        // Copy directory recursively
        copy_dir_all(&canonical_source, &safe_destination).map(|_| FileOperationResult {
            success: true,
            message: "Directory copied successfully".to_string(),
            path: destination_path.clone(),
        })
    } else {
        // Copy file
        std::fs::copy(&canonical_source, &safe_destination).map(|_| FileOperationResult {
            success: true,
            message: "File copied successfully".to_string(),
            path: destination_path.clone(),
        })
    };

    result.map_err(FileTreeError::from)
}

// Helper function to copy directories recursively
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        // Skip symlinks to prevent data leaks and infinite recursion
        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }

    Ok(())
}

// Create all directories for a given path
#[tauri::command]
pub fn create_directories_all(path: String) -> Result<FileOperationResult> {
    let p = Path::new(&path);

    // Block path traversal
    for component in p.components() {
        if let std::path::Component::ParentDir = component {
            return Err(FileTreeError::InvalidOperation(
                "Path traversal ('..') is not allowed".to_string(),
            ));
        }
    }

    // Always create the full path as directories — callers should pass the directory path
    let dir_to_create = p;

    std::fs::create_dir_all(dir_to_create)
        .map(|_| FileOperationResult {
            success: true,
            message: "Directories created successfully".to_string(),
            path: normalize_path_for_frontend(p),
        })
        .map_err(FileTreeError::from)
}
