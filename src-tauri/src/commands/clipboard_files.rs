//! Clipboard FILE PATHS — the piece the web clipboard event cannot give us.
//!
//! Copying a file in Finder/Explorer and pasting into the prompt textarea
//! only exposes the file NAME to the WebView (WebKit maps the file paste to
//! its name string). The agent needs the absolute PATH, so the paste
//! handler calls this command when `clipboardData.files` shows a non-image
//! file paste and swaps the name for the real path.
//!
//! Empty vec = "no file paths on the clipboard" — the frontend falls back
//! to the default text paste.

/// Read the absolute paths of files currently on the system clipboard.
/// Images are included too — the FRONTEND decides what to do with them
/// (image pastes are handled by the web blob path, not here).
#[tauri::command]
pub fn read_clipboard_file_paths() -> Vec<String> {
    read_file_paths()
}

#[cfg(target_os = "macos")]
fn read_file_paths() -> Vec<String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSString, NSURL};

    // NSPasteboard reads are safe off the main thread (it is not a
    // MainThreadOnly class; Finder readers do this from workers).
    let pb = NSPasteboard::generalPasteboard();
    let mut out: Vec<String> = Vec::new();
    let Some(items) = pb.pasteboardItems() else {
        return out;
    };
    let file_url_type = NSString::from_str("public.file-url");
    let count = items.count();
    for i in 0..count {
        let Some(url_str) = items.objectAtIndex(i).stringForType(&file_url_type) else {
            continue;
        };
        // "file:///Users/…" → "/Users/…" (NSURL handles percent-decoding)
        let Some(url) = NSURL::URLWithString(&url_str) else {
            continue;
        };
        if let Some(path) = url.path() {
            out.push(path.to_string());
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn read_file_paths() -> Vec<String> {
    // CF_HDROP → Vec<String>; clipboard-win opens/closes the clipboard
    // around the read itself. Explicit type: FileList's Getter impl is
    // unique (Vec<String>) but the annotation keeps inference obvious.
    let paths: Vec<String> =
        clipboard_win::get_clipboard(clipboard_win::formats::FileList).unwrap_or_default();
    paths
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn read_file_paths() -> Vec<String> {
    // Linux clipboards (wayland portals / xclip) have no portable file-list
    // contract; return none and let the WebView default paste stand.
    Vec::new()
}
