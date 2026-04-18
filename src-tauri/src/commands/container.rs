use std::path::Path;
use std::sync::Mutex;
use tauri::State;

/// Tracks the active project for app-level command isolation.
/// Commands are clamped to the project directory (no Docker required).
#[derive(Debug, Clone)]
pub struct ActiveProject {
    pub project_id: String,
    pub project_path: String,
}

pub type ActiveProjectState = Mutex<Option<ActiveProject>>;

// ─── Init ────────────────────────────────────────────────────────────────────

pub fn init_container_state() -> ActiveProjectState {
    Mutex::new(None)
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/// Clamp a host path so it cannot escape the project directory.
/// If the path is outside, returns `project_path`.
///
/// Uses `Path::starts_with` which compares by path components,
/// so `/project-evil` won't match `/project`.
pub fn clamp_to_project(host_path: &str, project_path: &str) -> String {
    if Path::new(host_path).starts_with(project_path) {
        host_path.to_string()
    } else {
        project_path.to_string()
    }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn set_active(
    state: &ActiveProjectState,
    project_id: &str,
    project_path: &str,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "Failed to lock active project")?;
    *guard = Some(ActiveProject {
        project_id: project_id.to_string(),
        project_path: project_path.to_string(),
    });
    Ok(())
}

fn clear_active_if_matches(state: &ActiveProjectState, project_id: &str) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "Failed to lock active project")?;
    if let Some(ref ap) = *guard {
        if ap.project_id == project_id {
            *guard = None;
        }
    }
    Ok(())
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Activate app-level isolation for a project.
///
/// Sets the project as active so that `execute_command` clamps cwd
/// to the project directory, preventing path traversal attacks.
#[tauri::command]
pub async fn set_active_project(
    project_id: String,
    project_path: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    set_active(&active_project, &project_id, &project_path)
}

/// Deactivate isolation for a project.
#[tauri::command]
pub async fn clear_active_project(
    project_id: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    clear_active_if_matches(&active_project, &project_id)
}
