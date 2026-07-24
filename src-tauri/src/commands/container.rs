use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

/// Tracks one open project for app-level command isolation.
/// Commands are clamped to the project directory (no Docker required).
#[derive(Debug, Clone)]
pub struct ActiveProject {
    pub project_path: String,
    /// Diretórios extra aprovados pelo utilizador no fluxo de permissões do
    /// agente (permissionStore.additionalDirectories). Sincronizados pelo
    /// frontend via `set_agent_allowed_directories` a cada mutação/hydrate.
    /// Sem isto, o clamp devolvia silenciosamente o cwd ao projeto mesmo
    /// depois de o utilizador ter autorizado o diretório externo no prompt.
    pub allowed_directories: Vec<String>,
}

/// Registry of ALL open projects (in-window multi-project / MDI).
///
/// Historically this was `Mutex<Option<ActiveProject>>` — a single slot — so
/// switching projects in-window REPLACED the active project and any background
/// agent run got its shell/PTY cwd clamped back to the WRONG (now-foreground)
/// project. To let N projects run agents concurrently in one window, every open
/// project is kept here keyed by id and a requested cwd is clamped against the
/// UNION of their trees. `active_id` is the project the developer is currently
/// viewing — used ONLY as the clamp fallback (a path outside every open
/// project) and as the default cwd when a command supplies none.
#[derive(Debug, Clone, Default)]
pub struct ActiveProjectRegistry {
    pub projects: HashMap<String, ActiveProject>,
    pub active_id: Option<String>,
}

impl ActiveProjectRegistry {
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty()
    }

    /// The project the developer is viewing. Falls back to any open project if
    /// `active_id` was somehow never set (defensive — the frontend always sets
    /// it on open).
    pub fn active(&self) -> Option<&ActiveProject> {
        self.active_id
            .as_ref()
            .and_then(|id| self.projects.get(id))
            .or_else(|| self.projects.values().next())
    }

    /// Default working dir when a command supplies no explicit cwd.
    pub fn default_cwd(&self) -> Option<String> {
        self.active().map(|ap| ap.project_path.clone())
    }

    /// Clamp a requested cwd to whichever OPEN project (or one of its
    /// user-approved extra dirs) contains it. Returns the path unchanged when
    /// it is inside any open project; otherwise falls back to the active
    /// project's root — the same path-traversal guard as before, now spanning
    /// every open project instead of a single one. `Path::starts_with` compares
    /// by components, so `/proj-evil` never matches `/proj`.
    pub fn clamp_cwd(&self, host_path: &str) -> String {
        let path = Path::new(host_path);
        for ap in self.projects.values() {
            if path.starts_with(&ap.project_path) {
                return host_path.to_string();
            }
            for dir in &ap.allowed_directories {
                if !dir.is_empty() && path.starts_with(dir) {
                    return host_path.to_string();
                }
            }
        }
        self.active()
            .map(|ap| ap.project_path.clone())
            .unwrap_or_else(|| host_path.to_string())
    }
}

pub type ActiveProjectState = Mutex<ActiveProjectRegistry>;

// ─── Init ────────────────────────────────────────────────────────────────────

pub fn init_container_state() -> ActiveProjectState {
    Mutex::new(ActiveProjectRegistry::default())
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn set_active(
    state: &ActiveProjectState,
    project_id: &str,
    project_path: &str,
) -> Result<(), String> {
    let mut reg = state.lock().map_err(|_| "Failed to lock active project")?;
    // Preserve approved directories when the SAME project re-activates
    // (e.g. window refocus re-runs open_project); a DIFFERENT project starts
    // clean and waits for the frontend permission hydrate to re-sync its dirs.
    reg.projects
        .entry(project_id.to_string())
        .and_modify(|ap| ap.project_path = project_path.to_string())
        .or_insert_with(|| ActiveProject {
            project_path: project_path.to_string(),
            allowed_directories: Vec::new(),
        });
    reg.active_id = Some(project_id.to_string());
    Ok(())
}

fn remove_project(state: &ActiveProjectState, project_id: &str) -> Result<(), String> {
    let mut reg = state.lock().map_err(|_| "Failed to lock active project")?;
    reg.projects.remove(project_id);
    // If the closed project was active, hand the active pointer to any other
    // still-open project so its clamp fallback / default cwd stay valid.
    if reg.active_id.as_deref() == Some(project_id) {
        reg.active_id = reg.projects.keys().next().cloned();
    }
    Ok(())
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Activate app-level isolation for a project AND register it as open.
///
/// Adds the project to the open-project registry (so its tree becomes a valid
/// cwd for shell/PTY commands) and marks it the active/foreground project.
/// Already-open projects stay registered — that is precisely what lets their
/// background agent runs keep executing after the developer switches away.
#[tauri::command]
pub async fn set_active_project(
    project_id: String,
    project_path: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    set_active(&active_project, &project_id, &project_path)
}

/// Deactivate isolation for a project and drop it from the open-project
/// registry (project closed / deleted). If it was the active project, the
/// active pointer moves to any other still-open project.
#[tauri::command]
pub async fn clear_active_project(
    project_id: String,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    remove_project(&active_project, &project_id)
}

/// Replace the set of user-approved extra directories for a project. When
/// `project_id` is omitted it targets the active project (back-compat with the
/// single-project caller). Called by the frontend permission store on every
/// grant/revoke/hydrate so the Rust-side cwd clamp stays in lockstep, per
/// project. No-op when the project is not (yet) registered.
#[tauri::command]
pub async fn set_agent_allowed_directories(
    directories: Vec<String>,
    project_id: Option<String>,
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    let mut reg = active_project
        .lock()
        .map_err(|_| "Failed to lock active project")?;
    let target = project_id.or_else(|| reg.active_id.clone());
    if let Some(id) = target {
        if let Some(ap) = reg.projects.get_mut(&id) {
            ap.allowed_directories = directories;
        }
    }
    Ok(())
}

/// Clear the ENTIRE open-project registry. Used on close-to-Welcome / expel,
/// where the window is left with no focused project and every in-window run has
/// already been aborted — so no project's tree needs to stay an allowed cwd.
/// (Switching projects does NOT call this — it keeps the others registered so
/// their background runs stay clamped correctly.)
#[tauri::command]
pub async fn clear_all_active_projects(
    active_project: State<'_, ActiveProjectState>,
) -> Result<(), String> {
    let mut reg = active_project
        .lock()
        .map_err(|_| "Failed to lock active project")?;
    reg.projects.clear();
    reg.active_id = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg_with(projects: &[(&str, &str, &[&str])]) -> ActiveProjectRegistry {
        let mut reg = ActiveProjectRegistry::default();
        for (id, path, dirs) in projects {
            reg.projects.insert(
                id.to_string(),
                ActiveProject {
                    project_path: path.to_string(),
                    allowed_directories: dirs.iter().map(|d| d.to_string()).collect(),
                },
            );
        }
        reg.active_id = projects.first().map(|(id, _, _)| id.to_string());
        reg
    }

    #[test]
    fn clamp_keeps_path_inside_any_open_project() {
        // The core multi-project invariant: a background project's cwd must NOT
        // be clamped to the active/foreground project.
        let reg = reg_with(&[("a", "/work/proj-a", &[]), ("b", "/work/proj-b", &[])]);
        assert_eq!(reg.clamp_cwd("/work/proj-b/src"), "/work/proj-b/src");
        assert_eq!(reg.clamp_cwd("/work/proj-a"), "/work/proj-a");
    }

    #[test]
    fn clamp_falls_back_to_active_when_outside_all() {
        let reg = reg_with(&[("a", "/work/proj-a", &[]), ("b", "/work/proj-b", &[])]);
        assert_eq!(reg.clamp_cwd("/etc/passwd"), "/work/proj-a");
        // Component-wise comparison: a sibling with a shared prefix must not pass.
        assert_eq!(reg.clamp_cwd("/work/proj-a-evil"), "/work/proj-a");
    }

    #[test]
    fn clamp_honours_per_project_approved_dirs() {
        let reg = reg_with(&[("a", "/work/proj-a", &["/shared/libs"])]);
        assert_eq!(reg.clamp_cwd("/shared/libs/x"), "/shared/libs/x");
        assert_eq!(reg.clamp_cwd("/shared/other"), "/work/proj-a");
    }

    #[test]
    fn remove_reassigns_active_pointer() {
        let state: ActiveProjectState = init_container_state();
        set_active(&state, "a", "/work/proj-a").unwrap();
        set_active(&state, "b", "/work/proj-b").unwrap();
        assert_eq!(state.lock().unwrap().active_id.as_deref(), Some("b"));
        remove_project(&state, "b").unwrap();
        // Active moves to the remaining open project rather than going empty.
        assert_eq!(state.lock().unwrap().active_id.as_deref(), Some("a"));
        remove_project(&state, "a").unwrap();
        assert_eq!(state.lock().unwrap().active_id, None);
    }
}
