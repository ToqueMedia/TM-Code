use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::ipc::InvokeError;
use uuid::Uuid;

// Data Structures
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub project_type: String,
    pub last_opened: String,
    pub created_at: String,
    pub metadata: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub last_opened: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectState {
    pub open_files: Vec<String>,
    pub active_file: Option<String>,
    pub cursor_positions: HashMap<String, (u32, u32)>, // line, column
    pub editor_states: HashMap<String, serde_json::Value>,
    pub window_state: WindowState,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GlobalSettings {
    pub recent_projects: Vec<RecentProject>,
    pub max_recent_projects: usize,
    pub editor_settings: HashMap<String, serde_json::Value>,
}

// Error handling
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Project not found: {0}")]
    NotFound(String),
    #[error("Invalid project path: {0}")]
    InvalidPath(String),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
}

impl From<ProjectError> for InvokeError {
    fn from(error: ProjectError) -> Self {
        InvokeError::from(error.to_string())
    }
}

type Result<T> = std::result::Result<T, ProjectError>;

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

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs();
    format!("{}", now)
}

// Project Commands
#[tauri::command]
pub fn open_project(path: String) -> Result<ProjectInfo> {
    let project_path = Path::new(&path);
    
    // Validate path exists and is accessible
    if !project_path.exists() {
        return Err(ProjectError::InvalidPath(format!("Path does not exist: {}", path)));
    }
    
    if !project_path.is_dir() {
        return Err(ProjectError::InvalidPath(format!("Path is not a directory: {}", path)));
    }
    
    // Check for required files (package.json or .git)
    let has_package_json = project_path.join("package.json").exists();
    let has_git = project_path.join(".git").exists();
    
    if !has_package_json && !has_git {
        return Err(ProjectError::InvalidPath("Project must have package.json or .git directory".to_string()));
    }
    
    // Check permissions
    let metadata = fs::metadata(&project_path)?;
    if !metadata.permissions().readonly() {
        // Try to create a temporary file to test write permissions
        let test_path = project_path.join(".toquemedia_test");
        if let Err(_) = fs::File::create(&test_path) {
            // We can't write, but we can still open for read-only
        } else {
            let _ = fs::remove_file(&test_path);
        }
    }
    
    // Generate or load project ID
    let project_id = match load_project_id(&project_path) {
        Ok(id) => id,
        Err(_) => Uuid::new_v4().to_string(),
    };
    
    // Save project ID to project directory
    save_project_id(&project_path, &project_id)?;
    
    // Create project info
    let project_name = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Untitled")
        .to_string();
    
    let project_type = if has_package_json {
        detect_project_type(&project_path)?
    } else {
        "generic".to_string()
    };
    
    let project_info = ProjectInfo {
        id: project_id,
        name: project_name,
        path: path.clone(),
        project_type,
        last_opened: now_iso(),
        created_at: now_iso(),
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
    let parent_path = project_path.parent().ok_or_else(|| {
        ProjectError::InvalidPath("Invalid project path".to_string())
    })?;
    
    if !parent_path.exists() {
        return Err(ProjectError::InvalidPath(format!("Parent directory does not exist: {:?}", parent_path)));
    }
    
    // Check if project directory already exists
    if project_path.exists() {
        return Err(ProjectError::InvalidPath(format!("Project directory already exists: {}", path)));
    }
    
    // Create project directory
    fs::create_dir_all(&project_path)?;
    
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
        ProjectTemplate::Blank => "generic".to_string(),
    };
    
    let project_info = ProjectInfo {
        id: project_id.clone(),
        name: project_name,
        path: path.clone(),
        project_type,
        last_opened: now_iso(),
        created_at: now_iso(),
        metadata: HashMap::new(),
    };
    
    // Save project ID to project directory
    save_project_id(&project_path, &project_id)?;
    
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
        return Err(ProjectError::NotFound(format!("Project metadata not found for ID: {}", project_id)));
    }
    
    // Read existing metadata
    let meta_content = fs::read_to_string(&meta_path)?;
    let mut project_info: ProjectInfo = serde_json::from_str(&meta_content)?;
    
    // Update last opened time
    project_info.last_opened = now_iso();
    
    // Save updated metadata
    let updated_meta = serde_json::json!({
        "id": project_info.id,
        "name": project_info.name,
        "path": project_info.path,
        "project_type": project_info.project_type,
        "last_opened": project_info.last_opened,
        "created_at": project_info.created_at,
        "metadata": {
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
    
    fs::write(&meta_path, serde_json::to_string_pretty(&updated_meta)?)?;
    
    // Update recent projects
    update_recent_projects(&project_info)?;
    
    Ok(())
}

#[tauri::command]
pub fn load_project_state(project_id: String) -> Result<ProjectState> {
    let meta_path = get_project_meta_path(&project_id);
    
    if !meta_path.exists() {
        return Err(ProjectError::NotFound(format!("Project metadata not found for ID: {}", project_id)));
    }
    
    let meta_content = fs::read_to_string(&meta_path)?;
    let project_info: ProjectInfo = serde_json::from_str(&meta_content)?;
    
    // Extract state from metadata
    let open_files = project_info.metadata.get("open_files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    
    let active_file = project_info.metadata.get("active_file")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    
    let cursor_positions = project_info.metadata.get("cursor_positions")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    v.as_array()
                        .and_then(|arr| {
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
    
    let editor_states = project_info.metadata.get("editor_states")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .unwrap_or_default();
    
    let window_state = project_info.metadata.get("window_state")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(WindowState {
            width: 1200,
            height: 800,
            x: 100,
            y: 100,
            maximized: false,
        });
    
    Ok(ProjectState {
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
    
    if let Some(dev_deps) = package_json.get("devDependencies").and_then(|v| v.as_object()) {
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
    
    // Load existing settings or create new ones
    let mut settings: GlobalSettings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)?;
        serde_json::from_str(&content).unwrap_or(GlobalSettings {
            recent_projects: vec![],
            max_recent_projects: 10,
            editor_settings: HashMap::new(),
        })
    } else {
        GlobalSettings {
            recent_projects: vec![],
            max_recent_projects: 10,
            editor_settings: HashMap::new(),
        }
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
        settings.recent_projects.truncate(settings.max_recent_projects);
    }
    
    // Ensure config directory exists
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)?;
    }
    
    // Save settings
    let settings_content = serde_json::to_string_pretty(&settings)?;
    fs::write(&settings_path, settings_content)?;
    
    Ok(())
}