mod commands;
use commands::ai_completion::*;
use commands::checkpoint::*;
use commands::container::*;
use commands::debugger::*;
use commands::device::*;
use commands::file_tree::*;
use commands::filesystem::*;
use commands::git::*;
use commands::http_client::*;
use commands::issue_reporter::*;
use commands::mcp::*;
use commands::project::*;
use commands::sandbox::*;
use commands::search::*;
use commands::terminal::*;
use commands::version::*;

use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{Emitter, Manager};
use tauri::{WebviewUrl, WebviewWindowBuilder};

// ── Preview webview (separate window approach — reliable on all platforms) ────

// ── Native preview via wry::build_as_child ──────────────────────────────────
// Key insight from wry#1335: the WebView MUST be kept alive (not dropped).
// We use a global static with ManuallyDrop to ensure it persists.

use std::mem::ManuallyDrop;

// WebView is !Send+!Sync (main-thread-only). Safe because Tauri sync
// commands execute on the main thread where WKWebView was created.
struct WvHolder(Option<ManuallyDrop<wry::WebView>>);
unsafe impl Send for WvHolder {}
unsafe impl Sync for WvHolder {}

impl WvHolder {
    fn set(&mut self, wv: wry::WebView) {
        self.clear();
        self.0 = Some(ManuallyDrop::new(wv));
    }
    fn clear(&mut self) {
        if let Some(mut wv) = self.0.take() {
            // Safety: we only drop once, on the main thread
            unsafe {
                ManuallyDrop::drop(&mut wv);
            }
        }
    }
    fn get(&self) -> Option<&wry::WebView> {
        self.0.as_deref()
    }
}

static PREVIEW: std::sync::OnceLock<std::sync::Mutex<WvHolder>> = std::sync::OnceLock::new();
fn preview() -> &'static std::sync::Mutex<WvHolder> {
    PREVIEW.get_or_init(|| std::sync::Mutex::new(WvHolder(None)))
}

#[tauri::command]
fn open_preview_webview(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> std::result::Result<(), String> {
    // Close existing
    preview().lock().map_err(|e| format!("{}", e))?.clear();

    let win = app.get_webview_window("main").ok_or("No main window")?;

    // WKWebView on macOS blocks http:// URLs (ATS). There we use a custom
    // protocol "tmpreview://" that proxies requests to the dev server via a
    // raw TCP connection, and the proxy's raw_http_get needs a concrete IPv4
    // to avoid IPv6 stalls — hence we force 127.0.0.1 inside proxy_target.
    //
    // On Windows (WebView2) and Linux (WebKitGTK) we load the http:// URL
    // DIRECTLY in the child webview. The Chromium-based WebView2 uses Happy
    // Eyeballs to try both IPv4 and IPv6 — so "localhost" works regardless
    // of whether the dev server binds to ::1, 127.0.0.1, or both. Pinning
    // 127.0.0.1 here broke preview when the user's Vite/Next bound IPv6-only
    // (default when no --host flag). Use the URL as-is for direct loading.
    let proxy_target = url
        .trim_end_matches('/')
        .replace("://localhost", "://127.0.0.1");
    let _proxy_target_for_ws = proxy_target.clone();
    // Platform gate — on non-macOS we load the URL directly.
    let use_proxy = cfg!(target_os = "macos");
    // For direct loading, preserve the original URL (don't force IPv4).
    let direct_url = format!("{}/", url.trim_end_matches('/'));

    // Clone app handle for IPC handler (receives runtime errors from preview JS)
    let app_for_ipc = app.clone();
    let proxy_target_for_protocol = proxy_target.clone();

    let wv = wry::WebViewBuilder::new()
        // Inject error capture script into every page load.
        // Captures: uncaught errors, unhandled promise rejections, and console.error.
        // Forwards them to Rust via window.ipc.postMessage for the agent to see.
        //
        // Design decisions:
        // - console.warn NOT captured (too noisy — React/Next.js emit hundreds of deprecation warnings)
        // - Deduplication: window.onerror sets a flag so the subsequent console.error for the
        //   same error is suppressed (the browser fires both for uncaught exceptions)
        // - Throttle: max 1 message per 300ms to prevent IPC flood during error cascades
        // - Circular objects: uses toString() fallback instead of JSON.stringify
        .with_initialization_script(r#"
            (function() {
                var _lastSent = 0;
                var _lastMsg = '';
                var _onerrorFired = false;
                var _pendingTimer = null;

                var _doSend = function(level, msg) {
                    _lastSent = Date.now();
                    _lastMsg = msg;
                    try {
                        window.ipc.postMessage(JSON.stringify({ type: 'console', level: level, text: msg }));
                    } catch(_) {}
                };

                var _send = function(level, msg) {
                    var now = Date.now();
                    // Deduplicate identical consecutive messages (within 2s)
                    if (msg === _lastMsg && now - _lastSent < 2000) return;
                    // Throttle: if within 300ms of last send, queue for deferred delivery
                    if (now - _lastSent < 300) {
                        if (_pendingTimer) clearTimeout(_pendingTimer);
                        _pendingTimer = setTimeout(function() {
                            _pendingTimer = null;
                            _doSend(level, msg);
                        }, 300 - (now - _lastSent));
                        return;
                    }
                    if (_pendingTimer) { clearTimeout(_pendingTimer); _pendingTimer = null; }
                    _doSend(level, msg);
                };

                var _stringify = function(arg) {
                    if (arg === null) return 'null';
                    if (arg === undefined) return 'undefined';
                    if (arg instanceof Error) return arg.stack || arg.toString();
                    if (typeof arg === 'object') {
                        try { return JSON.stringify(arg); }
                        catch(_) { return Object.prototype.toString.call(arg); }
                    }
                    return String(arg);
                };

                window.addEventListener('error', function(e) {
                    _onerrorFired = true;
                    setTimeout(function() { _onerrorFired = false; }, 50);
                    var msg = e.error ? (e.error.stack || e.error.toString()) : e.message;
                    var loc = (e.filename || '').split('/').pop() + ':' + e.lineno;
                    _send('error', msg + ' (' + loc + ')');
                });

                window.addEventListener('unhandledrejection', function(e) {
                    var reason = e.reason;
                    _send('error', 'Unhandled Promise rejection: ' + (reason && reason.stack ? reason.stack : String(reason)));
                });

                var _origError = console.error;
                console.error = function() {
                    _origError.apply(console, arguments);
                    // Skip if this console.error is the browser echoing a window.onerror
                    if (_onerrorFired) return;
                    var parts = [];
                    for (var i = 0; i < arguments.length; i++) {
                        parts.push(_stringify(arguments[i]));
                    }
                    _send('error', parts.join(' '));
                };

                // Proactive Google Identity Services (GIS) probe.
                //
                // GIS in iframes often fails *silently* — FedCM blocks the
                // button, no console error fires, the developer clicks and
                // nothing happens. To surface this BEFORE the click, we watch
                // for the GIS script-tag being added to the DOM. If we see
                // it AND we're inside an iframe, fire a one-shot signal so
                // the IDE can show a friendly toast preemptively.
                //
                // We only fire once per page load — the IDE's React side has
                // its own dedup that resets per preview-reload.
                var _gisDetected = false;
                var _isInIframe = (function() {
                    try { return window.self !== window.top; }
                    catch (_) { return true; } /* cross-origin parent → in iframe */
                })();

                var _checkForGis = function() {
                    if (_gisDetected || !_isInIframe) return;
                    var scripts = document.getElementsByTagName('script');
                    for (var i = 0; i < scripts.length; i++) {
                        var src = scripts[i].src || '';
                        if (src.indexOf('accounts.google.com/gsi/client') !== -1) {
                            _gisDetected = true;
                            try {
                                window.ipc.postMessage(JSON.stringify({ type: 'gis-detected' }));
                            } catch(_) {}
                            return;
                        }
                    }
                };

                // Initial pass after DOM is ready
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', _checkForGis);
                } else {
                    _checkForGis();
                }
                // Also observe future script additions (SPA routes, lazy loads)
                if (window.MutationObserver) {
                    var _mo = new MutationObserver(function() { _checkForGis(); });
                    var _moStart = function() {
                        if (document.body) _mo.observe(document.body, { childList: true, subtree: true });
                    };
                    if (document.body) _moStart();
                    else document.addEventListener('DOMContentLoaded', _moStart);
                    // Stop observing once we've fired (no need to keep watching)
                    var _stopWhenDetected = setInterval(function() {
                        if (_gisDetected) { _mo.disconnect(); clearInterval(_stopWhenDetected); }
                    }, 1000);
                }
            })();
        "#)
        // IPC handler: receives console messages from the preview JS.
        // Forwards to the main window via eval() — dispatches a CustomEvent
        // that the App.tsx listener picks up. We use eval instead of emit()
        // because the wry IPC closure doesn't have access to Tauri's Emitter trait.
        .with_ipc_handler(move |request| {
            let body = request.body();
            let parsed: serde_json::Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return,
            };
            let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match msg_type {
                "console" => {
                    let level = parsed.get("level").and_then(|l| l.as_str()).unwrap_or("error");
                    let text = parsed.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if text.is_empty() { return; }
                    // Escape for JS string literal (backslash, quotes, newlines)
                    let safe_text = text
                        .replace('\\', "\\\\")
                        .replace('\'', "\\'")
                        .replace('\n', "\\n")
                        .replace('\r', "");
                    let safe_level = level.replace('\'', "\\'");
                    if let Some(win) = app_for_ipc.get_webview_window("main") {
                        let _ = win.eval(format!(
                            "window.dispatchEvent(new CustomEvent('preview-console',{{detail:{{level:'{}',text:'{}'}}}}));",
                            safe_level, safe_text
                        ));
                    }
                }
                "gis-detected" => {
                    // Proactive signal from the in-preview probe: GIS script
                    // detected inside an iframe context. The IDE's listener
                    // will show a friendly toast pre-warning the developer.
                    if let Some(win) = app_for_ipc.get_webview_window("main") {
                        let _ = win.eval(
                            "window.dispatchEvent(new CustomEvent('preview-gis-detected'));"
                        );
                    }
                }
                _ => {}
            }
        })
        .with_asynchronous_custom_protocol("tmpreview".into(), move |_webview_id, request, responder| {
            let target = proxy_target_for_protocol.clone();
            std::thread::spawn(move || {
                let path = request.uri().path_and_query()
                    .map(|pq| pq.as_str())
                    .unwrap_or("/");
                let full_url = format!("{}{}", target, path);
                let addr = target.replace("http://", "");

                // Retry with backoff — dev server may still be starting
                let mut result = Err("not attempted".to_string());
                for attempt in 0..5 {
                    result = raw_http_get(&addr, path);
                    if result.is_ok() { break; }
                    if attempt < 4 {
                        let delay = std::time::Duration::from_millis(500 * (attempt as u64 + 1));
                        eprintln!("[preview] Proxy retry {} for {} (waiting {:?})", attempt + 1, full_url, delay);
                        std::thread::sleep(delay);
                    }
                }

                match result {
                    Ok((status, content_type, body)) => {
                        responder.respond(
                            wry::http::Response::builder()
                                .status(status)
                                .header("Content-Type", content_type)
                                .header("Access-Control-Allow-Origin", "*")
                                .body(body)
                                .unwrap()
                        );
                    }
                    Err(e) => {
                        eprintln!("[preview] Proxy error: {} -> {}", full_url, e);
                        responder.respond(
                            wry::http::Response::builder()
                                .status(502)
                                .header("Content-Type", "text/html")
                                .body(format!(
                                    "<html><body style='background:#1a1a2e;color:#fff;font-family:system-ui;padding:40px;text-align:center'>\
                                    <h3>Dev server unreachable</h3><p style='color:#f85149'>{}</p><p>{}</p></body></html>",
                                    e, full_url
                                ).into_bytes())
                                .unwrap()
                        );
                    }
                }
            });
        })
        .with_url(if use_proxy { "tmpreview://localhost/".to_string() } else { direct_url.clone() })
        .with_devtools(true)
        .with_bounds(wry::Rect {
            position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(x, y)),
            size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(width, height)),
        })
        .build_as_child(&win.as_ref().window())
        .map_err(|e| format!("Preview failed: {}", e))?;

    preview().lock().map_err(|e| format!("{}", e))?.set(wv);

    // Bring ALL subviews except the first one (main Tauri webview) to the front.
    // wry's build_as_child adds the preview WKWebView as a subview, but it may
    // end up behind the main webview. Re-add every non-first subview on top.
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns_window_ptr) = win.as_ref().window().ns_window() {
            unsafe {
                let ns_win = &*(ns_window_ptr as *const objc2_app_kit::NSWindow);
                if let Some(content_view) = ns_win.contentView() {
                    let subviews = content_view.subviews();
                    let count = subviews.count();
                    // Move all non-first subviews (preview) to the top
                    for i in 1..count {
                        let sv = subviews.objectAtIndex_unchecked(i);
                        sv.removeFromSuperview();
                        content_view.addSubview_positioned_relativeTo(
                            sv,
                            objc2_app_kit::NSWindowOrderingMode::Above,
                            None,
                        );
                    }
                    eprintln!("[preview] Reordered to front");
                }
            }
        }
    }

    eprintln!(
        "[preview] Native webview created — requested url={}, proxy target={}",
        url, proxy_target
    );
    Ok(())
}

#[tauri::command]
fn close_preview_webview() -> std::result::Result<(), String> {
    preview().lock().map_err(|e| format!("{}", e))?.clear();
    eprintln!("[preview] Closed");
    Ok(())
}

#[tauri::command]
fn resize_preview_webview(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> std::result::Result<(), String> {
    let store = preview().lock().map_err(|e| format!("{}", e))?;
    if let Some(wv) = store.get() {
        wv.set_bounds(wry::Rect {
            position: wry::dpi::Position::Logical(wry::dpi::LogicalPosition::new(x, y)),
            size: wry::dpi::Size::Logical(wry::dpi::LogicalSize::new(width, height)),
        })
        .map_err(|e| format!("{}", e))?;
    }
    Ok(())
}

/// Raw HTTP GET via TcpStream — bypasses reqwest issues with localhost.
///
/// Connection strategy: try IPv4 first, fall back to IPv6 ([::1]). Node 18+
/// frameworks (Vite, Next without --host) bind to localhost which resolves
/// to ::1 only, so a v4-pinned proxy_target hits "connection refused" even
/// though the server is up. The fallback rescues that case without making
/// the agent re-write its dev scripts.
fn raw_http_get(
    host_port: &str,
    path: &str,
) -> std::result::Result<(u16, String, Vec<u8>), String> {
    use std::net::TcpStream;

    let v4_err = match TcpStream::connect(host_port) {
        Ok(s) => {
            return raw_http_get_with_stream(s, host_port, path);
        }
        Err(e) => format!("{}", e),
    };

    // IPv4 (or proxy_target's chosen host) refused. Retry against [::1] —
    // this is the common Node 18+ "localhost binds IPv6-only" case.
    let v6_target = if let Some(rest) = host_port.strip_prefix("127.0.0.1:") {
        format!("[::1]:{}", rest)
    } else if let Some(rest) = host_port.strip_prefix("localhost:") {
        format!("[::1]:{}", rest)
    } else {
        return Err(format!("Connection refused: {}", v4_err));
    };

    let stream = TcpStream::connect(&v6_target)
        .map_err(|e| format!("Connection refused (tried v4 + [::1]): v4={}, v6={}", v4_err, e))?;
    raw_http_get_with_stream(stream, host_port, path)
}

/// Inner helper that performs the actual GET on an already-connected stream.
/// Lets `raw_http_get` retry against an alternative address (IPv4 → IPv6)
/// without duplicating the request/parse boilerplate.
fn raw_http_get_with_stream(
    mut stream: std::net::TcpStream,
    host_port: &str,
    path: &str,
) -> std::result::Result<(u16, String, Vec<u8>), String> {
    use std::io::{Read, Write};

    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(3)))
        .ok();

    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        path, host_port
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("Write failed: {}", e))?;

    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("Read failed: {}", e))?;

    let response = String::from_utf8_lossy(&buf);

    // Parse status line
    let status_line = response.lines().next().unwrap_or("HTTP/1.1 502");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(502);

    // Parse Content-Type header
    let content_type = response
        .lines()
        .find(|l| l.to_lowercase().starts_with("content-type:"))
        .map(|l| {
            l.split_once(':')
                .map(|(_, v)| v.trim().to_string())
                .unwrap_or_default()
        })
        .unwrap_or_else(|| "text/html; charset=utf-8".to_string());

    // Split headers from body (double CRLF)
    let body = if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        buf[pos + 4..].to_vec()
    } else {
        buf
    };

    Ok((status, content_type, body))
}

/// Reveal the main window once the SPA has mounted, and close the splash
/// window. Idempotent — calling it after the safety timeout already
/// transitioned is harmless.
#[tauri::command]
fn app_ready(app: tauri::AppHandle) -> std::result::Result<(), String> {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(win) = app.get_webview_window("main") {
        win.show().map_err(|e| format!("show failed: {}", e))?;
        win.set_focus().map_err(|e| format!("focus failed: {}", e))?;
    }
    Ok(())
}

/// Files queued by the OS for opening (file association: "Open with TM Code"
/// from Finder/Explorer/Nautilus, or by drag-dropping a file onto the dock
/// icon). The frontend drains this on mount and listens for the live
/// `open-file-with-app` event for opens that happen after the SPA is up.
static PENDING_OPEN_FILES: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
fn pending_open_files() -> &'static std::sync::Mutex<Vec<String>> {
    PENDING_OPEN_FILES.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

#[tauri::command]
fn take_pending_open_files() -> Vec<String> {
    pending_open_files()
        .lock()
        .map(|mut v| v.drain(..).collect())
        .unwrap_or_default()
}

/// Cheap path-is-directory probe. Used by the file-drop handler to tell a
/// folder drop (open as project) from a file drop (likely an image targeted
/// at the prompt — handled by the HTML5 path). Doesn't validate suitability,
/// so it's faster than `validate_project_path` and the contract is clearer.
#[tauri::command]
fn is_directory(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// AppHandle stash for the macOS dock menu handler. The handler is an
/// Objective-C object whose selector methods can't take Rust closures or
/// Tauri's State<T>, so the handle has to live in a static. Wrapped in
/// OnceLock for thread-safe one-time init.
#[cfg(target_os = "macos")]
static DOCK_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Custom NSObject that backs the dock menu items. Its two selectors
/// (`openFolder:` and `openFile:`) emit a `native-menu` CustomEvent into
/// the main webview, identical to the one the menu bar uses — so the
/// existing `useNativeMenu` hook handles both routes with no extra wiring.
#[cfg(target_os = "macos")]
mod dock {
    use objc2::define_class;
    use objc2::runtime::{AnyObject, NSObject};

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "TmDockHandler"]
        pub struct DockHandler;

        impl DockHandler {
            #[unsafe(method(openFolder:))]
            fn _open_folder(&self, _sender: *mut AnyObject) {
                emit_native_menu("open-folder");
            }

            #[unsafe(method(openFile:))]
            fn _open_file(&self, _sender: *mut AnyObject) {
                emit_native_menu("open-file");
            }
        }
    );

    fn emit_native_menu(id: &str) {
        let Some(handle) = super::DOCK_APP_HANDLE.get() else { return };
        let Some(window) = tauri::Manager::get_webview_window(handle, "main") else { return };
        // Safe: id values are hard-coded above, no escaping needed.
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('native-menu', {{ detail: {{ id: '{}' }} }}))",
            id
        ));
    }
}

/// Domains allowed to open as popup windows (OAuth flows).
fn is_oauth_domain(host: &str) -> bool {
    host.contains("google.com")
        || host.contains("googleapis.com")
        || host.contains("firebaseapp.com")
        || host == "127.0.0.1"
        || host == "localhost"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Pre-warm login shell PATH cache on a background thread (non-blocking).
    // Must happen before any terminal commands so pnpm/node/etc. are found.
    commands::terminal::init_user_path();

    let (command_history, process_map) = commands::terminal::init_terminal_state();
    let active_container = commands::container::init_container_state();
    let debugger_state = commands::debugger::DebuggerState::new();
    let mcp_state = commands::mcp::McpState::new();

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .expect("Failed to create HTTP client");
    let fim_state = commands::ai_completion::FimState::new();
    let pty_map: commands::terminal::PtySessionMap =
        std::sync::Mutex::new(std::collections::HashMap::new());

    tauri::Builder::default()
        .manage(command_history)
        .manage(process_map)
        .manage(active_container)
        .manage(debugger_state)
        .manage(mcp_state)
        .manage(http_client)
        .manage(fim_state)
        .manage(pty_map)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Serve app via HTTP localhost instead of tauri:// protocol.
        // This allows iframes to load other HTTP origins (dev server previews)
        // without cross-protocol security restrictions.
        // Port 14300 — TM Code specific. Avoids conflict with common dev ports.
        .plugin(tauri_plugin_localhost::Builder::new(14300).build())
        .setup(move |app| {
            // ── File-association launch args ───────────────────────────
            // On Windows/Linux, "Open with TM Code" launches the binary
            // with file paths in argv[1..]. macOS routes these through
            // RunEvent::Opened (handled in `run` callback below) instead.
            // We collect all paths here and let the frontend drain via
            // `take_pending_open_files` once React mounts.
            #[cfg(not(target_os = "macos"))]
            {
                let args: Vec<String> = std::env::args().skip(1).collect();
                let paths: Vec<String> = args
                    .into_iter()
                    .filter(|a| {
                        let p = std::path::Path::new(a);
                        p.exists() && p.is_file()
                    })
                    .collect();
                if !paths.is_empty() {
                    if let Ok(mut buf) = pending_open_files().lock() {
                        buf.extend(paths);
                    }
                }
            }

            // Load app icon from embedded PNG
            let icon = Image::from_bytes(include_bytes!("../icons/128x128@2x.png"))
                .expect("Failed to load app icon");

            // Set macOS Dock icon programmatically (works in dev mode)
            #[cfg(target_os = "macos")]
            {
                use objc2::MainThreadMarker;
                use objc2::AllocAnyThread;
                use objc2_app_kit::{NSApplication, NSImage};
                use objc2_foundation::NSData;

                app.set_activation_policy(tauri::ActivationPolicy::Regular);
                let icon_data = include_bytes!("../icons/128x128@2x.png");

                if let Some(mtm) = MainThreadMarker::new() {
                    unsafe {
                        let ns_app = NSApplication::sharedApplication(mtm);
                        let data = NSData::with_bytes(icon_data);
                        if let Some(ns_image) = NSImage::initWithData(NSImage::alloc(), &data) {
                            ns_app.setApplicationIconImage(Some(&ns_image));
                        }
                    }
                }
            }

            // ── Splashscreen window ────────────────────────────────────
            // Loads `/splash.html` (a static file served by Vite in dev /
            // tauri-plugin-localhost in prod). It's pure HTML+CSS — no SPA
            // bundle — so it paints in <100ms while the React tree spins up
            // in the (hidden) main window. Closed by the `app_ready` command
            // once React has mounted; force-closed by the 5s failsafe below
            // if `app_ready` never fires.
            #[cfg(dev)]
            let splash_url = WebviewUrl::External(
                "http://localhost:1420/splash.html".parse().unwrap()
            );
            #[cfg(not(dev))]
            let splash_url = WebviewUrl::External(
                "http://localhost:14300/splash.html".parse().unwrap()
            );

            #[allow(unused_mut)]
            let mut splash_builder = WebviewWindowBuilder::new(app, "splash", splash_url)
                .title("TM Code")
                .inner_size(360.0, 200.0)
                .resizable(false)
                .decorations(false)
                .center()
                .skip_taskbar(true)
                .always_on_top(false)
                .visible(true);

            #[cfg(target_os = "macos")]
            {
                splash_builder = splash_builder.transparent(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::utils::config::Color;
                splash_builder = splash_builder.background_color(Color(10, 10, 10, 255));
            }

            let _splash = splash_builder.build()?;
            // No vibrancy on the splash — it lives <2s and the radial-gradient
            // background in splash.html reads well on its own. Allocating an
            // NSVisualEffectView for that lifetime is wasted work.

            // ── Native macOS menu bar ──────────────────────────────────
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle();

                let app_menu = SubmenuBuilder::new(handle, "TM Code")
                    .about(None)
                    .separator()
                    .item(&MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(handle)?)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let file_menu = SubmenuBuilder::new(handle, "File")
                    .item(&MenuItemBuilder::with_id("open-file", "Open File…").accelerator("CmdOrCtrl+Shift+O").build(handle)?)
                    .item(&MenuItemBuilder::with_id("open-folder", "Open Folder…").accelerator("CmdOrCtrl+O").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(handle)?)
                    .item(&MenuItemBuilder::with_id("save-all", "Save All").accelerator("CmdOrCtrl+Alt+S").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("close-tab", "Close Tab").accelerator("CmdOrCtrl+W").build(handle)?)
                    .item(&MenuItemBuilder::with_id("close-all-tabs", "Close All Tabs").build(handle)?)
                    .build()?;

                let edit_menu = SubmenuBuilder::new(handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .separator()
                    .item(&MenuItemBuilder::with_id("find", "Find").accelerator("CmdOrCtrl+F").build(handle)?)
                    .item(&MenuItemBuilder::with_id("replace", "Replace").accelerator("CmdOrCtrl+Alt+F").build(handle)?)
                    .item(&MenuItemBuilder::with_id("find-in-files", "Find in Files").accelerator("CmdOrCtrl+Shift+F").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("toggle-comment", "Toggle Line Comment").accelerator("CmdOrCtrl+/").build(handle)?)
                    .item(&MenuItemBuilder::with_id("format-document", "Format Document").accelerator("Shift+Alt+F").build(handle)?)
                    .build()?;

                let view_menu = SubmenuBuilder::new(handle, "View")
                    .item(&MenuItemBuilder::with_id("command-palette", "Command Palette…").accelerator("CmdOrCtrl+Shift+P").build(handle)?)
                    .item(&MenuItemBuilder::with_id("quick-open", "Quick Open").accelerator("CmdOrCtrl+P").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("view-chat", "Chat").build(handle)?)
                    .item(&MenuItemBuilder::with_id("view-editor", "Editor").build(handle)?)
                    .item(&MenuItemBuilder::with_id("view-preview", "Preview").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar").accelerator("CmdOrCtrl+B").build(handle)?)
                    .item(&MenuItemBuilder::with_id("toggle-bottom-panel", "Toggle Bottom Panel").accelerator("Ctrl+`").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("split-editor", "Split Editor").accelerator("CmdOrCtrl+\\").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("toggle-word-wrap", "Toggle Word Wrap").accelerator("Alt+Z").build(handle)?)
                    .build()?;

                let go_menu = SubmenuBuilder::new(handle, "Go")
                    .item(&MenuItemBuilder::with_id("go-to-file", "Go to File…").accelerator("CmdOrCtrl+P").build(handle)?)
                    .item(&MenuItemBuilder::with_id("go-to-line", "Go to Line…").accelerator("CmdOrCtrl+G").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("go-to-definition", "Go to Definition").accelerator("F12").build(handle)?)
                    .item(&MenuItemBuilder::with_id("peek-definition", "Peek Definition").accelerator("Alt+F12").build(handle)?)
                    .item(&MenuItemBuilder::with_id("go-to-references", "Go to References").accelerator("Shift+F12").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("go-to-symbol", "Go to Symbol in Editor…").accelerator("CmdOrCtrl+Shift+O").build(handle)?)
                    .build()?;

                let terminal_menu = SubmenuBuilder::new(handle, "Terminal")
                    .item(&MenuItemBuilder::with_id("toggle-terminal", "Toggle Terminal").accelerator("Ctrl+`").build(handle)?)
                    .build()?;

                let window_menu = SubmenuBuilder::new(handle, "Window")
                    .minimize()
                    .maximize()
                    .separator()
                    .fullscreen()
                    .close_window()
                    .build()?;

                let help_menu = SubmenuBuilder::new(handle, "Help")
                    .item(&MenuItemBuilder::with_id("open-command-palette", "Command Palette…").accelerator("CmdOrCtrl+Shift+P").build(handle)?)
                    .separator()
                    .item(&MenuItemBuilder::with_id("documentation", "Documentation").build(handle)?)
                    .item(&MenuItemBuilder::with_id("report-issue", "Report Issue…").build(handle)?)
                    .build()?;

                let menu = Menu::with_items(handle, &[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &go_menu,
                    &terminal_menu,
                    &window_menu,
                    &help_menu,
                ])?;

                app.set_menu(menu)?;

                // Forward menu events to the frontend via window events
                app.on_menu_event(move |app_handle, event| {
                    let id = event.id().0.as_str();
                    // Sanitize: only allow alphanumeric + hyphens (all our menu IDs are safe)
                    let safe_id: String = id.chars()
                        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                        .collect();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _: std::result::Result<(), _> = window.eval(format!(
                            "window.dispatchEvent(new CustomEvent('native-menu', {{ detail: {{ id: '{}' }} }}))",
                            safe_id
                        ));
                    }
                });

                // ── Dock menu (right-click on dock icon) ───────────────
                // macOS users expect this. Two items: Open Folder… and
                // Open File…, both reusing the same `native-menu` event
                // channel as the menu bar. NSApp.setDockMenu: is the
                // documented way; we go through msg_send! because objc2-app-kit
                // doesn't expose this single setter directly.
                {
                    use objc2::{msg_send, sel, AllocAnyThread};
                    use objc2::rc::Retained;
                    use objc2::MainThreadOnly;
                    use objc2::runtime::AnyObject;
                    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
                    use objc2_foundation::NSString;

                    let _ = DOCK_APP_HANDLE.set(app.handle().clone());

                    if let Some(mtm) = objc2::MainThreadMarker::new() {
                        let handler: Retained<dock::DockHandler> = unsafe {
                            let alloc = dock::DockHandler::alloc();
                            msg_send![alloc, init]
                        };

                        let menu = NSMenu::new(mtm);

                        let make_item = |title: &str, action: objc2::runtime::Sel| -> Retained<NSMenuItem> {
                            unsafe {
                                let title_ns = NSString::from_str(title);
                                let key = NSString::from_str("");
                                let alloc = NSMenuItem::alloc(mtm);
                                let item: Retained<NSMenuItem> = msg_send![
                                    alloc,
                                    initWithTitle: &*title_ns,
                                    action: action,
                                    keyEquivalent: &*key
                                ];
                                let target_ref: &AnyObject = &*(Retained::as_ptr(&handler) as *const AnyObject);
                                item.setTarget(Some(target_ref));
                                item
                            }
                        };

                        menu.addItem(&make_item("Open Folder…", sel!(openFolder:)));
                        menu.addItem(&make_item("Open File…", sel!(openFile:)));

                        let ns_app = NSApplication::sharedApplication(mtm);
                        unsafe {
                            let _: () = msg_send![&*ns_app, setDockMenu: &*menu];
                        }

                        // The handler must outlive the menu — leak so it
                        // sticks around for the app's lifetime.
                        std::mem::forget(handler);
                    }
                }
            }

            // Create main window.
            // Dev: WebviewUrl::default() → Vite dev server (http://localhost:1420)
            // Prod: localhost plugin serves app via HTTP (port 14300) so iframes work
            //       without cross-protocol (tauri:// vs http://) restrictions.
            let app_handle_for_popup = app.handle().clone();

            #[cfg(dev)]
            let main_url = WebviewUrl::default();
            #[cfg(not(dev))]
            let main_url = WebviewUrl::External("http://localhost:14300".parse().unwrap());

            // Build the main window with platform-aware decorations.
            //
            // macOS: frameless transparent window with rounded glassmorphism.
            //   - decorations(false) hides the title bar (we render our own)
            //   - transparent(true) enables the rounded background blur
            //   - accept_first_mouse(true) lets a focus-stealing click also activate widgets
            //
            // Windows: frameless OPAQUE window. We can't use transparent(true) because:
            //   - It disables Windows 11 Snap Layouts (no layout overlay on the maximize hover)
            //   - It removes the native DWM drop shadow
            //   - It breaks DWM rounded corners on Windows 11
            //   - It can cause black-box rendering bugs in Webview2
            //   The custom title bar still works because decorations(false) is honored.
            //
            // Linux: frameless OPAQUE window (transparency requires a compositor and is
            //   inconsistent across distros).
            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(app, "main", main_url)
                .title("TM Code")
                .icon(icon.clone())
                .expect("Failed to set window icon")
                .inner_size(1250.0, 850.0)
                .min_inner_size(900.0, 600.0)
                .decorations(false)
                // Start hidden — the React entry, on first mount, calls the
                // `app_ready` command which shows the window. This eliminates
                // the visible flash of an empty (vibrancy-only on macOS, dark
                // on Win/Linux) frame while the SPA mounts.
                //
                // Safety: a 5s tokio timeout below force-shows the window if
                // the frontend never reports ready (render crashed before
                // useEffect ran). Without it the window would stay hidden
                // forever.
                //
                // The earlier attempt that used double-rAF in main.tsx didn't
                // work: WKWebView throttles requestAnimationFrame when the
                // hosting NSWindow is hidden (Page Visibility API reports
                // "hidden"), so the show() callback never fired. React's
                // useEffect runs on the microtask queue regardless of visibility.
                .visible(false)
                // Force the *window* appearance to Dark regardless of OS
                // preference. The TM Code UI is dark-only; without this, in
                // macOS Light mode the traffic lights, native menu bar items,
                // and the NSVisualEffectView material all render in their
                // light variants and clash with the rest of the chrome. On
                // Windows this drives DwmSetWindowAttribute(USE_IMMERSIVE_DARK_MODE)
                // so the title bar and Mica also stay dark. If a light theme
                // is ever added, swap this for None and listen to the
                // `theme-changed` event on the window.
                .theme(Some(tauri::Theme::Dark));

            #[cfg(target_os = "macos")]
            {
                builder = builder.transparent(true).accept_first_mouse(true);
            }

            // On Windows/Linux we don't use transparent(true), so the WebView
            // shows its default background (white on Webview2). Combined with
            // `body { background-color: transparent }` in theme.ts, that white
            // bleeds through and the user sees a fully blank screen until React
            // mounts. Force the WebView's underlying background to the same dark
            // color the app uses (#0a0a0a = tokens.colors.bg.welcome).
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::utils::config::Color;
                builder = builder.background_color(Color(10, 10, 10, 255));
            }

            builder
                // Allow ALL navigations including iframes to localhost dev servers
                .on_navigation(|url| {
                    let host = url.host_str().unwrap_or("");
                    // Allow localhost, 127.0.0.1, and app origins
                    host == "localhost"
                        || host == "127.0.0.1"
                        || host == "[::1]"
                        || host.ends_with(".localhost")
                        || url.scheme() == "tauri"
                        || url.scheme() == "data"
                        || url.scheme() == "blob"
                        || url.scheme() == "about"
                })
                .on_new_window(move |url, _features| {
                    let host = url.host_str().unwrap_or("");
                    if is_oauth_domain(host) {
                        // Tauri WebViews can't create proper popup windows via window.open().
                        // Create a real WebviewWindow for OAuth and bridge postMessage via events.
                        let url_str = url.to_string();
                        let handle = app_handle_for_popup.clone();
                        std::thread::spawn(move || {
                            // Close any existing OAuth popup first
                            if let Some(w) = handle.get_webview_window("oauth-popup") {
                                let _ = w.close();
                            }

                            let bridge_script = r#"
                                // Bridge window.opener.postMessage → Tauri event
                                Object.defineProperty(window, 'opener', {
                                    value: {
                                        postMessage: function(data, origin) {
                                            if (window.__TAURI_INTERNALS__) {
                                                window.__TAURI_INTERNALS__.invoke(
                                                    'plugin:event|emit',
                                                    { event: 'oauth-popup-message', payload: JSON.stringify(data) }
                                                ).catch(function(){});
                                            }
                                        },
                                        closed: false,
                                        location: { href: '' }
                                    },
                                    writable: false,
                                    configurable: false
                                });
                            "#;

                            if let Ok(parsed_url) = url_str.parse::<tauri::Url>() {
                                let _ = WebviewWindowBuilder::new(
                                    &handle,
                                    "oauth-popup",
                                    WebviewUrl::External(parsed_url),
                                )
                                .title("Sign in with Google")
                                .inner_size(500.0, 700.0)
                                .center()
                                .initialization_script(bridge_script)
                                .build();
                            }
                        });

                        // Deny the default behavior — we handle it ourselves
                        NewWindowResponse::Deny
                    } else {
                        NewWindowResponse::Deny
                    }
                })
                .build()?;

            // ── Native window vibrancy ───────────────────────────────────
            // macOS:    NSVisualEffectView under the WKWebView → blur of
            //           wallpaper/windows behind. Material `HudWindow` reads
            //           well in dark themes and respects the active/inactive
            //           state automatically.
            // Windows:  Mica on Win 11 (matches title bar), falls back to
            //           Acrylic on Win 10. apply_mica returns Err on
            //           unsupported builds — we silently ignore.
            // Linux:    no equivalent; skipped.
            //
            // Vibrancy is only visible where the DOM is transparent. The body
            // already has `background-color: transparent` (see theme.ts), so
            // any region whose React component has a non-opaque bg will let
            // the vibrancy through.
            #[cfg(target_os = "macos")]
            {
                let main_window = app.get_webview_window("main")
                    .ok_or("main window missing for vibrancy")?;
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let _ = apply_vibrancy(
                    &main_window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    None,
                );

                // Native rounded window corners. With decorations(false) +
                // transparent(true), AppKit doesn't round the window for us
                // — the canonical fix is layer-backing the contentView and
                // setting CALayer.cornerRadius. masksToBounds clips the
                // WKWebView subview to the rounded shape. Tauri 2 doesn't
                // expose corner_radius on the builder yet, so we go through
                // objc2. Using msg_send! for the layer call avoids pulling
                // in objc2-quartz-core just for two setters.
                if let Ok(ns_window_ptr) = main_window.ns_window() {
                    use objc2::msg_send;
                    use objc2::runtime::AnyObject;
                    unsafe {
                        let ns_win = &*(ns_window_ptr as *const objc2_app_kit::NSWindow);
                        if let Some(content_view) = ns_win.contentView() {
                            content_view.setWantsLayer(true);
                            let layer: *mut AnyObject = msg_send![&*content_view, layer];
                            if !layer.is_null() {
                                let _: () = msg_send![layer, setCornerRadius: 10.0_f64];
                                let _: () = msg_send![layer, setMasksToBounds: true];
                            }
                        }
                    }
                }
            }
            #[cfg(target_os = "windows")]
            {
                let main_window = app.get_webview_window("main")
                    .ok_or("main window missing for vibrancy")?;
                use window_vibrancy::{apply_mica, apply_acrylic};
                // Mica is Win 11+. apply_mica errors on Win 10; we then try
                // Acrylic which is supported back to Win 10 1809.
                if apply_mica(&main_window, Some(true)).is_err() {
                    let _ = apply_acrylic(&main_window, Some((18, 18, 18, 125)));
                }
            }

            // ── Splash safety timeout ──────────────────────────────────
            // The frontend's `app_ready` invoke is the primary signal to
            // close splash + show main. If React never mounts (crash,
            // infinite loop, missing chunk) we'd be stuck on the splash
            // forever. After 15s — long enough for slow hardware on first
            // cold start with empty cache, short enough that the user
            // notices a hang — force the transition and log a warning;
            // the ErrorBoundary in the main window then surfaces whatever
            // went wrong instead of leaving the user with a frozen splash.
            let app_handle_for_failsafe = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                if let Some(win) = app_handle_for_failsafe.get_webview_window("main") {
                    if let Ok(false) = win.is_visible() {
                        eprintln!("[splash] failsafe: 5s elapsed without app_ready — forcing show");
                        if let Some(splash) = app_handle_for_failsafe.get_webview_window("splash") {
                            let _ = splash.close();
                        }
                        let _ = win.show();
                    }
                }
            });

            Ok(())
        })
        // Kill all child processes on app exit to prevent orphaned processes
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(pm) = window.try_state::<commands::terminal::ProcessMap>() {
                        if let Ok(mut map) = pm.lock() {
                            for (pid, child) in map.iter_mut() {
                                // Best-effort kill — process may have already exited
                                let _ = child.kill();
                                eprintln!("[shutdown] Killed child process PID {}", pid);
                            }
                            map.clear();
                        }
                    }
                }
                // Notify main window when OAuth popup is closed (cancelled by user).
                // Firebase checks oauthProxy.closed to detect popup dismissal.
                if window.label() == "oauth-popup" {
                    if let Some(main) = window.app_handle().get_webview_window("main") {
                        let _ = main.emit("oauth-popup-closed", ());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
            create_project,
            get_recent_projects,
            save_project_state,
            load_project_state,
            validate_project_path,
            validate_project_name,
            validate_project_location,
            check_project_status,
            remove_from_recent_projects,
            clear_recent_projects,
            delete_project,
            build_file_tree,
            create_file_or_directory,
            delete_file_or_directory,
            rename_file_or_directory,
            read_file,
            write_file,
            append_file,
            create_file,
            copy_file_or_directory,
            create_directories_all,
            execute_command,
            run_streaming_command,
            start_dev_server,
            start_pty_shell,
            write_to_pty,
            resize_pty,
            kill_pty_session,
            kill_process,
            kill_port,
            check_server_health,
            probe_server,
            get_current_directory,
            get_home_directory,
            change_directory,
            command_exists,
            get_environment_variables,
            get_completions,
            get_command_history,
            save_command_to_history,
            clear_command_history,
            search_in_files,
            replace_in_files,
            check_ripgrep_available,
            check_debugger_availability,
            start_debug_session,
            stop_debug_session,
            launch_debug_session,
            set_breakpoint,
            remove_breakpoint,
            get_breakpoints,
            debug_continue,
            debug_pause,
            debug_step_over,
            debug_step_into,
            debug_step_out,
            get_debug_sessions,
            get_call_stack,
            get_variables,
            copy_directory,
            scaffold_template,
            glob_files,
            write_env_vars,
            collect_deploy_bundle,
            list_skills_bundled,
            read_skill_content,
            mcp_start_server,
            mcp_stop_server,
            mcp_send_request,
            mcp_send_notification,
            mcp_list_servers,
            mcp_stop_all_servers,
            save_checkpoint_file,
            save_checkpoint_new_marker,
            load_checkpoint_file,
            save_checkpoint_index,
            load_checkpoint_index,
            delete_checkpoint_files,
            delete_checkpoint_session,
            set_active_project,
            clear_active_project,
            fim_completion,
            git_diff_lines,
            git_status_files,
            git_stage_file,
            git_stage_all,
            git_unstage_file,
            git_unstage_all,
            git_discard_file,
            git_discard_all,
            git_commit,
            git_show_file,
            git_current_branch,
            git_push,
            git_pull,
            http_client_request,
            send_issue_report,
            sandbox_set_enabled,
            sandbox_status,
            sandbox_check_deps,
            open_preview_webview,
            close_preview_webview,
            resize_preview_webview,
            get_app_version,
            get_device_fingerprint,
            app_ready,
            take_pending_open_files,
            is_directory
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // RunEvent::Opened fires when the OS asks the running app to open
            // a file (macOS Apple Events from "Open With", drag-drop on dock,
            // re-launch via Finder while the app is already running). The
            // variant only exists on macOS — on Win/Linux this same case is
            // covered by the env::args path read in setup().
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let new_paths: Vec<String> = urls
                    .iter()
                    .filter(|u| u.scheme() == "file")
                    .filter_map(|u| u.to_file_path().ok())
                    .filter_map(|p| p.into_os_string().into_string().ok())
                    .collect();

                if !new_paths.is_empty() {
                    // Buffer for cold-start drain by frontend.
                    if let Ok(mut buf) = pending_open_files().lock() {
                        buf.extend(new_paths.iter().cloned());
                    }
                    // Live event for the already-running case (frontend has
                    // its listener attached). On cold start the listener
                    // isn't there yet, so the buffer is the source of truth
                    // — frontend's `take_pending_open_files` invoke drains it.
                    let _ = _app_handle.emit("open-file-with-app", new_paths);
                }
            }
        });
}
