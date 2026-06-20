//! Live-preview tunnel — the SHARER (Member A) side.
//!
//! Replaces the old changeset code-sharing with a P2P HTTP tunnel: a teammate
//! shares their RUNNING app (a build without HMR served on a local port) and
//! other members open it and test it from their own machine. The WebRTC mesh
//! (+ DO relay fallback) carries the HTTP request/response between members; this
//! command is the leaf on the sharer's side that actually hits their local dev
//! server and returns the response.
//!
//! Binary-safe: unlike `http_client_request` (which lossily decodes the body as
//! UTF-8 text), this carries the request + response body as **base64** so images,
//! fonts, wasm and other binary assets round-trip intact.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelFetchInput {
    /// Absolute URL on the sharer's machine, e.g. http://localhost:4173/login.
    pub url: String,
    pub method: String,
    /// Forwarded request headers (host/connection are dropped below).
    pub headers: Vec<(String, String)>,
    /// Request body, base64-encoded (empty/absent for GET).
    pub body_base64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelFetchOutput {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// Response body, base64-encoded (binary-safe).
    pub body_base64: String,
}

/// Headers that must NOT be forwarded verbatim to the local dev server — they
/// describe the tunnel hop, not the upstream request.
fn is_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
    )
}

#[tauri::command]
pub async fn tunnel_fetch(input: TunnelFetchInput) -> Result<TunnelFetchOutput, String> {
    // Only loopback targets — the sharer exposes THEIR OWN dev server, never an
    // arbitrary host (this command is reachable from the mesh).
    let lower = input.url.to_ascii_lowercase();
    let is_local = lower.starts_with("http://localhost")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("http://[::1]")
        || lower.starts_with("https://localhost")
        || lower.starts_with("https://127.0.0.1");
    if !is_local {
        return Err("tunnel_fetch only serves loopback (localhost) targets".to_string());
    }

    let method = Method::from_bytes(input.method.to_uppercase().as_bytes())
        .map_err(|_| format!("Invalid HTTP method: {}", input.method))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        // The dev server is local + trusted; don't follow redirects so the
        // viewer's browser handles them against the tunnel origin.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client build failed: {}", e))?;

    let mut req = client.request(method, &input.url);
    for (k, v) in &input.headers {
        if !is_hop_header(k) {
            req = req.header(k, v);
        }
    }
    if let Some(b64) = &input.body_base64 {
        if !b64.is_empty() {
            let bytes = B64
                .decode(b64)
                .map_err(|e| format!("bad body base64: {}", e))?;
            req = req.body(bytes);
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("tunnel upstream request failed: {}", e))?;

    let status = resp.status().as_u16();
    let mut headers: Vec<(String, String)> = Vec::new();
    for (k, v) in resp.headers() {
        if is_hop_header(k.as_str()) {
            continue;
        }
        if let Ok(s) = v.to_str() {
            headers.push((k.to_string(), s.to_string()));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read upstream body: {}", e))?;

    Ok(TunnelFetchOutput {
        status,
        headers,
        body_base64: B64.encode(&bytes),
    })
}

// ===========================================================================
// Live-preview tunnel — the VIEWER (Member B) side.
// ===========================================================================
//
// A local HTTP proxy on 127.0.0.1:<random-port>. The preview window loads it as
// a normal `http://` origin (max compatibility — cookies, relative URLs, web
// APIs all behave). Each incoming request is bridged to the frontend, which
// tunnels it over the WebRTC mesh to the sharer and delivers the response back
// via `tunnel_deliver`. The HTTP handler blocks on a per-request channel until
// that delivery (or a timeout).

struct ProxyResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct ProxyState {
    stop: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<String, Sender<ProxyResponse>>>>,
}

fn proxy_slot() -> &'static Mutex<Option<ProxyState>> {
    static PROXY: OnceLock<Mutex<Option<ProxyState>>> = OnceLock::new();
    PROXY.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProxyRequestEvent {
    req_id: String,
    method: String,
    /// Path + query, e.g. "/login?next=/home".
    path: String,
    headers: Vec<(String, String)>,
    body_base64: String,
}

/// Start the viewer-side proxy. Returns the bound localhost port. Idempotent —
/// restarts a fresh server.
#[tauri::command]
pub fn tunnel_proxy_start(app: AppHandle) -> Result<u16, String> {
    tunnel_proxy_stop();

    let server =
        tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("proxy bind failed: {}", e))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("proxy: could not resolve bound port")?;
    let server = Arc::new(server);
    let stop = Arc::new(AtomicBool::new(false));
    let pending: Arc<Mutex<HashMap<String, Sender<ProxyResponse>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    {
        let server = server.clone();
        let stop = stop.clone();
        let pending = pending.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => {
                        // One thread per request so parallel asset loads don't
                        // serialize behind a slow one.
                        let pending = pending.clone();
                        let app = app.clone();
                        std::thread::spawn(move || handle_proxy_request(request, pending, app));
                    }
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
        });
    }

    *proxy_slot().lock().map_err(|e| e.to_string())? = Some(ProxyState { stop, pending });
    Ok(port)
}

fn handle_proxy_request(
    mut request: tiny_http::Request,
    pending: Arc<Mutex<HashMap<String, Sender<ProxyResponse>>>>,
    app: AppHandle,
) {
    let method = request.method().as_str().to_string();
    let path = request.url().to_string();
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|h| {
            (
                h.field.as_str().as_str().to_string(),
                h.value.as_str().to_string(),
            )
        })
        .collect();
    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);

    let req_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = channel::<ProxyResponse>();
    if let Ok(mut map) = pending.lock() {
        map.insert(req_id.clone(), tx);
    }

    let _ = app.emit(
        "tunnel-proxy-request",
        ProxyRequestEvent {
            req_id: req_id.clone(),
            method,
            path,
            headers,
            body_base64: B64.encode(&body),
        },
    );

    match rx.recv_timeout(Duration::from_secs(35)) {
        Ok(resp) => {
            let mut response =
                tiny_http::Response::from_data(resp.body).with_status_code(resp.status);
            for (k, v) in resp.headers {
                if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                    response.add_header(h);
                }
            }
            let _ = request.respond(response);
        }
        Err(_) => {
            if let Ok(mut map) = pending.lock() {
                map.remove(&req_id);
            }
            let _ = request.respond(
                tiny_http::Response::from_string("Live preview timed out").with_status_code(504),
            );
        }
    }
}

/// Frontend → here: deliver the tunneled response for one proxied request.
#[tauri::command]
pub fn tunnel_deliver(
    req_id: String,
    status: u16,
    headers: Vec<(String, String)>,
    body_base64: String,
) -> Result<(), String> {
    let body = B64
        .decode(&body_base64)
        .map_err(|e| format!("bad body base64: {}", e))?;
    let slot = proxy_slot().lock().map_err(|e| e.to_string())?;
    if let Some(state) = slot.as_ref() {
        if let Ok(mut map) = state.pending.lock() {
            if let Some(tx) = map.remove(&req_id) {
                let _ = tx.send(ProxyResponse {
                    status,
                    headers,
                    body,
                });
            }
        }
    }
    Ok(())
}

/// Stop the viewer-side proxy (idempotent).
#[tauri::command]
pub fn tunnel_proxy_stop() {
    if let Ok(mut slot) = proxy_slot().lock() {
        if let Some(state) = slot.take() {
            state.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Open the colleague's live preview in a dedicated window pointed at the local
/// proxy. Replaces any existing live-preview window.
///
/// MUST stay `async`. Tauri runs **sync** commands on the main/UI thread and
/// **async** commands on the async runtime (a worker thread). Window creation
/// has to happen on the main thread, so we hop there via `run_on_main_thread`
/// and block for the result. If this were a sync command it would ALREADY be on
/// the main thread (on Windows the WebView2 IPC dispatches commands there), so
/// `run_on_main_thread` would queue the build behind our own `rx.recv()` — the
/// main thread waiting on work only the main thread can run. That self-deadlock
/// froze the entire app on Windows ("no Windows a aplicação fica travada");
/// macOS happened to tolerate it. As an async command the body runs OFF the main
/// thread, so the main thread is free to build the window and `rx.recv()`
/// unblocks normally.
#[tauri::command]
pub async fn tunnel_open_preview_window(
    app: AppHandle,
    url: String,
    title: String,
) -> Result<(), String> {
    let app_main = app.clone();
    let (tx, rx) = channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let result = (|| {
            if let Some(win) = app_main.get_webview_window("live-preview") {
                let _ = win.close();
            }
            let parsed: WebviewUrl = url
                .parse()
                .map(WebviewUrl::External)
                .map_err(|e| format!("invalid preview url: {}", e))?;
            let win_title = if title.is_empty() {
                "Live Preview".to_string()
            } else {
                title
            };
            WebviewWindowBuilder::new(&app_main, "live-preview", parsed)
                .title(win_title)
                .inner_size(1200.0, 800.0)
                .build()
                .map_err(|e| format!("failed to open preview window: {}", e))?;
            Ok::<(), String>(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("run_on_main_thread failed: {}", e))?;
    // Defensive timeout: window creation is near-instant, so if the result
    // doesn't come back something is wedged — surface it as an error rather than
    // leaving the caller's invoke() pending forever.
    rx.recv_timeout(Duration::from_secs(20))
        .map_err(|e| format!("preview window build did not complete: {}", e))?
}

// ===========================================================================
// Live-preview STATIC server — the SHARER side, serving a production BUILD.
// ===========================================================================
//
// Instead of tunnelling the dev server (which exposes Vite's /@fs file-serving,
// source, etc.), the sharer runs `npm run build` and we serve the static output
// directory here. This closes the file-serving exfiltration vector entirely: a
// build has no /@fs, no source serving, no dev endpoints. The server is
// in-process (tiny_http) so it dies with the app — no child process to orphan.

struct StaticServerState {
    stop: Arc<AtomicBool>,
}

fn static_server_slot() -> &'static Mutex<Option<StaticServerState>> {
    static S: OnceLock<Mutex<Option<StaticServerState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Serve `dir` statically on 127.0.0.1:`port` (SPA fallback to index.html).
/// Replaces any existing static server. Returns the bound port.
#[tauri::command]
pub fn live_preview_serve_static(dir: String, port: u16) -> Result<u16, String> {
    live_preview_stop_static();

    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", dir));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {}", e))?;
    // Must contain an index.html to be a servable SPA build.
    if !root.join("index.html").is_file() {
        return Err("build output has no index.html".to_string());
    }

    let server = tiny_http::Server::http(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("static bind failed: {}", e))?;
    let server = Arc::new(server);
    let stop = Arc::new(AtomicBool::new(false));
    let root = Arc::new(root);

    {
        let server = server.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => {
                        // Thread-per-request so parallel asset loads don't serialize.
                        let root = root.clone();
                        std::thread::spawn(move || serve_static_request(request, &root));
                    }
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
        });
    }

    if let Ok(mut slot) = static_server_slot().lock() {
        *slot = Some(StaticServerState { stop });
    }
    Ok(port)
}

/// Stop the static server (idempotent). The thread exits within ~200ms.
#[tauri::command]
pub fn live_preview_stop_static() {
    if let Ok(mut slot) = static_server_slot().lock() {
        if let Some(state) = slot.take() {
            state.stop.store(true, Ordering::Relaxed);
        }
    }
}

fn serve_static_request(request: tiny_http::Request, root: &Path) {
    let url = request.url().to_string();
    let path_only = url.split('?').next().unwrap_or("/");
    let decoded = percent_decode(path_only);

    let resolved = match safe_join(root, &decoded) {
        Some(p) => p,
        None => {
            let _ = request
                .respond(tiny_http::Response::from_string("Forbidden").with_status_code(403));
            return;
        }
    };

    // Directory → its index.html.
    let mut file_path = resolved;
    if file_path.is_dir() {
        file_path.push("index.html");
    }

    let data = match std::fs::read(&file_path) {
        Ok(d) => d,
        Err(_) => {
            // SPA fallback: an extension-less path is a client route → index.html.
            // A missing asset (has an extension) is a real 404.
            if last_segment_has_ext(&decoded) {
                let _ = request
                    .respond(tiny_http::Response::from_string("Not found").with_status_code(404));
                return;
            }
            let idx = root.join("index.html");
            match std::fs::read(&idx) {
                Ok(d) => {
                    file_path = idx;
                    d
                }
                Err(_) => {
                    let _ = request.respond(
                        tiny_http::Response::from_string("Not found").with_status_code(404),
                    );
                    return;
                }
            }
        }
    };

    let ct = content_type_for(&file_path);
    let response = tiny_http::Response::from_data(data).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap_or_else(|_| {
            tiny_http::Header::from_bytes(&b"X-Content"[..], &b"1"[..]).unwrap()
        }),
    );
    let _ = request.respond(response);
}

/// Join a URL path under `root`, rejecting `..` traversal. Canonicalizes when
/// the target exists and re-checks containment (defends against symlink escape).
fn safe_join(root: &Path, url_path: &str) -> Option<PathBuf> {
    let mut p = root.to_path_buf();
    for seg in url_path.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains('\0') {
            return None;
        }
        p.push(seg);
    }
    match p.canonicalize() {
        // Existing file/dir: must stay under root.
        Ok(c) => {
            if c.starts_with(root) {
                Some(c)
            } else {
                None
            }
        }
        // Non-existent (e.g. a client route) — segment checks already blocked
        // traversal, so allow it; the read will 404 / SPA-fallback.
        Err(_) => Some(p),
    }
}

fn last_segment_has_ext(path: &str) -> bool {
    path.rsplit('/').next().unwrap_or("").contains('.')
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn content_type_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}
