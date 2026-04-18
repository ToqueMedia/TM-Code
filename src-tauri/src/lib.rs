mod commands;
use commands::ai_completion::*;
use commands::checkpoint::*;
use commands::container::*;
use commands::debugger::*;
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

    // WKWebView blocks HTTP URLs (ATS). Use a custom protocol "tmpreview://"
    // that proxies requests to the dev server via Rust's reqwest.
    // Normalize "localhost" to "127.0.0.1": on Windows the system resolver
    // tries IPv6 [::1] first, which stalls for seconds when the dev server
    // (Vite/Next) only binds to IPv4 127.0.0.1. This was the root cause of
    // the Windows "dark preview" symptom — pages loaded, but each asset
    // request hit a multi-second DNS timeout.
    let proxy_target = url
        .trim_end_matches('/')
        .replace("://localhost", "://127.0.0.1");
    let _proxy_target_for_ws = proxy_target.clone();

    // Clone app handle for IPC handler (receives runtime errors from preview JS)
    let app_for_ipc = app.clone();

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
            })();
        "#)
        // IPC handler: receives console messages from the preview JS.
        // Forwards to the main window via eval() — dispatches a CustomEvent
        // that the App.tsx listener picks up. We use eval instead of emit()
        // because the wry IPC closure doesn't have access to Tauri's Emitter trait.
        .with_ipc_handler(move |request| {
            let body = request.body();
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(body) {
                if msg.get("type").and_then(|t| t.as_str()) == Some("console") {
                    let level = msg.get("level").and_then(|l| l.as_str()).unwrap_or("error");
                    let text = msg.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    if !text.is_empty() {
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
                }
            }
        })
        .with_asynchronous_custom_protocol("tmpreview".into(), move |_webview_id, request, responder| {
            let target = proxy_target.clone();
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
        .with_url("tmpreview://localhost/")
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
fn raw_http_get(
    host_port: &str,
    path: &str,
) -> std::result::Result<(u16, String, Vec<u8>), String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    // Use ToSocketAddrs to resolve "localhost" → [::1] or 127.0.0.1
    let mut stream =
        TcpStream::connect(host_port).map_err(|e| format!("Connection refused: {}", e))?;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Serve app via HTTP localhost instead of tauri:// protocol.
        // This allows iframes to load other HTTP origins (dev server previews)
        // without cross-protocol security restrictions.
        // Port 14300 — TM Code specific. Avoids conflict with common dev ports.
        .plugin(tauri_plugin_localhost::Builder::new(14300).build())
        .setup(move |app| {
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
                .decorations(false);

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
            get_app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
