use glob::glob as glob_match;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

use super::normalize_path_for_frontend;

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

                let path_str = normalize_path_for_frontend(&path);
                // Check excluded directories (always uses / after normalization)
                let has_excluded = |segment: &str| path_str.contains(&format!("/{}/", segment));
                if !has_excluded("node_modules")
                    && !has_excluded(".git")
                    && !has_excluded("dist")
                    && !has_excluded("build")
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

// === Bundled Skills ===

#[derive(Debug, Serialize)]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct SkillContent {
    pub content: String,
    pub references: Vec<String>,
}

/// Lists all bundled skills from the app's resource directory.
/// Each skill is a directory containing a SKILL.md file.
#[tauri::command]
pub async fn list_skills_bundled(app: tauri::AppHandle) -> Result<Vec<SkillEntry>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

    let skills_dir = resource_dir.join("resources").join("skills");

    if !skills_dir.exists() || !skills_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();

    let read_dir = std::fs::read_dir(&skills_dir)
        .map_err(|e| format!("Failed to read skills directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            let skill_file = path.join("SKILL.md");
            if skill_file.exists() {
                let name = entry.file_name().to_string_lossy().to_string();
                entries.push(SkillEntry {
                    name,
                    path: normalize_path_for_frontend(&path),
                });
            }
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Reads the content of a skill directory (SKILL.md + optional references/*.md).
#[tauri::command]
pub async fn read_skill_content(skill_path: String) -> Result<SkillContent, String> {
    let base = Path::new(&skill_path);

    // Read main SKILL.md
    let skill_file = base.join("SKILL.md");
    let content = std::fs::read_to_string(&skill_file)
        .map_err(|e| format!("Failed to read SKILL.md: {}", e))?;

    // Read optional references
    let mut references = Vec::new();
    let refs_dir = base.join("references");
    if refs_dir.exists() && refs_dir.is_dir() {
        if let Ok(read_dir) = std::fs::read_dir(&refs_dir) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "md") {
                    if let Ok(ref_content) = std::fs::read_to_string(&path) {
                        references.push(ref_content);
                    }
                }
            }
        }
    }

    Ok(SkillContent {
        content,
        references,
    })
}
