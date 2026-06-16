use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{canonicalize_path, normalize_path_for_frontend};

/// Maximum number of visible children per directory to prevent massive trees.
const MAX_CHILDREN_PER_DIR: usize = 500;

/// Directories always excluded from the file tree to avoid massive context waste.
/// Matches the exclusion list in `filesystem.rs:has_excluded` (glob tool).
const EXCLUDED_DIRS: &[&str] = &[
    // JS/TS ecosystem
    "node_modules",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".parcel-cache",
    ".yarn",
    ".pnpm-store",
    ".npm",
    "bower_components",
    "jspm_packages",
    ".expo",
    ".svelte-kit",
    ".angular",
    // Build outputs
    "dist",
    "build",
    "out",
    ".vercel",
    ".netlify",
    // Version control
    ".git",
    ".svn",
    ".hg",
    // Python
    "__pycache__",
    ".venv",
    "venv",
    "env",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    "htmlcov",
    ".coverage",
    // Rust
    "target",
    // Java/Kotlin/Android
    ".gradle",
    ".m2",
    ".idea",
    // iOS/macOS
    "Pods",
    "DerivedData",
    "Carthage",
    // Go/Ruby/PHP
    "vendor",
    // .NET
    "bin",
    "obj",
    // Dart/Flutter
    ".dart_tool",
    ".pub-cache",
    // Terraform/IaC
    ".terraform",
    ".serverless",
    // IDE/Editor
    ".vscode",
    ".vs",
    // Caches
    ".cache",
    ".sass-cache",
    ".eslintcache",
    ".stylelintcache",
    ".nyc_output",
    "coverage",
    // Temp
    "tmp",
    "temp",
];

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
        /// True when children were capped at MAX_CHILDREN_PER_DIR.
        #[serde(default)]
        truncated: bool,
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
    /// When true, entries matched by the project's `.gitignore` files are
    /// omitted (nested .gitignores honoured, deepest match wins — full git
    /// semantics, courtesy of the `ignore` crate). Opt-in and `#[serde(default)]`
    /// so existing callers that omit it keep the old behaviour: the file
    /// explorer UI leaves it off (users still see/open ignored files like
    /// `.env`); the agent context tree turns it on to cut noise.
    #[serde(default)]
    pub respect_gitignore: bool,
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
///
/// When the path itself or its parent doesn't exist, walks UP the path tree to
/// find the deepest ancestor that does exist, canonicalizes that, then appends
/// the remaining segments back. This lets `write_file` succeed for paths whose
/// parent directories don't yet exist (the caller will create_dir_all the
/// parent right after) — without losing path-traversal protection (the `..`
/// check runs first and is unaffected by ancestor existence).
fn validate_path_safe(path: &Path) -> Result<PathBuf> {
    // Block paths with ".." components before they reach the filesystem.
    // Runs unconditionally — independent of which ancestors exist on disk.
    for component in path.components() {
        if let std::path::Component::ParentDir = component {
            return Err(FileTreeError::InvalidOperation(
                "Path traversal ('..') is not allowed".to_string(),
            ));
        }
    }

    if path.exists() {
        return canonicalize_path(path)
            .map_err(|_| FileTreeError::PathNotFound(format!("{}", path.display())));
    }

    // Path doesn't exist yet. Walk up until we find an ancestor that does,
    // canonicalize it, then re-attach the missing-segment tail. Handles
    // create_file / write_file targeting deeply-nested new directories.
    let mut existing_ancestor = path.parent().ok_or_else(|| {
        FileTreeError::InvalidOperation("Cannot resolve parent directory".to_string())
    })?;
    while !existing_ancestor.exists() {
        existing_ancestor = match existing_ancestor.parent() {
            Some(p) if !p.as_os_str().is_empty() => p,
            _ => {
                return Err(FileTreeError::InvalidOperation(
                    "Cannot resolve any existing ancestor directory".to_string(),
                ));
            }
        };
    }

    let canonical_ancestor = canonicalize_path(existing_ancestor).map_err(|_| {
        FileTreeError::PathNotFound(format!(
            "Ancestor not found: {}",
            existing_ancestor.display()
        ))
    })?;

    // Reattach the segments between the existing ancestor and the target path.
    let tail = path.strip_prefix(existing_ancestor).map_err(|_| {
        FileTreeError::InvalidOperation(
            "Failed to compute path tail relative to ancestor".to_string(),
        )
    })?;
    Ok(canonical_ancestor.join(tail))
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

// Build a file tree recursively.
// Uses spawn_blocking so the heavy filesystem walk doesn't block the Tokio runtime.
#[tauri::command]
pub async fn build_file_tree(
    root_path: String,
    filter: Option<FileTreeFilter>,
) -> Result<FileTreeNode> {
    // Validate path existence before spawning blocking task
    let path = PathBuf::from(&root_path);
    if !path.exists() {
        return Err(FileTreeError::PathNotFound(root_path));
    }
    if !path.is_dir() {
        return Err(FileTreeError::InvalidOperation(
            "Path is not a directory".to_string(),
        ));
    }

    let canonical_root =
        canonicalize_path(&path).map_err(|_| FileTreeError::PathNotFound(root_path.clone()))?;

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
            respect_gitignore: false,
        }),
    };

    // Run the heavy recursive walk on a blocking thread pool
    tokio::task::spawn_blocking(move || {
        let mut visited = HashSet::new();
        visited.insert(canonical_root.clone());
        build_tree_node(&canonical_root, &filter_with_default, 0, &mut visited, &[])
    })
    .await
    .map_err(|e| FileTreeError::Io(e.to_string()))?
}

/// Tests `path` against the inherited stack of `.gitignore` matchers.
/// Iterates deepest-first so the most specific `.gitignore` wins (git's
/// precedence rule), and a `Whitelist` match (a `!`-negated rule) short-circuits
/// to "not ignored". Each matcher knows its own base directory, so an absolute
/// descendant path resolves correctly against an ancestor's `.gitignore`.
fn is_gitignored(gitignores: &[&Gitignore], path: &Path, is_dir: bool) -> bool {
    for gi in gitignores.iter().rev() {
        match gi.matched(path, is_dir) {
            ignore::Match::Ignore(_) => return true,
            ignore::Match::Whitelist(_) => return false,
            ignore::Match::None => continue,
        }
    }
    false
}

// Recursive helper to build tree nodes.
// `gitignores` is the inherited stack of `.gitignore` matchers from ancestor
// directories (shallowest first); empty unless `filter.respect_gitignore`.
fn build_tree_node(
    path: &Path,
    filter: &Option<FileTreeFilter>,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    gitignores: &[&Gitignore],
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
                // Mark as truncated only when the directory actually has
                // entries — a cheap single-entry probe distinguishes "cut at
                // max_depth, more below" from "genuinely empty". Renderers use
                // this to hint the model to drill in (list_directory) rather
                // than assume the folder is empty. (UI ignores the field.)
                let has_entries = std::fs::read_dir(path)
                    .map(|mut it| it.next().is_some())
                    .unwrap_or(false);
                return Ok(FileTreeNode::Directory {
                    name,
                    path: normalize_path_for_frontend(path),
                    children: vec![],
                    expanded: false,
                    metadata: create_file_metadata(metadata, path),
                    truncated: has_entries,
                });
            }
        }
    }

    let respect_gitignore = filter
        .as_ref()
        .map(|f| f.respect_gitignore)
        .unwrap_or(false);

    // Build this directory's `.gitignore` matcher (if any) and append it to the
    // inherited stack. `own_gi` owns the matcher for this frame's lifetime;
    // `active_gitignores` is a slice of references (cheap to extend — `&Gitignore`
    // is Copy) that we hand to the children. Directories without a `.gitignore`
    // pay nothing and just forward the parent slice.
    let own_gi: Option<Gitignore> = if respect_gitignore {
        let gi_path = path.join(".gitignore");
        if gi_path.is_file() {
            let mut builder = GitignoreBuilder::new(path);
            // add() returns Option<Error> for partial-parse warnings — ignore
            // them and use whatever rules parsed cleanly.
            let _ = builder.add(&gi_path);
            builder.build().ok()
        } else {
            None
        }
    } else {
        None
    };
    let mut gi_refs: Vec<&Gitignore>;
    let active_gitignores: &[&Gitignore] = match own_gi {
        Some(ref gi) => {
            gi_refs = Vec::with_capacity(gitignores.len() + 1);
            gi_refs.extend_from_slice(gitignores);
            gi_refs.push(gi);
            &gi_refs
        }
        None => gitignores,
    };

    // Read directory entries
    let mut children = Vec::new();
    let mut visible_count: usize = 0;
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

        // Skip excluded directories (node_modules, .git, dist, build, etc.)
        if file_type.is_dir() {
            if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
                if EXCLUDED_DIRS.contains(&name) {
                    continue;
                }
            }
        }

        // Skip entries the project's .gitignore stack excludes. Runs after the
        // hard EXCLUDED_DIRS floor so that list still applies even when a repo
        // forgets to ignore node_modules etc.
        if respect_gitignore && is_gitignored(active_gitignores, &entry_path, file_type.is_dir()) {
            continue;
        }

        // Recursively build child nodes
        match build_tree_node(&entry_path, filter, depth + 1, visited, active_gitignores) {
            Ok(child_node) => {
                visible_count += 1;
                children.push(child_node);
                if visible_count >= MAX_CHILDREN_PER_DIR {
                    break;
                }
            }
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
        truncated: visible_count >= MAX_CHILDREN_PER_DIR,
    })
}

/// A file plus its last-modified time (unix seconds). Emitted by
/// `list_recent_files` for the agent's "recently modified" context hint.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub modified: u64,
}

/// Hard ceiling on entries scanned by `list_recent_files`, so a pathological
/// tree (huge monorepo with thin .gitignore) can't turn a context build into a
/// multi-second walk. Excluded dirs (node_modules, etc.) don't count toward it.
const RECENT_SCAN_BUDGET: usize = 20_000;

/// Walk `root` and return the `limit` most-recently-modified files, newest
/// first. Honours the same EXCLUDED_DIRS floor as `build_file_tree`, skips
/// hidden entries, and (when `respect_gitignore`) drops `.gitignore`d paths.
/// Used by the agent context builder to point the model at the working set
/// instead of having it hunt for "where the recent work is".
#[tauri::command]
pub async fn list_recent_files(
    root_path: String,
    limit: usize,
    respect_gitignore: bool,
) -> Result<Vec<RecentFile>, String> {
    let path = PathBuf::from(&root_path);
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", root_path));
    }
    let canonical_root = canonicalize_path(&path).map_err(|_| "Path not found".to_string())?;

    tokio::task::spawn_blocking(move || {
        let mut out: Vec<RecentFile> = Vec::new();
        let mut scanned: usize = 0;
        // Depth cap mirrors a sane project layout; deep generated trees are
        // already cut by EXCLUDED_DIRS / gitignore before we get this far.
        collect_recent(
            &canonical_root,
            respect_gitignore,
            &[],
            0,
            8,
            &mut out,
            &mut scanned,
        );
        // Newest first, then truncate to the requested count.
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        out.truncate(limit);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[allow(clippy::too_many_arguments)]
fn collect_recent(
    dir: &Path,
    respect_gitignore: bool,
    gitignores: &[&Gitignore],
    depth: usize,
    max_depth: usize,
    out: &mut Vec<RecentFile>,
    scanned: &mut usize,
) {
    if depth > max_depth || *scanned >= RECENT_SCAN_BUDGET {
        return;
    }

    let own_gi: Option<Gitignore> = if respect_gitignore {
        let gi_path = dir.join(".gitignore");
        if gi_path.is_file() {
            let mut builder = GitignoreBuilder::new(dir);
            let _ = builder.add(&gi_path);
            builder.build().ok()
        } else {
            None
        }
    } else {
        None
    };
    let mut gi_refs: Vec<&Gitignore>;
    let active: &[&Gitignore] = match own_gi {
        Some(ref gi) => {
            gi_refs = Vec::with_capacity(gitignores.len() + 1);
            gi_refs.extend_from_slice(gitignores);
            gi_refs.push(gi);
            &gi_refs
        }
        None => gitignores,
    };

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if *scanned >= RECENT_SCAN_BUDGET {
            return;
        }
        let entry_path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // Skip symlinks entirely — avoids cycles and out-of-tree surprises.
        if file_type.is_symlink() {
            continue;
        }
        let name = match entry_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let is_dir = file_type.is_dir();
        if is_dir && EXCLUDED_DIRS.contains(&name.as_str()) {
            continue;
        }
        if respect_gitignore && is_gitignored(active, &entry_path, is_dir) {
            continue;
        }

        if is_dir {
            collect_recent(
                &entry_path,
                respect_gitignore,
                active,
                depth + 1,
                max_depth,
                out,
                scanned,
            );
        } else {
            *scanned += 1;
            if let Ok(meta) = entry.metadata() {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                out.push(RecentFile {
                    path: normalize_path_for_frontend(&entry_path),
                    modified,
                });
            }
        }
    }
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

/// Lightweight existence check — single stat call, no read. Use for marker
/// probes (e.g. scaffolding detection) where you only care if a file is on
/// disk, not its contents. Returns false on any error (path traversal,
/// permission denied, missing parent) — callers treat "not exists" as the
/// safe default. Synchronous because stat() is cheap (~µs) and async would
/// add task-spawn overhead disproportionate to the work.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    let p = Path::new(&path);
    match validate_path_safe(p) {
        Ok(canonical) => canonical.exists(),
        Err(_) => false,
    }
}

/// Search common subdirectories for SQLite database files (*.db, *.sqlite, *.sqlite3).
/// Returns true if ANY database file is found in the project.
#[tauri::command]
pub fn has_database_file(project_path: String) -> bool {
    let root = Path::new(&project_path);
    if !root.exists() || !root.is_dir() {
        return false;
    }

    const SEARCH_DIRS: &[&str] = &[
        "",
        "prisma",
        "db",
        "data",
        ".data",
        "backend",
        "backend/db",
        "src/db",
        "server/db",
    ];
    const DB_EXTENSIONS: &[&str] = &["db", "sqlite", "sqlite3"];

    for dir in SEARCH_DIRS {
        let dir_path = if dir.is_empty() {
            root.to_path_buf()
        } else {
            root.join(dir)
        };
        if !dir_path.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&dir_path) {
            for entry in entries.flatten() {
                if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                    if DB_EXTENSIONS.contains(&ext) {
                        return true;
                    }
                }
            }
        }
    }
    false
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

// Append to a file (creates parent dirs and the file if needed). Used for
// JSONL operation logs (e.g. queue operations) where each call writes one
// line and we never want to read+write the whole file.
#[tauri::command]
pub async fn append_file(path: String, content: String) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    let file_path = Path::new(&path);
    let canonical = validate_path_safe(file_path)?;

    if let Some(parent) = canonical.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&canonical)
        .await?;

    file.write_all(content.as_bytes()).await?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect every file/dir name in the tree into a flat set for assertions.
    fn names(node: &FileTreeNode, out: &mut HashSet<String>) {
        match node {
            FileTreeNode::File { name, .. } => {
                out.insert(name.clone());
            }
            FileTreeNode::Directory { name, children, .. } => {
                out.insert(name.clone());
                for child in children {
                    names(child, out);
                }
            }
        }
    }

    fn build(root: &Path, respect_gitignore: bool) -> HashSet<String> {
        let filter = Some(FileTreeFilter {
            show_hidden: true,
            extensions: None,
            max_depth: Some(20),
            respect_gitignore,
        });
        let canonical = canonicalize_path(root).unwrap();
        let mut visited = HashSet::new();
        visited.insert(canonical.clone());
        let tree = build_tree_node(&canonical, &filter, 0, &mut visited, &[]).unwrap();
        let mut set = HashSet::new();
        names(&tree, &mut set);
        set
    }

    /// `.gitignore` entries are dropped only when the opt-in flag is set;
    /// negations (`!`) re-include, nested `.gitignore` files apply, and the
    /// hard EXCLUDED_DIRS floor (node_modules) is independent of all of it.
    #[test]
    fn respects_gitignore_when_opted_in() {
        let dir = std::env::temp_dir().join(format!("tm_tree_gi_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join(".gitignore"), "*.log\n!important.log\nbuilt/\n").unwrap();
        std::fs::write(dir.join("kept.ts"), "").unwrap();
        std::fs::write(dir.join("ignored.log"), "").unwrap();
        std::fs::write(dir.join("important.log"), "").unwrap();
        std::fs::create_dir_all(dir.join("built")).unwrap();
        std::fs::write(dir.join("built/out.js"), "").unwrap();
        // Nested .gitignore inside a tracked dir.
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/.gitignore"), "local.tmp\n").unwrap();
        std::fs::write(dir.join("src/app.ts"), "").unwrap();
        std::fs::write(dir.join("src/local.tmp"), "").unwrap();
        // node_modules must vanish regardless (EXCLUDED_DIRS floor).
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "").unwrap();

        // Flag OFF: everything except the hard-excluded node_modules is present.
        let off = build(&dir, false);
        assert!(off.contains("ignored.log"));
        assert!(off.contains("out.js"));
        assert!(off.contains("local.tmp"));
        assert!(!off.contains("node_modules"));

        // Flag ON: gitignored paths are gone, negation kept, nested rule applied.
        let on = build(&dir, true);
        assert!(on.contains("kept.ts"), "tracked file should remain");
        assert!(!on.contains("ignored.log"), "*.log rule drops it");
        assert!(on.contains("important.log"), "!important.log negation re-includes");
        assert!(!on.contains("out.js"), "built/ dir contents dropped");
        assert!(on.contains("app.ts"), "tracked nested file remains");
        assert!(!on.contains("local.tmp"), "nested src/.gitignore rule applied");
        assert!(!on.contains("node_modules"), "EXCLUDED_DIRS floor still holds");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
