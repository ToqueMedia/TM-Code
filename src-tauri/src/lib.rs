mod commands;
use commands::checkpoint::*;
use commands::debugger::*;
use commands::file_tree::*;
use commands::filesystem::*;
use commands::mcp::*;
use commands::project::*;
use commands::search::*;
use commands::terminal::*;

use tauri::webview::NewWindowResponse;
use tauri::{WebviewUrl, WebviewWindowBuilder};

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
    let (command_history, process_map) = commands::terminal::init_terminal_state();
    let debugger_state = commands::debugger::DebuggerState::new();
    let mcp_state = commands::mcp::McpState::new();

    tauri::Builder::default()
        .manage(command_history)
        .manage(process_map)
        .manage(debugger_state)
        .manage(mcp_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Create main window programmatically so we can attach on_new_window
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("toquemedia-studio")
                .inner_size(1250.0, 850.0)
                .decorations(false)
                .transparent(true)
                .accept_first_mouse(true)
                .on_new_window(|url, _features| {
                    let host = url.host_str().unwrap_or("");
                    if is_oauth_domain(host) {
                        NewWindowResponse::Allow
                    } else {
                        NewWindowResponse::Deny
                    }
                })
                .build()?;

            Ok(())
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
            start_dev_server,
            start_interactive_shell,
            kill_process,
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
            delete_checkpoint_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
