use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tauri::State;
use thiserror::Error;
use tokio::process::{Child as TokioChild, Command as TokioCommand};
use tokio::sync::mpsc;

// Error types for debugger operations
#[derive(Debug, Error)]
pub enum DebuggerError {
    #[error("Debug session not found: {0}")]
    SessionNotFound(String),
    #[error("Failed to start debug session: {0}")]
    StartFailed(String),
    #[allow(dead_code)]
    #[error("Failed to communicate with debugger: {0}")]
    CommunicationFailed(String),
    #[allow(dead_code)]
    #[error("Invalid breakpoint: {0}")]
    InvalidBreakpoint(String),
    #[error("Node.js not found. Please ensure Node.js is installed")]
    NodeNotFound,
    #[error("Invalid debug configuration: {0}")]
    InvalidConfig(String),
}

// Types for debugger communication
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugBreakpoint {
    pub id: String,
    pub file: String,
    pub line: u32,
    pub verified: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugStackFrame {
    pub id: u32,
    pub name: String,
    pub file: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugVariable {
    pub name: String,
    pub value: String,
    pub type_name: String,
    pub has_children: bool,
    pub variables_reference: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugSession {
    pub id: String,
    pub name: String,
    pub status: DebugStatus,
    pub breakpoints: Vec<DebugBreakpoint>,
    pub current_frame: Option<DebugStackFrame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DebugStatus {
    Stopped,
    Running,
    Paused,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugConfiguration {
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub debug_type: String, // "node", "python", etc.
}

// Internal debug session management
struct InternalDebugSession {
    pub config: DebugConfiguration,
    pub process: Option<TokioChild>,
    pub status: DebugStatus,
    pub breakpoints: HashMap<String, DebugBreakpoint>,
    #[allow(dead_code)]
    pub sender: Option<mpsc::UnboundedSender<String>>,
}

// Global state for managing debug sessions
pub struct DebuggerState {
    sessions: Arc<Mutex<HashMap<String, InternalDebugSession>>>,
}

impl DebuggerState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for DebuggerState {
    fn default() -> Self {
        Self::new()
    }
}

// Helper function to check if Node.js is available
async fn check_node_availability() -> Result<String, DebuggerError> {
    let output = TokioCommand::new("node")
        .arg("--version")
        .output()
        .await
        .map_err(|_| DebuggerError::NodeNotFound)?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(version)
    } else {
        Err(DebuggerError::NodeNotFound)
    }
}

// Generate unique session ID
fn generate_session_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// Tauri commands for debugger operations

#[tauri::command]
pub async fn check_debugger_availability() -> Result<HashMap<String, String>, String> {
    let mut available_debuggers = HashMap::new();

    // Check Node.js
    if let Ok(version) = check_node_availability().await {
        available_debuggers.insert("node".to_string(), version);
    }

    Ok(available_debuggers)
}

#[tauri::command]
pub async fn start_debug_session(
    config: DebugConfiguration,
    state: State<'_, DebuggerState>,
) -> Result<String, String> {
    let session_id = generate_session_id();

    // Validate configuration
    if config.program.is_empty() {
        return Err(
            DebuggerError::InvalidConfig("Program path is required".to_string()).to_string(),
        );
    }

    // Check if the debugger is available
    match config.debug_type.as_str() {
        "node" => {
            check_node_availability().await.map_err(|e| e.to_string())?;
        }
        _ => {
            return Err(DebuggerError::InvalidConfig(format!(
                "Unsupported debug type: {}",
                config.debug_type
            ))
            .to_string());
        }
    }

    // Create internal session
    let internal_session = InternalDebugSession {
        config: config.clone(),
        process: None,
        status: DebugStatus::Stopped,
        breakpoints: HashMap::new(),
        sender: None,
    };

    // Store session
    {
        let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;
        sessions.insert(session_id.clone(), internal_session);
    }

    Ok(session_id)
}

#[tauri::command]
pub async fn stop_debug_session(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    let process_to_kill = {
        let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

        if let Some(session) = sessions.remove(&session_id) {
            session.process
        } else {
            return Err(DebuggerError::SessionNotFound(session_id).to_string());
        }
    };

    // Terminate the process if running (outside the mutex lock)
    if let Some(mut process) = process_to_kill {
        let _ = process.kill().await;
    }

    Ok(())
}

#[tauri::command]
pub async fn launch_debug_session(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    // Lock mutex, read the config, release mutex
    let config = {
        let sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

        let session = sessions
            .get(&session_id)
            .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

        session.config.clone()
    };

    // Build command based on debug type (outside the lock)
    let mut cmd = match config.debug_type.as_str() {
        "node" => {
            let mut node_cmd = TokioCommand::new("node");
            node_cmd
                .arg("--inspect-brk=9229") // Enable debugger with breakpoint on start
                .arg(&config.program)
                .args(&config.args)
                .current_dir(&config.cwd)
                .envs(&config.env)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::piped());
            node_cmd
        }
        _ => {
            return Err(DebuggerError::InvalidConfig(format!(
                "Unsupported debug type: {}",
                config.debug_type
            ))
            .to_string())
        }
    };

    // Spawn process outside the lock
    let process = cmd
        .spawn()
        .map_err(|e| DebuggerError::StartFailed(e.to_string()).to_string())?;

    // Lock mutex again, store the process and update status
    {
        let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

        session.process = Some(process);
        session.status = DebugStatus::Running;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_breakpoint(
    session_id: String,
    file: String,
    line: u32,
    state: State<'_, DebuggerState>,
) -> Result<DebugBreakpoint, String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    let breakpoint_id = format!("{}:{}:{}", session_id, file, line);
    let breakpoint = DebugBreakpoint {
        id: breakpoint_id.clone(),
        file: file.clone(),
        line,
        verified: true, // For now, assume all breakpoints are valid
        message: None,
    };

    session
        .breakpoints
        .insert(breakpoint_id, breakpoint.clone());

    Ok(breakpoint)
}

#[tauri::command]
pub async fn remove_breakpoint(
    session_id: String,
    breakpoint_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    session.breakpoints.remove(&breakpoint_id);

    Ok(())
}

#[tauri::command]
pub async fn get_breakpoints(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<Vec<DebugBreakpoint>, String> {
    let sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    let breakpoints: Vec<DebugBreakpoint> = session.breakpoints.values().cloned().collect();
    Ok(breakpoints)
}

#[tauri::command]
pub async fn debug_continue(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    // TODO: Stub — only updates local status. Requires DAP integration to control the debugger process.
    session.status = DebugStatus::Running;

    Ok(())
}

#[tauri::command]
pub async fn debug_pause(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    // TODO: Stub — only updates local status. Requires DAP integration to control the debugger process.
    session.status = DebugStatus::Paused;

    Ok(())
}

#[tauri::command]
pub async fn debug_step_over(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    // TODO: Stub — only updates local status. Requires DAP integration to control the debugger process.
    session.status = DebugStatus::Paused;

    Ok(())
}

#[tauri::command]
pub async fn debug_step_into(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    // TODO: Stub — only updates local status. Requires DAP integration to control the debugger process.
    session.status = DebugStatus::Paused;

    Ok(())
}

#[tauri::command]
pub async fn debug_step_out(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    // TODO: Stub — only updates local status. Requires DAP integration to control the debugger process.
    session.status = DebugStatus::Paused;

    Ok(())
}

#[tauri::command]
pub async fn get_debug_sessions(
    state: State<'_, DebuggerState>,
) -> Result<Vec<DebugSession>, String> {
    let sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let debug_sessions: Vec<DebugSession> = sessions
        .iter()
        .map(|(id, internal_session)| DebugSession {
            id: id.clone(),
            name: internal_session.config.name.clone(),
            status: internal_session.status.clone(),
            breakpoints: internal_session.breakpoints.values().cloned().collect(),
            current_frame: None, // Will be populated with actual debugging data
        })
        .collect();

    Ok(debug_sessions)
}

#[tauri::command]
pub async fn get_call_stack(
    session_id: String,
    state: State<'_, DebuggerState>,
) -> Result<Vec<DebugStackFrame>, String> {
    let sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let _session = sessions
        .get(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    // TODO: Not yet implemented — requires DAP (Debug Adapter Protocol) integration.
    // Returns empty results until a real debugger adapter is connected.
    Ok(vec![])
}

#[tauri::command]
pub async fn get_variables(
    session_id: String,
    _frame_id: u32,
    state: State<'_, DebuggerState>,
) -> Result<Vec<DebugVariable>, String> {
    let sessions = state.sessions.lock().map_err(|_| "Failed to acquire debugger session lock".to_string())?;

    let _session = sessions
        .get(&session_id)
        .ok_or_else(|| DebuggerError::SessionNotFound(session_id.clone()).to_string())?;

    // TODO: Not yet implemented — requires DAP (Debug Adapter Protocol) integration.
    // Returns empty results until a real debugger adapter is connected.
    Ok(vec![])
}
