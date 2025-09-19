mod commands;
use commands::project::*;
use commands::file_tree::*;
use commands::terminal::*;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (command_history, _process_map) = commands::terminal::init_terminal_state();
    
    tauri::Builder::default()
        .manage(command_history)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            open_project,
            create_project,
            get_recent_projects,
            save_project_state,
            load_project_state,
            validate_project_path,
            validate_project_name,
            validate_project_location,
            check_project_status,
            build_file_tree,
            create_file_or_directory,
            delete_file_or_directory,
            rename_file_or_directory,
            read_file,
            write_file,
            create_file,
            copy_file_or_directory,
            execute_command,
            start_interactive_shell,
            kill_process,
            get_current_directory,
            change_directory,
            command_exists,
            get_environment_variables,
            get_completions,
            get_command_history,
            save_command_to_history,
            clear_command_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
