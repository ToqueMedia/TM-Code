use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use serde::{Deserialize, Serialize};
use tauri::State;
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize)]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
}

// Estado global para manter histórico de comandos
type CommandHistory = Mutex<Vec<String>>;
type ProcessMap = Mutex<HashMap<u32, std::process::Child>>;

#[tauri::command]
pub async fn execute_command(command: String, cwd: Option<String>) -> Result<CommandResult, String> {
    let working_dir = match cwd {
        Some(dir) => PathBuf::from(dir),
        None => env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?,
    };

    // Parse command and arguments
    let parts: Vec<&str> = command.trim().split_whitespace().collect();
    if parts.is_empty() {
        return Err("Empty command".to_string());
    }

    let cmd = parts[0];
    let args = &parts[1..];

    // Execute command
    let output = Command::new(cmd)
        .args(args)
        .current_dir(&working_dir)
        .output()
        .map_err(|e| format!("Failed to execute command '{}': {}", cmd, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    let success = output.status.success();

    Ok(CommandResult {
        stdout,
        stderr,
        exit_code,
        success,
    })
}

#[tauri::command]
pub async fn start_interactive_shell(cwd: Option<String>) -> Result<ProcessInfo, String> {
    let working_dir = match cwd {
        Some(dir) => PathBuf::from(dir),
        None => env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?,
    };

    // Determine shell command based on OS
    let (shell_cmd, shell_args) = if cfg!(target_os = "windows") {
        ("cmd".to_string(), vec!["/C".to_string()])
    } else {
        // Use user's preferred shell or default to bash
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (shell, vec!["-i".to_string()])
    };

    let child = Command::new(&shell_cmd)
        .args(&shell_args)
        .current_dir(&working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start interactive shell: {}", e))?;

    let pid = child.id();
    
    Ok(ProcessInfo {
        pid,
        command: shell_cmd,
        args: shell_args,
        cwd: working_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<bool, String> {
    // On Unix systems, use kill command
    if cfg!(unix) {
        let output = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;

        Ok(output.status.success())
    } else {
        // On Windows, use taskkill
        let output = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;

        Ok(output.status.success())
    }
}

#[tauri::command]
pub async fn get_current_directory() -> Result<String, String> {
    let cwd = env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?;
    
    Ok(cwd.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_home_directory() -> Result<String, String> {
    let home_dir = dirs::home_dir()
        .ok_or("Failed to get home directory")?;
    
    Ok(home_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn change_directory(path: String) -> Result<String, String> {
    let new_path = PathBuf::from(path);
    
    if !new_path.exists() {
        return Err(format!("Directory does not exist: {}", new_path.display()));
    }
    
    if !new_path.is_dir() {
        return Err(format!("Path is not a directory: {}", new_path.display()));
    }
    
    env::set_current_dir(&new_path)
        .map_err(|e| format!("Failed to change directory: {}", e))?;
    
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn command_exists(command: String) -> Result<bool, String> {
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = Command::new(which_cmd)
        .arg(&command)
        .output()
        .map_err(|e| format!("Failed to check command existence: {}", e))?;

    Ok(output.status.success())
}

#[tauri::command]
pub async fn get_environment_variables() -> Result<HashMap<String, String>, String> {
    let mut env_vars = HashMap::new();
    
    for (key, value) in env::vars() {
        env_vars.insert(key, value);
    }
    
    Ok(env_vars)
}

#[tauri::command]
pub async fn get_completions(partial: String, cwd: Option<String>) -> Result<Vec<String>, String> {
    let working_dir = match cwd {
        Some(dir) => PathBuf::from(dir),
        None => env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?,
    };

    let mut completions = Vec::new();

    // Simple file/directory completion
    if let Some(parent) = working_dir.parent() {
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.starts_with(&partial) {
                        completions.push(name.to_string());
                    }
                }
            }
        }
    }

    // Limit results
    completions.truncate(20);
    completions.sort();
    
    Ok(completions)
}

#[tauri::command]
pub async fn get_command_history(
    history_state: State<'_, CommandHistory>
) -> Result<Vec<String>, String> {
    let history = history_state.lock().map_err(|_| "Failed to lock history")?;
    Ok(history.clone())
}

#[tauri::command]
pub async fn save_command_to_history(
    command: String,
    history_state: State<'_, CommandHistory>
) -> Result<(), String> {
    let mut history = history_state.lock().map_err(|_| "Failed to lock history")?;
    
    // Avoid duplicates
    if let Some(last) = history.last() {
        if last == &command {
            return Ok(());
        }
    }
    
    history.push(command);
    
    // Limit history size
    const MAX_HISTORY: usize = 1000;
    if history.len() > MAX_HISTORY {
        let len = history.len();
        history.drain(0..len - MAX_HISTORY);
    }
    
    Ok(())
}

#[tauri::command]
pub async fn clear_command_history(
    history_state: State<'_, CommandHistory>
) -> Result<(), String> {
    let mut history = history_state.lock().map_err(|_| "Failed to lock history")?;
    history.clear();
    Ok(())
}

// Função helper removida - não é mais necessária no Tauri v2

// Função para inicializar o estado do terminal
pub fn init_terminal_state() -> (CommandHistory, ProcessMap) {
    (
        Mutex::new(Vec::new()),
        Mutex::new(HashMap::new()),
    )
}