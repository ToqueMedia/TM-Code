use flate2::read::ZlibDecoder;
use flate2::{write::ZlibEncoder, Compression};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

// Data Structures
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default = "default_project_type")]
    pub project_type: String,
    #[serde(default)]
    pub last_opened: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub metadata: HashMap<String, serde_json::Value>,
}

fn default_project_type() -> String {
    "unknown".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub last_opened: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub version: String,
    pub open_files: Vec<String>,
    pub active_file: Option<String>,
    pub cursor_positions: HashMap<String, (u32, u32)>, // line, column
    pub editor_states: HashMap<String, serde_json::Value>,
    pub window_state: WindowState,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum ProjectTemplate {
    Blank,
    React,
    Node,
    TypeScript,
    Vue,
    Python,
    Rust,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GlobalSettings {
    pub recent_projects: Vec<RecentProject>,
    pub max_recent_projects: usize,
    pub editor_settings: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ValidationResult {
    pub valid: bool,
    pub error: Option<String>,
}

// Error handling
#[derive(Debug, thiserror::Error, serde::Serialize)]
pub enum ProjectError {
    #[error("IO error: {0}")]
    Io(String),
    #[error("JSON error: {0}")]
    Json(String),
    #[error("Project not found: {0}")]
    NotFound(String),
    #[error("Invalid project path: {0}")]
    InvalidPath(String),
    #[allow(dead_code)]
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[allow(dead_code)]
    #[error("Insufficient disk space: {0}")]
    InsufficientDiskSpace(String),
    #[error("System folder: {0}")]
    SystemFolder(String),
}

impl From<std::io::Error> for ProjectError {
    fn from(err: std::io::Error) -> Self {
        ProjectError::Io(err.to_string())
    }
}

impl From<serde_json::Error> for ProjectError {
    fn from(err: serde_json::Error) -> Self {
        ProjectError::Json(err.to_string())
    }
}

pub type Result<T, E = ProjectError> = std::result::Result<T, E>;

// Helper functions
fn get_config_dir() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_dir.join("toquemedia-studio")
}

fn get_projects_dir() -> PathBuf {
    get_config_dir().join("projects")
}

fn get_settings_path() -> PathBuf {
    get_config_dir().join("settings.json")
}

fn get_project_meta_path(project_id: &str) -> PathBuf {
    get_projects_dir().join(project_id).join("meta.json")
}

#[allow(dead_code)]
fn get_project_permissions_path(project_id: &str) -> PathBuf {
    get_projects_dir().join(project_id).join("permissions.json")
}

fn now_unix_secs() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs();
    format!("{}", now)
}

// Validation Commands
#[tauri::command]
pub fn validate_project_path(path: String) -> Result<ValidationResult> {
    let project_path = Path::new(&path);

    // Validate path exists and is accessible
    if !project_path.exists() {
        return Ok(ValidationResult {
            valid: false,
            error: Some(format!("Path does not exist: {}", path)),
        });
    }

    if !project_path.is_dir() {
        return Ok(ValidationResult {
            valid: false,
            error: Some(format!("Path is not a directory: {}", path)),
        });
    }

    // Check for system folders
    if is_system_folder(project_path) {
        return Ok(ValidationResult {
            valid: false,
            error: Some("Cannot open system folders".to_string()),
        });
    }

    // Check for required files (package.json or .git)
    let has_package_json = project_path.join("package.json").exists();
    let has_git = project_path.join(".git").exists();

    if !has_package_json && !has_git {
        return Ok(ValidationResult {
            valid: false,
            error: Some("Project must have package.json or .git directory".to_string()),
        });
    }

    // Check permissions
    let metadata = fs::metadata(project_path)?;
    if metadata.permissions().readonly() {
        return Ok(ValidationResult {
            valid: false,
            error: Some("No write permissions for this directory".to_string()),
        });
    }

    Ok(ValidationResult {
        valid: true,
        error: None,
    })
}

#[tauri::command]
pub fn validate_project_name(name: String) -> Result<ValidationResult> {
    if name.trim().is_empty() {
        return Ok(ValidationResult {
            valid: false,
            error: Some("Project name is required".to_string()),
        });
    }

    // Check for invalid characters (npm naming rules)
    if !is_valid_npm_name(&name) {
        return Ok(ValidationResult {
            valid: false,
            error: Some("Project name can only contain lowercase letters, numbers, hyphens, and underscores. Must start with a letter.".to_string()),
        });
    }

    // Check length
    if name.len() > 214 {
        return Ok(ValidationResult {
            valid: false,
            error: Some("Project name is too long (max 214 characters)".to_string()),
        });
    }

    Ok(ValidationResult {
        valid: true,
        error: None,
    })
}

#[tauri::command]
pub fn validate_project_location(location: String) -> Result<ValidationResult> {
    let location_path = Path::new(&location);

    // Validate path exists and is accessible
    if !location_path.exists() {
        return Ok(ValidationResult {
            valid: false,
            error: Some(format!("Location does not exist: {}", location)),
        });
    }

    if !location_path.is_dir() {
        return Ok(ValidationResult {
            valid: false,
            error: Some(format!("Location is not a directory: {}", location)),
        });
    }

    // Check for system folders
    if is_system_folder(location_path) {
        return Ok(ValidationResult {
            valid: false,
            error: Some("Cannot create projects in system folders".to_string()),
        });
    }

    // Check permissions
    let metadata = fs::metadata(location_path)?;
    if metadata.permissions().readonly() {
        return Ok(ValidationResult {
            valid: false,
            error: Some("No write permissions for this location".to_string()),
        });
    }

    Ok(ValidationResult {
        valid: true,
        error: None,
    })
}

// Project Commands
#[tauri::command]
pub fn open_project(path: String) -> Result<ProjectInfo> {
    let project_path = Path::new(&path);

    // Validate path exists and is accessible
    if !project_path.exists() {
        return Err(ProjectError::InvalidPath(format!(
            "Path does not exist: {}",
            path
        )));
    }

    if !project_path.is_dir() {
        return Err(ProjectError::InvalidPath(format!(
            "Path is not a directory: {}",
            path
        )));
    }

    // Check for system folders
    if is_system_folder(project_path) {
        return Err(ProjectError::SystemFolder(
            "Cannot open system folders".to_string(),
        ));
    }

    // Check for required files (package.json or .git)
    let has_package_json = project_path.join("package.json").exists();
    let has_git = project_path.join(".git").exists();

    if !has_package_json && !has_git {
        return Err(ProjectError::InvalidPath(
            "Project must have package.json or .git directory".to_string(),
        ));
    }

    // Check permissions
    let metadata = fs::metadata(project_path)?;
    if metadata.permissions().readonly() {
        // Try to create a temporary file to test write permissions
        let test_path = project_path.join(".toquemedia_test");
        if let Ok(_) = fs::File::create(&test_path) {
            if let Err(e) = fs::remove_file(&test_path) {
                eprintln!("Warning: failed to remove test file {:?}: {}", test_path, e);
                // Retry once
                let _ = fs::remove_file(&test_path);
            }
        }
    }

    // Generate or load project ID
    let project_id = match load_project_id(project_path) {
        Ok(id) => id,
        Err(_) => Uuid::new_v4().to_string(),
    };

    // Save project ID to project directory
    save_project_id(project_path, &project_id)?;

    // Create project info
    let project_name = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let project_type = if has_package_json {
        detect_project_type(project_path)?
    } else {
        "generic".to_string()
    };

    let project_info = ProjectInfo {
        id: project_id,
        name: project_name,
        path: path.clone(),
        project_type,
        last_opened: now_unix_secs(),
        created_at: now_unix_secs(),
        metadata: HashMap::new(),
    };

    // Update recent projects
    update_recent_projects(&project_info)?;

    // Save project metadata
    save_project_metadata(&project_info)?;

    Ok(project_info)
}

#[tauri::command]
pub fn create_project(path: String, template: ProjectTemplate) -> Result<ProjectInfo> {
    let project_path = Path::new(&path);

    // Validate parent directory exists and is writable
    let parent_path = project_path
        .parent()
        .ok_or_else(|| ProjectError::InvalidPath("Invalid project path".to_string()))?;

    if !parent_path.exists() {
        return Err(ProjectError::InvalidPath(format!(
            "Parent directory does not exist: {:?}",
            parent_path
        )));
    }

    // Check if project directory already exists
    if project_path.exists() {
        return Err(ProjectError::InvalidPath(format!(
            "Project directory already exists: {}",
            path
        )));
    }

    // Check for system folders
    if is_system_folder(parent_path) {
        return Err(ProjectError::SystemFolder(
            "Cannot create projects in system folders".to_string(),
        ));
    }

    // Create project directory
    fs::create_dir_all(project_path)?;

    // Apply template
    match template {
        ProjectTemplate::Blank => {
            // Create a basic package.json
            let package_json = serde_json::json!({
                "name": project_path.file_name().and_then(|n| n.to_str()).unwrap_or("project"),
                "version": "1.0.0",
                "description": "",
                "main": "index.js",
                "scripts": {
                    "test": "echo \"Error: no test specified\" && exit 1"
                },
                "keywords": [],
                "author": "",
                "license": "ISC"
            });
            fs::write(
                project_path.join("package.json"),
                serde_json::to_string_pretty(&package_json)?,
            )?;
        }
        ProjectTemplate::React => {
            // Create React project structure
            fs::create_dir_all(project_path.join("src"))?;

            let package_json = serde_json::json!({
                "name": project_path.file_name().and_then(|n| n.to_str()).unwrap_or("react-project"),
                "version": "1.0.0",
                "description": "",
                "main": "src/index.js",
                "scripts": {
                    "start": "react-scripts start",
                    "build": "react-scripts build",
                    "test": "react-scripts test",
                    "eject": "react-scripts eject"
                },
                "dependencies": {
                    "react": "^18.2.0",
                    "react-dom": "^18.2.0",
                    "react-scripts": "5.0.1"
                },
                "browserslist": {
                    "production": [
                        ">0.2%",
                        "not dead",
                        "not op_mini all"
                    ],
                    "development": [
                        "last 1 chrome version",
                        "last 1 firefox version",
                        "last 1 safari version"
                    ]
                }
            });
            fs::write(
                project_path.join("package.json"),
                serde_json::to_string_pretty(&package_json)?,
            )?;

            fs::write(
                project_path.join("src/index.js"),
                "import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);",
            )?;

            fs::write(
                project_path.join("src/App.js"),
                "import React from 'react';

function App() {
  return (
    <div className=\"App\">
      <h1>Hello, React!</h1>
    </div>
  );
}

export default App;",
            )?;
        }
        ProjectTemplate::Node => {
            // Create Node.js project structure
            let package_json = serde_json::json!({
                "name": project_path.file_name().and_then(|n| n.to_str()).unwrap_or("node-project"),
                "version": "1.0.0",
                "description": "",
                "main": "index.js",
                "scripts": {
                    "start": "node index.js",
                    "test": "echo \"Error: no test specified\" && exit 1"
                },
                "keywords": [],
                "author": "",
                "license": "ISC"
            });
            fs::write(
                project_path.join("package.json"),
                serde_json::to_string_pretty(&package_json)?,
            )?;

            fs::write(
                project_path.join("index.js"),
                "console.log('Hello, Node.js!');",
            )?;
        }
        ProjectTemplate::TypeScript => {
            // Create TypeScript project structure
            fs::create_dir_all(project_path.join("src"))?;

            let package_json = serde_json::json!({
                "name": project_path.file_name().and_then(|n| n.to_str()).unwrap_or("typescript-project"),
                "version": "1.0.0",
                "description": "",
                "main": "dist/index.js",
                "scripts": {
                    "build": "tsc",
                    "start": "node dist/index.js",
                    "dev": "ts-node src/index.ts"
                },
                "devDependencies": {
                    "typescript": "^5.0.0",
                    "ts-node": "^10.9.1",
                    "@types/node": "^18.0.0"
                }
            });
            fs::write(
                project_path.join("package.json"),
                serde_json::to_string_pretty(&package_json)?,
            )?;

            let ts_config = serde_json::json!({
                "compilerOptions": {
                    "target": "es2016",
                    "module": "commonjs",
                    "outDir": "./dist",
                    "rootDir": "./src",
                    "strict": true,
                    "esModuleInterop": true,
                    "skipLibCheck": true,
                    "forceConsistentCasingInFileNames": true
                }
            });
            fs::write(
                project_path.join("tsconfig.json"),
                serde_json::to_string_pretty(&ts_config)?,
            )?;

            fs::write(
                project_path.join("src/index.ts"),
                "console.log('Hello, TypeScript!');",
            )?;
        }
        ProjectTemplate::Vue => {
            // Create Vue.js project structure
            fs::create_dir_all(project_path.join("src"))?;
            fs::create_dir_all(project_path.join("src/components"))?;

            let package_json = serde_json::json!({
                "name": project_path.file_name().and_then(|n| n.to_str()).unwrap_or("vue-project"),
                "version": "1.0.0",
                "description": "",
                "main": "src/main.js",
                "scripts": {
                    "dev": "vite",
                    "build": "vite build",
                    "preview": "vite preview"
                },
                "dependencies": {
                    "vue": "^3.3.0"
                },
                "devDependencies": {
                    "@vitejs/plugin-vue": "^4.0.0",
                    "vite": "^4.0.0"
                }
            });
            fs::write(
                project_path.join("package.json"),
                serde_json::to_string_pretty(&package_json)?,
            )?;

            fs::write(
                project_path.join("index.html"),
                "<!DOCTYPE html>
<html lang=\"en\">
  <head>
    <meta charset=\"UTF-8\">
    <link rel=\"icon\" href=\"/favicon.ico\">
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
    <title>Vue.js App</title>
  </head>
  <body>
    <div id=\"app\"></div>
    <script type=\"module\" src=\"/src/main.js\"></script>
  </body>
</html>",
            )?;

            fs::write(
                project_path.join("vite.config.js"),
                "import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
})",
            )?;

            fs::write(
                project_path.join("src/main.js"),
                "import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')",
            )?;

            fs::write(
                project_path.join("src/App.vue"),
                "<template>
  <div id=\"app\">
    <h1>Hello, Vue.js!</h1>
  </div>
</template>

<script>
export default {
  name: 'App'
}
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
  margin-top: 60px;
}
</style>",
            )?;
        }
        ProjectTemplate::Python => {
            // Create Python project structure
            fs::create_dir_all(project_path.join("src"))?;

            // Create basic Python project files
            fs::write(project_path.join("requirements.txt"), "")?;

            fs::write(
                project_path.join("setup.py"),
                "from setuptools import setup, find_packages

setup(
    name=\"python-project\",
    version=\"0.1.0\",
    packages=find_packages(where=\"src\"),
    package_dir={\"\": \"src\"},
    install_requires=[],
    author=\"Your Name\",
    author_email=\"your.email@example.com\",
    description=\"A Python project\",
)",
            )?;

            fs::write(project_path.join("src/__init__.py"), "")?;

            fs::write(
                project_path.join("src/main.py"),
                "def main():
    print(\"Hello, Python!\")

if __name__ == \"__main__\":
    main()",
            )?;

            // Create README
            fs::write(
                project_path.join("README.md"),
                "# Python Project

## Setup

```bash
pip install -r requirements.txt
```

## Run

```bash
python src/main.py
```",
            )?;
        }
        ProjectTemplate::Rust => {
            // Create Rust project structure using cargo
            let project_name = project_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("rust-project");

            // Create Cargo.toml
            let cargo_toml = format!(
                "[package]
name = \"{}\"
version = \"0.1.0\"
edition = \"2021\"

# See more keys and their definitions at https://doc.rust-lang.org/cargo/reference/manifest.html

[dependencies]",
                project_name
            );

            fs::write(project_path.join("Cargo.toml"), cargo_toml)?;

            fs::create_dir_all(project_path.join("src"))?;

            fs::write(
                project_path.join("src/main.rs"),
                "fn main() {
    println!(\"Hello, Rust!\");
}",
            )?;

            // Create README
            fs::write(
                project_path.join("README.md"),
                format!(
                    "# {}

Welcome to your Rust project!

## Build

```bash
cargo build
```

## Run

```bash
cargo run
```",
                    project_name
                ),
            )?;
        }
    }

    // Create project info
    let project_id = Uuid::new_v4().to_string();
    let project_name = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let project_type = match template {
        ProjectTemplate::React => "react".to_string(),
        ProjectTemplate::Node => "node".to_string(),
        ProjectTemplate::TypeScript => "typescript".to_string(),
        ProjectTemplate::Vue => "vue".to_string(),
        ProjectTemplate::Python => "python".to_string(),
        ProjectTemplate::Rust => "rust".to_string(),
        ProjectTemplate::Blank => "generic".to_string(),
    };

    let project_info = ProjectInfo {
        id: project_id.clone(),
        name: project_name,
        path: path.clone(),
        project_type,
        last_opened: now_unix_secs(),
        created_at: now_unix_secs(),
        metadata: HashMap::new(),
    };

    // Save project ID to project directory
    save_project_id(project_path, &project_id)?;

    // Update recent projects
    update_recent_projects(&project_info)?;

    // Save project metadata
    save_project_metadata(&project_info)?;

    Ok(project_info)
}

#[tauri::command]
pub fn get_recent_projects() -> Result<Vec<RecentProject>> {
    let settings_path = get_settings_path();

    if !settings_path.exists() {
        return Ok(vec![]);
    }

    let settings_content = fs::read_to_string(&settings_path)?;
    let settings: GlobalSettings = serde_json::from_str(&settings_content)?;

    // Filter out projects that no longer exist
    let mut valid_projects = Vec::new();
    for project in settings.recent_projects {
        if Path::new(&project.path).exists() {
            valid_projects.push(project);
        }
    }

    Ok(valid_projects)
}

#[tauri::command]
pub fn save_project_state(project_id: String, state: ProjectState) -> Result<()> {
    let meta_path = get_project_meta_path(&project_id);

    if !meta_path.exists() {
        return Err(ProjectError::NotFound(format!(
            "Project metadata not found for ID: {}",
            project_id
        )));
    }

    // Read existing metadata — handle both compressed and plain JSON formats
    let raw_data = fs::read(&meta_path)?;
    let meta_content = match decompress_data(&raw_data) {
        Ok(decompressed) => decompressed,
        Err(_) => String::from_utf8(raw_data)
            .map_err(|e| ProjectError::Io(format!("Invalid metadata encoding: {}", e)))?,
    };
    let mut project_info: ProjectInfo = serde_json::from_str(&meta_content)?;

    // Update last opened time
    project_info.last_opened = now_unix_secs();

    // Save updated metadata
    let updated_meta = serde_json::json!({
        "id": project_info.id,
        "name": project_info.name,
        "path": project_info.path,
        "project_type": project_info.project_type,
        "last_opened": project_info.last_opened,
        "created_at": project_info.created_at,
        "metadata": {
            "version": "1.0.0",
            "open_files": state.open_files,
            "active_file": state.active_file,
            "cursor_positions": state.cursor_positions,
            "editor_states": state.editor_states,
            "window_state": state.window_state
        }
    });

    // Ensure directory exists
    if let Some(parent) = meta_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Compress the metadata before saving
    let json_string = serde_json::to_string(&updated_meta)?;
    let compressed_data = compress_data(json_string.as_bytes())?;

    fs::write(&meta_path, compressed_data)?;

    // Update recent projects
    update_recent_projects(&project_info)?;

    Ok(())
}

#[tauri::command]
pub fn load_project_state(project_id: String) -> Result<ProjectState> {
    let meta_path = get_project_meta_path(&project_id);

    if !meta_path.exists() {
        return Err(ProjectError::NotFound(format!(
            "Project metadata not found for ID: {}",
            project_id
        )));
    }

    // Read metadata — handle both compressed and plain JSON formats
    let raw_data = fs::read(&meta_path)?;
    let json_string = match decompress_data(&raw_data) {
        Ok(decompressed) => decompressed,
        Err(_) => String::from_utf8(raw_data)
            .map_err(|e| ProjectError::Io(format!("Invalid metadata encoding: {}", e)))?,
    };
    let project_info: ProjectInfo = serde_json::from_str(&json_string)?;

    // Extract state from metadata
    let version = project_info
        .metadata
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();

    let open_files = project_info
        .metadata
        .get("open_files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    let active_file = project_info
        .metadata
        .get("active_file")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let cursor_positions = project_info
        .metadata
        .get("cursor_positions")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    v.as_array().and_then(|arr| {
                        if arr.len() >= 2 {
                            let line = arr[0].as_u64()?;
                            let col = arr[1].as_u64()?;
                            Some((k.clone(), (line as u32, col as u32)))
                        } else {
                            None
                        }
                    })
                })
                .collect::<HashMap<String, (u32, u32)>>()
        })
        .unwrap_or_default();

    let editor_states = project_info
        .metadata
        .get("editor_states")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .unwrap_or_default();

    let window_state = project_info
        .metadata
        .get("window_state")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(WindowState {
            width: 1200,
            height: 800,
            x: 100,
            y: 100,
            maximized: false,
        });

    Ok(ProjectState {
        version,
        open_files,
        active_file,
        cursor_positions,
        editor_states,
        window_state,
    })
}

// Helper functions
fn load_project_id(project_path: &Path) -> Result<String> {
    let id_path = project_path.join(".toquemedia-id");
    if id_path.exists() {
        let id = fs::read_to_string(&id_path)?;
        Ok(id.trim().to_string())
    } else {
        Err(ProjectError::NotFound("Project ID not found".to_string()))
    }
}

fn save_project_id(project_path: &Path, project_id: &str) -> Result<()> {
    let id_path = project_path.join(".toquemedia-id");
    fs::write(&id_path, project_id)?;
    Ok(())
}

fn detect_project_type(project_path: &Path) -> Result<String> {
    let package_path = project_path.join("package.json");
    if !package_path.exists() {
        return Ok("generic".to_string());
    }

    let package_content = fs::read_to_string(&package_path)?;
    let package_json: serde_json::Value = serde_json::from_str(&package_content)?;

    // Check for common dependencies
    if let Some(deps) = package_json.get("dependencies").and_then(|v| v.as_object()) {
        if deps.contains_key("react") {
            return Ok("react".to_string());
        }
        if deps.contains_key("vue") {
            return Ok("vue".to_string());
        }
    }

    if let Some(dev_deps) = package_json
        .get("devDependencies")
        .and_then(|v| v.as_object())
    {
        if dev_deps.contains_key("typescript") {
            return Ok("typescript".to_string());
        }
    }

    Ok("node".to_string())
}

fn save_project_metadata(project_info: &ProjectInfo) -> Result<()> {
    let meta_path = get_project_meta_path(&project_info.id);

    // Ensure directory exists
    if let Some(parent) = meta_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let meta_content = serde_json::to_string_pretty(project_info)?;
    fs::write(&meta_path, meta_content)?;

    Ok(())
}

fn update_recent_projects(project_info: &ProjectInfo) -> Result<()> {
    let settings_path = get_settings_path();

    let default_settings = GlobalSettings {
        recent_projects: vec![],
        max_recent_projects: 10,
        editor_settings: HashMap::new(),
    };

    // Load existing settings or create new ones
    let mut settings: GlobalSettings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)?;
        match serde_json::from_str(&content) {
            Ok(s) => s,
            Err(_) => {
                // Backup corrupted settings file before overwriting
                let backup_path = settings_path.with_extension("json.bak");
                let _ = fs::copy(&settings_path, &backup_path);
                default_settings
            }
        }
    } else {
        default_settings
    };

    // Remove existing entry if it exists
    settings.recent_projects.retain(|p| p.id != project_info.id);

    // Create new recent project entry
    let recent_project = RecentProject {
        id: project_info.id.clone(),
        name: project_info.name.clone(),
        path: project_info.path.clone(),
        last_opened: project_info.last_opened.clone(),
    };

    // Insert at the beginning
    settings.recent_projects.insert(0, recent_project);

    // Limit to max_recent_projects
    if settings.recent_projects.len() > settings.max_recent_projects {
        settings
            .recent_projects
            .truncate(settings.max_recent_projects);
    }

    // Ensure config directory exists
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Atomic write: write to temp file then rename to prevent corruption
    let settings_content = serde_json::to_string_pretty(&settings)?;
    let tmp_path = settings_path.with_extension("json.tmp");
    fs::write(&tmp_path, &settings_content)?;
    fs::rename(&tmp_path, &settings_path)?;

    Ok(())
}

fn is_system_folder(path: &Path) -> bool {
    // Canonicalize to resolve symlinks and normalize the path
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path_str = canonical.to_string_lossy();

    let system_paths = [
        "/System",
        "/Library",
        "/Applications",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/proc",
        "/sys",
        "/dev",
        "/run",
        "/tmp",
        "/var",
        "/boot",
        "/root",
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\ProgramData",
        "C:\\Recovery",
        "C:\\System Volume Information",
    ];

    // Case-insensitive comparison for macOS/Windows compatibility
    let path_lower = path_str.to_lowercase();
    for sys_path in &system_paths {
        if path_lower.starts_with(&sys_path.to_lowercase()) {
            return true;
        }
    }

    false
}

fn is_valid_npm_name(name: &str) -> bool {
    // npm naming rules:
    // - Must be lowercase
    // - Can contain letters, numbers, hyphens, and underscores
    // - Must start with a letter
    // - Max 214 characters
    if name.is_empty() || name.len() > 214 {
        return false;
    }

    let first_char = name.chars().next().unwrap();
    if !first_char.is_ascii_lowercase() {
        return false;
    }

    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn decompress_data(compressed_data: &[u8]) -> Result<String> {
    use crate::commands::file_tree::MAX_DECOMPRESS_SIZE;

    let mut decoder = ZlibDecoder::new(compressed_data);
    let mut decompressed_data = Vec::new();
    let mut buf = [0u8; 8192];
    let mut total_read: usize = 0;

    loop {
        let n = decoder.read(&mut buf).map_err(|e| {
            ProjectError::Io(format!("Decompression failed: {}", e))
        })?;
        if n == 0 {
            break;
        }
        total_read += n;
        if total_read > MAX_DECOMPRESS_SIZE {
            return Err(ProjectError::Io(format!(
                "Decompressed data exceeds maximum allowed size ({} MB)",
                MAX_DECOMPRESS_SIZE / (1024 * 1024)
            )));
        }
        decompressed_data.extend_from_slice(&buf[..n]);
    }

    String::from_utf8(decompressed_data).map_err(|e| {
        ProjectError::Io(format!("Decompressed data is not valid UTF-8: {}", e))
    })
}

fn compress_data(data: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)?;
    let compressed_data = encoder.finish()?;
    Ok(compressed_data)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectStatus {
    pub exists: bool,
    pub permissions_changed: bool,
    pub last_modified: Option<u64>,
}

/// Validates that a project_id is a safe UUID (no path traversal).
fn validate_project_id(project_id: &str) -> Result<()> {
    if project_id.is_empty()
        || project_id.contains('/')
        || project_id.contains('\\')
        || project_id.contains("..")
    {
        return Err(ProjectError::InvalidPath(format!(
            "Invalid project ID: {}",
            project_id
        )));
    }
    Ok(())
}

/// Internal helper: removes a project from the recent list in settings.json.
/// Does NOT delete metadata or project files.
fn remove_project_from_settings(project_id: &str) -> Result<()> {
    let settings_path = get_settings_path();

    if !settings_path.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&settings_path)?;
    let mut settings: GlobalSettings = serde_json::from_str(&content)?;

    settings.recent_projects.retain(|p| p.id != project_id);

    let settings_content = serde_json::to_string_pretty(&settings)?;
    let tmp_path = settings_path.with_extension("json.tmp");
    fs::write(&tmp_path, &settings_content)?;
    fs::rename(&tmp_path, &settings_path)?;

    Ok(())
}

/// Removes a project's metadata directory from the config folder.
fn remove_project_metadata(project_id: &str) -> Result<()> {
    validate_project_id(project_id)?;
    let meta_dir = get_projects_dir().join(project_id);
    if meta_dir.exists() {
        let _ = fs::remove_dir_all(&meta_dir);
    }
    Ok(())
}

#[tauri::command]
pub fn remove_from_recent_projects(project_id: String) -> Result<()> {
    validate_project_id(&project_id)?;
    remove_project_from_settings(&project_id)
}

#[tauri::command]
pub fn delete_project(project_id: String, project_path: String) -> Result<()> {
    validate_project_id(&project_id)?;

    let path = Path::new(&project_path);

    if path.exists() && path.is_dir() {
        // Canonicalize to resolve symlinks before safety checks
        let canonical = fs::canonicalize(path)
            .map_err(|e| ProjectError::Io(format!("Cannot resolve path: {}", e)))?;

        // Safety: don't delete system folders
        if is_system_folder(&canonical) {
            return Err(ProjectError::SystemFolder(
                "Cannot delete system folders".to_string(),
            ));
        }

        // Safety: verify this is actually a project (has .toquemedia-id).
        // We also accept an empty directory — a previous partial delete may have
        // removed .toquemedia-id but failed to remove the root folder.
        let is_project = canonical.join(".toquemedia-id").exists();
        let is_empty_dir = !is_project && fs::read_dir(&canonical)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false);

        if !is_project && !is_empty_dir {
            return Err(ProjectError::InvalidPath(
                "Directory is not a recognized project (missing .toquemedia-id)".to_string(),
            ));
        }

        // Delete the project directory.
        // remove_dir_all can partially succeed (contents removed but root dir
        // remains) when a background process still holds a handle.
        if let Err(_first_err) = fs::remove_dir_all(&canonical) {
            // Brief yield to let OS release file handles from killed processes.
            std::thread::sleep(std::time::Duration::from_millis(250));

            if canonical.exists() {
                // Retry full removal (handles may be released now)
                if let Err(_) = fs::remove_dir_all(&canonical) {
                    // Last resort: if only the empty root dir remains, remove it
                    if canonical.exists() {
                        fs::remove_dir(&canonical)?;
                    }
                }
            }
        }
    }

    // Always clean up references regardless of whether path existed
    remove_project_from_settings(&project_id)?;
    remove_project_metadata(&project_id)?;

    Ok(())
}

#[tauri::command]
pub fn check_project_status(path: String) -> Result<ProjectStatus> {
    let project_path = Path::new(&path);

    // Check if project still exists
    let exists = project_path.exists() && project_path.is_dir();

    // Get last modified time if it exists
    let last_modified = if exists {
        if let Ok(metadata) = fs::metadata(project_path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                    Some(duration.as_secs())
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    // Check for permission changes
    let permissions_changed = if exists {
        // In a real implementation, we would compare current permissions with stored ones
        // For now, we'll just return false
        false
    } else {
        false
    };

    Ok(ProjectStatus {
        exists,
        permissions_changed,
        last_modified,
    })
}
