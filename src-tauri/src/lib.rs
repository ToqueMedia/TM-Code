mod commands;
use commands::ai_completion::*;
use commands::checkpoint::*;
use commands::container::*;
use commands::debugger::*;
use commands::devcontainer::*;
use commands::file_tree::*;
use commands::filesystem::*;
use commands::git::*;
use commands::http_client::*;
use commands::issue_reporter::*;
use commands::mcp::*;
use commands::project::*;
use commands::search::*;
use commands::terminal::*;

use tauri::image::Image;
use tauri::webview::NewWindowResponse;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri::Manager;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};

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
    let (container_map, active_container) = commands::container::init_container_state();
    let debugger_state = commands::debugger::DebuggerState::new();
    let mcp_state = commands::mcp::McpState::new();

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .expect("Failed to create HTTP client");
    let fim_state = commands::ai_completion::FimState::new();

    tauri::Builder::default()
        .manage(command_history)
        .manage(process_map)
        .manage(container_map)
        .manage(active_container)
        .manage(debugger_state)
        .manage(mcp_state)
        .manage(http_client)
        .manage(fim_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
                        let _: std::result::Result<(), _> = window.eval(&format!(
                            "window.dispatchEvent(new CustomEvent('native-menu', {{ detail: {{ id: '{}' }} }}))",
                            safe_id
                        ));
                    }
                });
            }

            // Create main window programmatically so we can attach on_new_window
            let app_handle_for_popup = app.handle().clone();

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("TM Code")
                .icon(icon.clone())
                .expect("Failed to set window icon")
                .inner_size(1250.0, 850.0)
                .decorations(false)
                .transparent(true)
                .accept_first_mouse(true)
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
            create_file,
            copy_file_or_directory,
            create_directories_all,
            execute_command,
            run_streaming_command,
            start_dev_server,
            start_interactive_shell,
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
            check_docker_available,
            create_project_container,
            stop_project_container,
            remove_project_container,
            get_container_status,
            get_active_container_info,
            set_active_project,
            clear_active_project,
            cleanup_orphaned_containers,
            detect_devcontainer,
            list_running_containers,
            attach_to_container,
            is_attached_container,
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
            send_issue_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
