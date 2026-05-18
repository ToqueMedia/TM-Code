use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};

// === State ===

/// Each server's stdin and pending_requests are behind their own Arc<Mutex>
/// so we can release the global `servers` lock before doing I/O.
///
/// `alive` is an AtomicBool that the stdout reader task sets to false
/// when the server process dies. mcp_send_request checks this before
/// registering a pending request, closing the race window between
/// process death and drain of pending requests.
struct McpServerInner {
    child: Child,
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: Arc<Mutex<u64>>,
    alive: Arc<AtomicBool>,
    name: String,
    status: McpServerStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum McpServerStatus {
    Starting,
    Running,
    Error,
    Stopped,
}

pub struct McpState {
    servers: Mutex<HashMap<String, McpServerInner>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct McpServerInfo {
    pub name: String,
    pub status: McpServerStatus,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct McpEnvVar {
    pub key: String,
    pub value: String,
}

// === Commands ===

#[tauri::command]
pub async fn mcp_start_server(
    state: tauri::State<'_, McpState>,
    name: String,
    command: String,
    args: Vec<String>,
    env: Vec<McpEnvVar>,
) -> Result<(), String> {
    let mut servers = state.servers.lock().await;

    // Stop existing server with the same name
    if let Some(mut existing) = servers.remove(&name) {
        existing.alive.store(false, Ordering::SeqCst);
        let _ = existing.child.kill().await;
        let mut pending = existing.pending_requests.lock().await;
        pending.clear();
    }

    // Build command
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Prevent visible console window on Windows.
    // tokio::process::Command has an inherent `creation_flags` method on Windows,
    // so no `use CommandExt` import is needed.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Tauri apps launched from Finder inherit a stripped PATH (typically just
    // /usr/bin:/bin:/usr/sbin:/sbin), so `npx`, `node`, `bun` and similar
    // commonly-installed-via-nvm/Homebrew binaries can't be found. A user
    // reported "Failed to start MCP server 'Chakra-UI V3': No such file or
    // directory" — root cause was that npx (the entry the MCP config used)
    // wasn't on the inherited PATH. Use the same PATH augmentation as the
    // terminal command: prefer the extracted user-login PATH, fall back to
    // a curated prefix that covers nvm, pnpm, bun, cargo, and Homebrew.
    #[cfg(unix)]
    {
        if let Some(path) = crate::commands::terminal::get_user_path() {
            cmd.env("PATH", path);
        } else {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
            let inherited = std::env::var("PATH").unwrap_or_default();
            let nvm_bin = std::fs::read_dir(format!("{}/.nvm/versions/node", home))
                .ok()
                .and_then(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                        .max_by_key(|e| e.file_name())
                        .map(|e| format!("{}/bin", e.path().display()))
                })
                .unwrap_or_default();
            let prepend = [
                nvm_bin.as_str(),
                &format!("{}/.local/share/pnpm", home),
                &format!("{}/.bun/bin", home),
                &format!("{}/.cargo/bin", home),
                "/opt/homebrew/bin",
                "/usr/local/bin",
            ]
            .iter()
            .filter(|d| !d.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(":");
            cmd.env("PATH", format!("{}:{}", prepend, inherited));
        }
    }

    for env_var in &env {
        cmd.env(&env_var.key, &env_var.value);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start MCP server '{}': {}", name, e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture stdin".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    let pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));

    // Spawn stdout reader task.
    // When the server process dies, lines() returns None, the loop exits.
    // The task sets alive=false FIRST (so new requests are rejected immediately),
    // THEN drains pending requests (so existing waiters fail fast).
    let pending_clone = pending_requests.clone();
    let alive_clone = alive.clone();
    let server_name = name.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(response) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = response.get("id").and_then(|v| v.as_u64()) {
                    let mut pending = pending_clone.lock().await;
                    if let Some(sender) = pending.remove(&id) {
                        let _ = sender.send(response);
                    }
                }
            }
        }

        // Mark dead BEFORE draining — new requests will see alive=false
        // and fail immediately instead of inserting into the pending map.
        alive_clone.store(false, Ordering::SeqCst);

        // Drain all pending requests so existing waiters fail fast.
        let mut pending = pending_clone.lock().await;
        let drained_count = pending.len();
        let drained: HashMap<u64, oneshot::Sender<Value>> = pending.drain().collect();
        for (id, sender) in drained {
            let _ = sender.send(serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32000,
                    "message": format!("MCP server '{}' process exited", server_name)
                }
            }));
        }

        eprintln!(
            "MCP server '{}' stdout reader exited, drained {} pending requests",
            server_name, drained_count
        );
    });

    servers.insert(
        name.clone(),
        McpServerInner {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending_requests,
            next_id: Arc::new(Mutex::new(1)),
            alive,
            name,
            status: McpServerStatus::Running,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn mcp_stop_server(
    state: tauri::State<'_, McpState>,
    name: String,
) -> Result<(), String> {
    let mut servers = state.servers.lock().await;

    if let Some(mut server) = servers.remove(&name) {
        server.alive.store(false, Ordering::SeqCst);
        let _ = server.child.kill().await;
        let mut pending = server.pending_requests.lock().await;
        pending.clear();
        Ok(())
    } else {
        Err(format!("MCP server '{}' not found", name))
    }
}

#[tauri::command]
pub async fn mcp_send_request(
    state: tauri::State<'_, McpState>,
    name: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    // Phase 1: Acquire global lock ONLY to clone the Arc handles + increment id.
    // Release it BEFORE any I/O.
    let (stdin_handle, pending_handle, alive_handle, id) = {
        let mut servers = state.servers.lock().await;

        let server = servers
            .get_mut(&name)
            .ok_or_else(|| format!("MCP server '{}' not found or not running", name))?;

        // Check alive flag BEFORE doing anything — rejects requests to dead servers
        // even if they haven't been removed from the HashMap yet.
        if !server.alive.load(Ordering::SeqCst) {
            return Err(format!("MCP server '{}' has exited", name));
        }

        let mut next_id = server.next_id.lock().await;
        let id = *next_id;
        *next_id += 1;

        (
            server.stdin.clone(),
            server.pending_requests.clone(),
            server.alive.clone(),
            id,
        )
    };
    // Global servers lock is now released.

    // Build JSON-RPC request
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });

    let mut request_str = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;
    request_str.push('\n');

    // Double-check alive before registering pending request.
    // This closes the race window: even if the server died between
    // the first check (inside the lock) and now, we catch it here.
    if !alive_handle.load(Ordering::SeqCst) {
        return Err(format!("MCP server '{}' has exited", name));
    }

    // Register pending request BEFORE writing (so the reader can match it)
    let rx = {
        let (tx, rx) = oneshot::channel();
        let mut pending = pending_handle.lock().await;
        pending.insert(id, tx);
        rx
    };

    // Phase 2: Write to stdin (only holds the stdin lock, not the global one)
    {
        let mut stdin = stdin_handle.lock().await;
        if let Err(e) = stdin.write_all(request_str.as_bytes()).await {
            // Write failed — remove the pending request we just inserted
            let mut pending = pending_handle.lock().await;
            pending.remove(&id);
            return Err(format!("Failed to write to MCP server '{}': {}", name, e));
        }
        if let Err(e) = stdin.flush().await {
            let mut pending = pending_handle.lock().await;
            pending.remove(&id);
            return Err(format!("Failed to flush stdin: {}", e));
        }
    }

    // Phase 3: Wait for response with timeout
    let response = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| format!("MCP request timed out after 30s (method: {})", method))?
        .map_err(|_| "MCP response channel closed (server may have exited)".to_string())?;

    // Check for JSON-RPC error
    if let Some(error) = response.get("error") {
        return Err(format!(
            "MCP error: {}",
            error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
        ));
    }

    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

/// Send a JSON-RPC notification (no `id`, no response expected).
/// Used for MCP protocol notifications like `notifications/initialized`.
#[tauri::command]
pub async fn mcp_send_notification(
    state: tauri::State<'_, McpState>,
    name: String,
    method: String,
    params: Value,
) -> Result<(), String> {
    // Acquire global lock only to clone handles
    let (stdin_handle, alive_handle) = {
        let servers = state.servers.lock().await;
        let server = servers
            .get(&name)
            .ok_or_else(|| format!("MCP server '{}' not found or not running", name))?;

        if !server.alive.load(Ordering::SeqCst) {
            return Err(format!("MCP server '{}' has exited", name));
        }

        (server.stdin.clone(), server.alive.clone())
    };

    // Build JSON-RPC notification (no "id" field — server must not respond)
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });

    let mut notification_str = serde_json::to_string(&notification)
        .map_err(|e| format!("Failed to serialize notification: {}", e))?;
    notification_str.push('\n');

    // Double-check alive before writing
    if !alive_handle.load(Ordering::SeqCst) {
        return Err(format!("MCP server '{}' has exited", name));
    }

    let mut stdin = stdin_handle.lock().await;
    stdin
        .write_all(notification_str.as_bytes())
        .await
        .map_err(|e| {
            format!(
                "Failed to write notification to MCP server '{}': {}",
                name, e
            )
        })?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn mcp_list_servers(
    state: tauri::State<'_, McpState>,
) -> Result<Vec<McpServerInfo>, String> {
    let servers = state.servers.lock().await;

    let infos: Vec<McpServerInfo> = servers
        .values()
        .map(|s| McpServerInfo {
            name: s.name.clone(),
            status: if s.alive.load(Ordering::SeqCst) {
                s.status.clone()
            } else {
                McpServerStatus::Stopped
            },
            error: None,
        })
        .collect();

    Ok(infos)
}

#[tauri::command]
pub async fn mcp_stop_all_servers(state: tauri::State<'_, McpState>) -> Result<(), String> {
    let mut servers = state.servers.lock().await;

    for (_, mut server) in servers.drain() {
        server.alive.store(false, Ordering::SeqCst);
        let _ = server.child.kill().await;
        let mut pending = server.pending_requests.lock().await;
        pending.clear();
    }

    Ok(())
}
