pub mod ai_completion;
pub mod byok;
pub mod checkpoint;
pub mod container;
pub mod data_viewer;
pub mod debugger;
pub mod device;
pub mod e2e;
pub mod file_tree;
pub mod filesystem;
pub mod git;
pub mod http_client;
pub mod issue_reporter;
pub mod mcp;
pub mod project;
pub mod sandbox;
pub mod screenshot;
pub mod search;
pub mod terminal;
pub mod version;

/// Strip the Windows UNC prefix (`\\?\`) from a string path if present.
/// `std::fs::canonicalize` on Windows always returns UNC paths, but most
/// tools (and the frontend) expect plain `C:\Users\...` form.
#[inline]
fn strip_unc_prefix(s: &str) -> &str {
    if cfg!(target_os = "windows") {
        // `\\?\C:\foo` → `C:\foo`
        // `\\?\UNC\server\share` → `\\server\share`
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            // UNC network path: keep the leading double-backslash
            // (we leak via to_string at call sites)
            return rest;
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest;
        }
    }
    s
}

/// Normalize a path to forward slashes for the TypeScript frontend.
/// On Windows, Rust returns backslash paths (C:\Users\...) but the
/// frontend expects forward slashes (C:/Users/...) for consistent
/// split('/') and comparison operations. Also strips the UNC `\\?\`
/// prefix that `canonicalize` adds on Windows.
#[inline]
pub fn normalize_path_for_frontend(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(target_os = "windows") {
        strip_unc_prefix(&s).replace('\\', "/")
    } else {
        s.into_owned()
    }
}

/// Same as normalize_path_for_frontend but takes a string.
#[inline]
pub fn normalize_str_for_frontend(path: &str) -> String {
    if cfg!(target_os = "windows") {
        strip_unc_prefix(path).replace('\\', "/")
    } else {
        path.to_string()
    }
}

/// Canonicalize a path, stripping the Windows UNC `\\?\` prefix that
/// `std::fs::canonicalize` adds on Windows. This produces paths that
/// work correctly with subprocesses, prefix matching, and the frontend.
///
/// Use this anywhere you would otherwise call `std::fs::canonicalize`.
#[inline]
pub fn canonicalize_path(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    if cfg!(target_os = "windows") {
        let s = canonical.to_string_lossy().to_string();
        Ok(std::path::PathBuf::from(strip_unc_prefix(&s).to_string()))
    } else {
        Ok(canonical)
    }
}

/// Mark a `std::process::Command` so it does NOT spawn a visible console
/// window on Windows. No-op on other platforms.
///
/// Use this on every short-lived subprocess that doesn't need a visible
/// terminal (git, docker, ripgrep, taskkill, etc.) — otherwise the user
/// sees a brief CMD flash on every call.
#[inline]
#[allow(unused_variables)]
pub fn hide_console_window(cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Same as `hide_console_window` but for a `tokio::process::Command`.
#[inline]
#[allow(unused_variables)]
pub fn hide_console_window_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}
