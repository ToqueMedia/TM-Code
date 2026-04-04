pub mod ai_completion;
pub mod checkpoint;
pub mod container;
pub mod debugger;
pub mod devcontainer;
pub mod file_tree;
pub mod filesystem;
pub mod git;
pub mod http_client;
pub mod issue_reporter;
pub mod mcp;
pub mod project;
pub mod search;
pub mod sandbox;
pub mod terminal;

/// Normalize a path to forward slashes for the TypeScript frontend.
/// On Windows, Rust returns backslash paths (C:\Users\...) but the
/// frontend expects forward slashes (C:/Users/...) for consistent
/// split('/') and comparison operations.
#[inline]
pub fn normalize_path_for_frontend(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(target_os = "windows") {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

/// Same as normalize_path_for_frontend but takes a string.
#[inline]
pub fn normalize_str_for_frontend(path: &str) -> String {
    if cfg!(target_os = "windows") {
        path.replace('\\', "/")
    } else {
        path.to_string()
    }
}
