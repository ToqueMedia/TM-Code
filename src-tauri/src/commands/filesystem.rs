use glob::glob as glob_match;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Validates that a template ID contains only safe characters (alphanumeric, hyphens).
/// Prevents path traversal via crafted IDs like "../../../etc".
fn validate_template_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("Template ID cannot be empty".to_string());
    }
    if id.contains("..") || id.contains('/') || id.contains('\\') || id.contains('\0') {
        return Err(format!("Invalid template ID: {}", id));
    }
    // Allow only alphanumeric, hyphens, and underscores
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid template ID: {}", id));
    }
    Ok(())
}

/// Scaffold a template from bundled resources to a destination directory.
/// Resolves the template path internally via Tauri's resource system —
/// the frontend never sends raw filesystem paths.
#[tauri::command]
pub async fn scaffold_template(
    app: tauri::AppHandle,
    template_id: String,
    destination: String,
) -> Result<(), String> {
    validate_template_id(&template_id)?;

    let dest_path = Path::new(&destination);
    if !dest_path.exists() {
        std::fs::create_dir_all(dest_path)
            .map_err(|e| format!("Failed to create destination: {}", e))?;
    }

    // Resolve template from bundled resources via Tauri's resource resolver.
    // In dev mode this resolves to src-tauri/resources/templates/{id}.
    // In production this resolves into the app bundle's resource directory.
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

    let template_path = resource_dir
        .join("resources")
        .join("templates")
        .join(&template_id);

    if !template_path.exists() || !template_path.is_dir() {
        return Err(format!(
            "Template '{}' not found at {:?}",
            template_id, template_path
        ));
    }

    let mut visited = HashSet::new();
    copy_dir_safe(&template_path, dest_path, &mut visited)
        .map_err(|e| format!("Failed to scaffold template: {}", e))
}

/// Generic copy_directory exposed to the frontend.
/// Validates source/destination and uses safe recursive copy.
#[tauri::command]
pub async fn copy_directory(source: String, destination: String) -> Result<(), String> {
    let source_path = Path::new(&source);
    let dest_path = Path::new(&destination);

    if !source_path.exists() {
        return Err(format!("Source does not exist: {}", source));
    }

    // Canonicalize to prevent path traversal via symlinks in the source arg
    let canonical_source =
        std::fs::canonicalize(source_path).map_err(|e| format!("Invalid source path: {}", e))?;

    let mut visited = HashSet::new();
    copy_dir_safe(&canonical_source, dest_path, &mut visited)
        .map_err(|e| format!("Failed to copy directory: {}", e))
}

/// Recursively copies a directory, skipping symlinks and tracking visited
/// inodes to prevent infinite loops from circular symlinks.
fn copy_dir_safe(src: &Path, dst: &Path, visited: &mut HashSet<PathBuf>) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    // Track canonical path to detect cycles
    if let Ok(canonical) = std::fs::canonicalize(src) {
        if !visited.insert(canonical) {
            // Already visited this directory — cycle detected, skip
            return Ok(());
        }
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_entry = dst.join(entry.file_name());

        // Skip symlinks entirely — templates should never contain them
        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            copy_dir_safe(&entry.path(), &dest_entry, visited)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest_entry)?;
        }
        // Skip special files (sockets, pipes, etc.)
    }

    Ok(())
}

#[tauri::command]
pub async fn glob_files(pattern: String, directory: String) -> Result<Vec<String>, String> {
    // Block path traversal in pattern
    if pattern.contains("..") {
        return Err("Invalid glob pattern: '..' is not allowed".to_string());
    }
    // Block absolute patterns
    if pattern.starts_with('/') || pattern.starts_with('\\') {
        return Err("Invalid glob pattern: absolute paths are not allowed".to_string());
    }

    let full_pattern = format!("{}/{}", directory, pattern);

    // Canonicalize directory to compare results against
    let canonical_dir =
        std::fs::canonicalize(&directory).map_err(|e| format!("Invalid directory: {}", e))?;

    let mut results = Vec::new();

    let entries = glob_match(&full_pattern).map_err(|e| format!("Invalid glob pattern: {}", e))?;

    for entry in entries {
        match entry {
            Ok(path) => {
                // Verify result is within directory (defense in depth)
                if let Ok(canonical_path) = std::fs::canonicalize(&path) {
                    if !canonical_path.starts_with(&canonical_dir) {
                        continue;
                    }
                }

                let path_str = path.to_string_lossy().to_string();
                if !path_str.contains("/node_modules/")
                    && !path_str.contains("/.git/")
                    && !path_str.contains("/dist/")
                    && !path_str.contains("/build/")
                {
                    results.push(path_str);
                }
            }
            Err(e) => {
                eprintln!("Glob error: {}", e);
            }
        }
    }

    if results.len() > 500 {
        results.truncate(500);
    }

    Ok(results)
}
