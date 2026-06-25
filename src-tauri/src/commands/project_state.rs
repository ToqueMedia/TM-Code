use std::path::{Path, PathBuf};

use uuid::Uuid;

use super::{canonicalize_path, normalize_path_for_frontend};

const APP_STATE_DIR: &str = ".toquemedia-studio";
const PROJECTS_DIR: &str = "projects";
const PROJECT_ID_FILE: &str = ".toquemedia-id";

const MIGRATE_DIRS: &[&str] = &["sessions", "checkpoints", "collab", "memory"];
const MIGRATE_FILES: &[&str] = &[
    "editor-state.json",
    "permissions.json",
    "tasks.json",
    "http-client.json",
    "deploy-state.json",
];

fn validate_project_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err(format!("Invalid project id length: {}", id.len()));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("Invalid project id: {}", id));
    }
    if id.starts_with('.') || id.contains("..") {
        return Err(format!("Invalid project id: {}", id));
    }
    Ok(())
}

pub(crate) fn ensure_project_id(project_path: &Path) -> Result<String, String> {
    let id_path = project_path.join(PROJECT_ID_FILE);
    if id_path.exists() {
        let id = std::fs::read_to_string(&id_path)
            .map_err(|e| format!("Failed to read .toquemedia-id: {}", e))?;
        let id = id.trim().to_string();
        validate_project_id(&id)?;
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    std::fs::write(&id_path, &id).map_err(|e| format!("Failed to create .toquemedia-id: {}", e))?;
    Ok(id)
}

pub(crate) fn project_state_root(project_path: &str) -> Result<PathBuf, String> {
    let project = Path::new(project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical =
        canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;
    let project_id = ensure_project_id(&canonical)?;
    #[cfg(target_os = "windows")]
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("TM Code");

    #[cfg(not(target_os = "windows"))]
    let base = dirs::home_dir()
        .ok_or_else(|| "Failed to resolve home directory".to_string())?
        .join(APP_STATE_DIR);

    Ok(base.join(PROJECTS_DIR).join(project_id))
}

pub(crate) fn legacy_project_state_dir(project_path: &str) -> Result<PathBuf, String> {
    let project = Path::new(project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical =
        canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;
    Ok(canonical.join(".toquemedia"))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("Failed to create {:?}: {}", dst, e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("Failed to read {:?}: {}", src, e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry in {:?}: {}", src, e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let ty = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {:?}: {}", src_path, e))?;
        if ty.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if ty.is_file() {
            if dst_path.exists() {
                continue;
            }
            if let Some(parent) = dst_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create {:?}: {}", parent, e))?;
            }
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy {:?} to {:?}: {}", src_path, dst_path, e))?;
        }
    }
    Ok(())
}

fn copy_file_if_present(src: &Path, dst: &Path) -> Result<bool, String> {
    if !src.exists() {
        return Ok(false);
    }
    if dst.exists() {
        return Ok(true);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {:?}: {}", parent, e))?;
    }
    std::fs::copy(src, dst).map_err(|e| format!("Failed to copy {:?} to {:?}: {}", src, dst, e))?;
    Ok(true)
}

fn remove_legacy_dir_if_empty(dir: &Path) {
    let Ok(mut entries) = std::fs::read_dir(dir) else {
        return;
    };
    if entries.next().is_none() {
        let _ = std::fs::remove_dir(dir);
    }
}

#[tauri::command]
pub async fn get_project_state_dir(project_path: String) -> Result<String, String> {
    let root = project_state_root(&project_path)?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;
    Ok(normalize_path_for_frontend(&root))
}

#[tauri::command]
pub async fn migrate_project_state(project_path: String) -> Result<(), String> {
    let root = project_state_root(&project_path)?;
    let legacy = legacy_project_state_dir(&project_path)?;
    if !legacy.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create project state directory: {}", e))?;

    for name in MIGRATE_DIRS {
        let src = legacy.join(name);
        if !src.exists() {
            continue;
        }
        let dst = root.join(name);
        copy_dir_recursive(&src, &dst)?;
        std::fs::remove_dir_all(&src)
            .map_err(|e| format!("Failed to remove migrated {:?}: {}", src, e))?;
    }

    for name in MIGRATE_FILES {
        let src = legacy.join(name);
        let dst = root.join(name);
        if copy_file_if_present(&src, &dst)? {
            std::fs::remove_file(&src)
                .map_err(|e| format!("Failed to remove migrated {:?}: {}", src, e))?;
        }
    }

    let gitignore = legacy.join(".gitignore");
    if gitignore.exists() {
        let _ = std::fs::remove_file(&gitignore);
    }
    remove_legacy_dir_if_empty(&legacy);
    Ok(())
}
