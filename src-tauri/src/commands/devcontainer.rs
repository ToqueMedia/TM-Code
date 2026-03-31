use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Parsed devcontainer.json configuration (v1 subset).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevcontainerConfig {
    /// Display name for the dev container.
    #[serde(default)]
    pub name: Option<String>,

    /// Pre-built image to use (mutually exclusive with `build`).
    #[serde(default)]
    pub image: Option<String>,

    /// Build configuration when using a Dockerfile.
    #[serde(default)]
    pub build: Option<DevcontainerBuild>,

    /// Ports to forward from the container to the host.
    #[serde(default)]
    pub forward_ports: Option<Vec<u16>>,

    /// Environment variables set on the container for all processes.
    #[serde(default)]
    pub container_env: Option<std::collections::HashMap<String, String>>,

    /// Default working directory inside the container.
    #[serde(default)]
    pub workspace_folder: Option<String>,

    /// Command(s) to run after the container is created (first time only).
    #[serde(default)]
    pub post_create_command: Option<LifecycleCommand>,

    /// Command(s) to run every time the container starts.
    #[serde(default)]
    pub post_start_command: Option<LifecycleCommand>,

    /// User to run commands as inside the container.
    #[serde(default)]
    pub remote_user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevcontainerBuild {
    /// Path to Dockerfile, relative to devcontainer.json location.
    pub dockerfile: String,

    /// Build context path, relative to devcontainer.json location.
    /// Defaults to the directory containing devcontainer.json.
    #[serde(default)]
    pub context: Option<String>,

    /// Build arguments passed to `docker build --build-arg`.
    #[serde(default)]
    pub args: Option<std::collections::HashMap<String, String>>,

    /// Target build stage.
    #[serde(default)]
    pub target: Option<String>,
}

/// A lifecycle command can be a single string or an array of strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LifecycleCommand {
    /// Shell string: `"npm install"`
    Shell(String),
    /// Exec form: `["npm", "install"]`
    Exec(Vec<String>),
}

impl LifecycleCommand {
    /// Convert to a shell command string for `sh -c`.
    /// Exec form args are individually shell-escaped.
    /// Shell form is sanitized to block dangerous metacharacters.
    pub fn to_shell_string(&self) -> String {
        match self {
            LifecycleCommand::Shell(s) => {
                // Block dangerous shell patterns that indicate injection attempts.
                // Legitimate lifecycle commands are simple (e.g. "npm install && npm run build").
                let blocked = [
                    "$(", "`",           // command substitution
                    ">/dev/tcp",         // bash TCP redirect
                    "| bash", "| sh",    // pipe to shell
                    "curl ", "wget ",    // download + execute patterns
                    "eval ", "exec ",    // dynamic execution
                    "rm -rf /",          // destructive
                ];
                let lower = s.to_lowercase();
                for pattern in &blocked {
                    if lower.contains(pattern) {
                        return format!("echo 'Blocked: devcontainer command contains disallowed pattern: {}'", pattern);
                    }
                }
                s.clone()
            }
            LifecycleCommand::Exec(parts) => parts
                .iter()
                .map(|p| {
                    if p.contains(' ') || p.contains('\'') || p.contains('"') || p.contains('\\') {
                        // Wrap in single quotes, escaping inner single quotes
                        format!("'{}'", p.replace('\'', "'\\''"))
                    } else {
                        p.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

/// Search for devcontainer.json in a project directory.
///
/// Checks (in order):
///   1. `.devcontainer/devcontainer.json`
///   2. `.devcontainer.json`
///
/// Returns the path to the config file if found.
pub fn find_devcontainer_config(project_path: &str) -> Option<PathBuf> {
    let root = Path::new(project_path);

    let candidates = [
        root.join(".devcontainer").join("devcontainer.json"),
        root.join(".devcontainer.json"),
    ];

    candidates.into_iter().find(|p| p.is_file())
}

/// Parse a devcontainer.json file.
pub fn parse_devcontainer_config(config_path: &Path) -> Result<DevcontainerConfig, String> {
    let content = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read devcontainer.json: {}", e))?;

    // Strip JSON comments (// and /* */) — devcontainer.json allows them
    let stripped = strip_json_comments(&content);

    serde_json::from_str::<DevcontainerConfig>(&stripped)
        .map_err(|e| format!("Failed to parse devcontainer.json: {}", e))
}

/// Detect and parse devcontainer config for a project. Returns None if not found.
pub fn load_devcontainer_config(project_path: &str) -> Option<DevcontainerConfig> {
    let config_path = find_devcontainer_config(project_path)?;
    match parse_devcontainer_config(&config_path) {
        Ok(config) => Some(config),
        Err(e) => {
            eprintln!("[devcontainer] {}", e);
            None
        }
    }
}

/// Resolve the directory containing devcontainer.json (for Dockerfile context).
pub fn config_dir(project_path: &str) -> PathBuf {
    let root = Path::new(project_path);
    let devcontainer_dir = root.join(".devcontainer");
    if devcontainer_dir.is_dir() {
        devcontainer_dir
    } else {
        root.to_path_buf()
    }
}

/// Strip single-line (//) and multi-line (/* */) comments from JSON.
/// devcontainer.json officially supports JSONC (JSON with Comments).
fn strip_json_comments(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escape_next = false;

    while let Some(&ch) = chars.peek() {
        if escape_next {
            result.push(chars.next().unwrap());
            escape_next = false;
            continue;
        }

        if in_string {
            if ch == '\\' {
                escape_next = true;
            } else if ch == '"' {
                in_string = false;
            }
            result.push(chars.next().unwrap());
            continue;
        }

        if ch == '"' {
            in_string = true;
            result.push(chars.next().unwrap());
            continue;
        }

        if ch == '/' {
            chars.next();
            match chars.peek() {
                Some(&'/') => {
                    // Single-line comment — skip until newline
                    for c in chars.by_ref() {
                        if c == '\n' {
                            result.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    // Multi-line comment — skip until */
                    chars.next(); // consume *
                    loop {
                        match chars.next() {
                            Some('*') if chars.peek() == Some(&'/') => {
                                chars.next(); // consume /
                                break;
                            }
                            Some('\n') => result.push('\n'), // preserve line numbers
                            None => break,
                            _ => {}
                        }
                    }
                }
                _ => {
                    result.push('/');
                }
            }
            continue;
        }

        result.push(chars.next().unwrap());
    }

    result
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

/// Detect and return devcontainer config for a project (if present).
#[tauri::command]
pub async fn detect_devcontainer(
    project_path: String,
) -> Result<Option<DevcontainerConfig>, String> {
    Ok(load_devcontainer_config(&project_path))
}
