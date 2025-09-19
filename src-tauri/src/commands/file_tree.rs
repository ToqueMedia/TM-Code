use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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

    build_tree_node(path, &filter, 0)
}

// Recursive helper to build tree nodes
fn build_tree_node(
    path: &Path,
    filter: &Option<FileTreeFilter>,
    depth: usize,
) -> Result<FileTreeNode> {
    let metadata = std::fs::metadata(path)?;

    if metadata.is_file() {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_string());

        return Ok(FileTreeNode::File {
            name,
            path: path.to_string_lossy().to_string(),
            extension,
            metadata: create_file_metadata(metadata, path),
        });
    }

    // Handle directory
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // Check filters
    if let Some(filter_opts) = filter {
        // Check max depth
        if let Some(max_depth) = filter_opts.max_depth {
            if depth >= max_depth {
                return Ok(FileTreeNode::Directory {
                    name,
                    path: path.to_string_lossy().to_string(),
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
        match build_tree_node(&entry_path, filter, depth + 1) {
            Ok(child_node) => children.push(child_node),
            Err(e) => {
                // Log error but continue processing other entries
                eprintln!("Error processing {}: {}", entry_path.display(), e);
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
        path: path.to_string_lossy().to_string(),
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
    let full_path = Path::new(&parent_path).join(&name);

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
            path: full_path.to_string_lossy().to_string(),
        })
    } else {
        std::fs::File::create(&full_path).map(|_| FileOperationResult {
            success: true,
            message: "File created successfully".to_string(),
            path: full_path.to_string_lossy().to_string(),
        })
    };

    result.map_err(FileTreeError::from)
}

// Delete a file or directory
#[tauri::command]
pub fn delete_file_or_directory(path: String) -> Result<FileOperationResult> {
    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(FileTreeError::PathNotFound(path));
    }

    let result = if file_path.is_dir() {
        std::fs::remove_dir_all(file_path).map(|_| FileOperationResult {
            success: true,
            message: "Directory deleted successfully".to_string(),
            path: path.clone(),
        })
    } else {
        std::fs::remove_file(file_path).map(|_| FileOperationResult {
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
    let old_path_obj = Path::new(&old_path);

    if !old_path_obj.exists() {
        return Err(FileTreeError::PathNotFound(old_path));
    }

    let parent = old_path_obj.parent().ok_or_else(|| {
        FileTreeError::InvalidOperation("Cannot rename root directory".to_string())
    })?;

    let new_path = parent.join(&new_name);

    if new_path.exists() {
        return Err(FileTreeError::InvalidOperation(format!(
            "Destination already exists: {}",
            new_path.display()
        )));
    }

    std::fs::rename(old_path_obj, &new_path)
        .map(|_| FileOperationResult {
            success: true,
            message: "Renamed successfully".to_string(),
            path: new_path.to_string_lossy().to_string(),
        })
        .map_err(FileTreeError::from)
}

// Read file content
#[tauri::command]
pub fn read_file(path: String) -> Result<String> {
    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(FileTreeError::PathNotFound(path));
    }

    if file_path.is_dir() {
        return Err(FileTreeError::InvalidOperation(
            "Path is a directory".to_string(),
        ));
    }

    std::fs::read_to_string(file_path).map_err(FileTreeError::from)
}

// Write file content
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<()> {
    let file_path = Path::new(&path);

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::write(file_path, content).map_err(FileTreeError::from)
}

// Create a new file
#[tauri::command]
pub fn create_file(path: String, content: Option<String>) -> Result<()> {
    let file_path = Path::new(&path);

    if file_path.exists() {
        return Err(FileTreeError::InvalidOperation(format!(
            "File already exists: {}",
            file_path.display()
        )));
    }

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let content = content.unwrap_or_default();
    std::fs::write(file_path, content).map_err(FileTreeError::from)
}

// Copy a file or directory
#[tauri::command]
pub fn copy_file_or_directory(
    source_path: String,
    destination_path: String,
) -> Result<FileOperationResult> {
    let source = Path::new(&source_path);
    let destination = Path::new(&destination_path);

    if !source.exists() {
        return Err(FileTreeError::PathNotFound(source_path));
    }

    if destination.exists() {
        return Err(FileTreeError::InvalidOperation(format!(
            "Destination already exists: {}",
            destination_path
        )));
    }

    let result = if source.is_dir() {
        // Copy directory recursively
        copy_dir_all(source, destination).map(|_| FileOperationResult {
            success: true,
            message: "Directory copied successfully".to_string(),
            path: destination_path.clone(),
        })
    } else {
        // Copy file
        std::fs::copy(source, destination).map(|_| FileOperationResult {
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

        if file_type.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }

    Ok(())
}
