/// Returns the app version string from Cargo.toml.
/// Exposed to the frontend via Tauri's invoke mechanism.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
