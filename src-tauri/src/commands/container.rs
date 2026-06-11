use std::path::Path;
use std::sync::Mutex;
use tauri::State;

/// Tracks the active project for app-level command isolation.
/// Commands are clamped to the project directory (no Docker required).
#[derive(Debug, Clone)]
pub struct ActiveProject {
    pub project_id: String,
    pub project_path: String,
    /// Diretórios extra aprovados pelo utilizador no fluxo de permissões do
    /// agente (permissionStore.additionalDirectories). Sincronizados pelo
    /// frontend via `set_agent_allowed_directories` a cada mutação/hydrate.
    /// Sem isto, o clamp devolvia silenciosamente o cwd ao projeto mesmo
    /// depois de o utilizador ter autorizado o diretório externo no prompt.
    pub allowed_directories: Vec<String>,
}

pub type ActiveProjectState = Mutex<Option<ActiveProject>>;

// ─── Init ────────────────────────────────────────────────────────────────────

pub fn init_container_state() -> ActiveProjectState {
    Mutex::new(None)
}

// ─── Path helpers ────────────────────────────────────────────────────────────

/// Clamp a host path to the project directory OR any user-approved extra
/// directory. Falls back to `project_path` when outside all of them.
/// Uses `Path::starts_with`, which compares by path components, so
/// `/project-evil` won't match `/project`. Honours the permission grants the
/// user made in the agent's "acesso a diretório externo" prompt.
pub fn clamp_to_allowed(host_path: &str, ap: &ActiveProject) -> String {
    let path = Path::new(host_path);
    if path.starts_with(&ap.project_path) {
        return host_path.to_string();
    }
    for dir in &ap.allowed_directories {
        if !dir.is_empty() && path.starts_with(dir) {
            return host_path.to_string();
        }
    }
    ap.project_path.clone()
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn set_active(
    state: &ActiveProjectState,
    project_id: &str,
    project_path: &str,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "Failed to lock active project")?;
    // Preserve approved directories when the SAME project re-activates
    // (e.g. window refocus re-runs open_project); a different project starts
    // clean and waits for the frontend permission hydrate to re-sync.
    let allowed_directories = match guard.as_ref() {
        Some(prev) if prev.project_id == project_id => prev.allowed_directories.clone(),
        _ => Vec::new(),
    };
    *guard = Some(ActiveProject {
        project_id: project_id.to_string(),
        project_path: project_path.to_string(),
        allowed_directories,
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

/// Replace the set of user-approved extra directories for the active project.
/// Called by the frontend permission store on every grant/revoke/hydrate so
/// the Rust-side cwd clamp stays in lockstep with the permission prompts.
/// No-op when no project is active (commands run unrestricted in that case).
#[tauri::command]
pub async fn set_agent_allowed_directories(
    directories: Vec<String>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    let mut guard = active_project
        .lock()
        .map_err(|_| "Failed to lock active project")?;
    if let Some(ref mut ap) = *guard {
        ap.allowed_directories = directories;
    }
    Ok(())
}
