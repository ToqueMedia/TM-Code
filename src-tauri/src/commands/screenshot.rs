// Cross-platform screen-region capture used by the Preview's floating
// screenshot button. Captures the rectangle in SCREEN coordinates (the
// frontend converts its DOM `getBoundingClientRect()` + `window.screenX/Y`
// + devicePixelRatio before invoking).
//
// Returns base64 PNG so the frontend can drop it straight into a data URI /
// blob without IPC binary overhead. Compression is implicit (PNG); we don't
// resize here because the caller passes the exact preview rect.
//
// Why a Rust command instead of a browser-side capture:
//   - html2canvas can't render cross-origin iframe content (the dev server
//     loads on localhost:PORT, the IDE is on a Tauri custom protocol).
//   - On macOS the preview uses a native wry child webview that sits ABOVE
//     the DOM — html2canvas sees an empty container.
//   - getDisplayMedia would work but forces a screen-share permission
//     prompt every session, which is hostile UX for a per-message capture.
// OS-level screen capture sidesteps all three.

use base64::Engine;
use screenshots::Screen;
// `std::fs` + `std::process::Command` only feed the macOS-native fallback
// `capture_screen_region_macos_native` further down, which is itself gated
// by `#[cfg(target_os = "macos")]`. The imports must carry the same gate
// or `cargo clippy -D warnings` on the Linux CI runner flags them as
// unused (the fallback function is invisible to that target).
#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::process::Command;

#[tauri::command]
pub fn capture_screen_region(x: i32, y: i32, width: u32, height: u32) -> Result<String, String> {
    if width == 0 || height == 0 {
        return Err("capture region has zero width/height".to_string());
    }

    // Manual screen-matching instead of `Screen::from_point()`. The latter
    // returned "no screen contains point" on macOS Sonoma+ even for points
    // clearly inside the primary display — the crate's CG lookup appears to
    // mis-handle certain display configurations (Retina + scaled / multi-
    // monitor / external-display-as-primary). Iterating ourselves over the
    // raw display_info bounds is more robust AND lets us pick a sensible
    // fallback when no display directly contains the point (e.g., the
    // requested rect straddles two displays — rare but real).
    let screens = Screen::all().map_err(|e| format!("Screen::all failed: {e}"))?;
    if screens.is_empty() {
        return Err("no displays detected".to_string());
    }

    // `Screen` derives `Copy`, so deref the `&Screen` to get an owned value
    // without `.clone()` (clippy::clone_on_copy). The lookup chain still
    // returns `Option<&Screen>` from each step.
    let screen = *screens
        .iter()
        .find(|s| {
            let info = &s.display_info;
            let sx = info.x;
            let sy = info.y;
            let sw = info.width as i32;
            let sh = info.height as i32;
            x >= sx && x < sx + sw && y >= sy && y < sy + sh
        })
        .or_else(|| screens.iter().find(|s| s.display_info.is_primary))
        .or_else(|| screens.first())
        .ok_or_else(|| "no usable display in Screen::all() output".to_string())?;

    let image = screen
        .capture_area(x, y, width, height)
        .map_err(|e| format!("screen.capture_area failed: {e}"))?;

    // `image` here is the screenshots crate's re-exported `RgbaImage` from
    // image 0.24. Use the crate's bundled `ImageFormat` so the `write_to`
    // bound `F: Into<ImageOutputFormat>` resolves — pulling in a separate
    // top-level `image` 0.25 dep produced a TYPE mismatch (two `ImageFormat`
    // enums in the build graph).
    let mut png_bytes: Vec<u8> = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            screenshots::image::ImageFormat::Png,
        )
        .map_err(|e| format!("PNG encode failed: {e}"))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&png_bytes))
}

/// macOS-native screenshot via the built-in `screencapture` CLI.
///
/// Why a separate path: `screencapture` uses ScreenCaptureKit under the hood
/// on Sonoma+, captures the EXACT framebuffer output, and works through the
/// macOS Screen Recording permission system the user is already used to. On
/// macOS the IDE's preview iframe is rendered by a native wry child webview
/// that sits ABOVE the DOM — html2canvas and the `screenshots` crate both
/// fall short of capturing those pixels in some configurations. The CLI is
/// the same tool the OS uses internally for Cmd-Shift-4 selection capture;
/// it returns the actual rendered preview content reliably.
///
/// Coordinates are in points (logical pixels), origin top-left of the
/// primary display. Caller passes `window.screenX/Y + rect.left/top` and
/// `rect.width/height` directly — no DPR multiplication.
///
/// On first invocation macOS displays a system dialog asking for Screen
/// Recording permission. If the user declines, `screencapture` writes a
/// black image silently (no exit code change) — we detect the all-black
/// case by checking file size: a legitimate capture is ≥10 KB, a black
/// region of any practical size is far smaller because PNG compresses
/// solid color extremely well. Below threshold → assume permission denial.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn capture_screen_region_macos_native(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    if width == 0 || height == 0 {
        return Err("capture region has zero width/height".to_string());
    }

    // Unique temp path per call so concurrent captures don't clobber each
    // other. /tmp is always writable on macOS for the running user.
    let temp_path = format!("/tmp/tmcode-shot-{}.png", uuid::Uuid::new_v4());

    let rect = format!("{x},{y},{width},{height}");
    let output = Command::new("/usr/sbin/screencapture")
        .arg("-R")
        .arg(&rect)
        .arg("-x") // no shutter sound — preview captures are silent UX
        .arg(&temp_path)
        .output()
        .map_err(|e| format!("screencapture spawn failed: {e}"))?;

    if !output.status.success() {
        let _ = fs::remove_file(&temp_path); // best-effort cleanup
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "screencapture failed (exit {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let bytes =
        fs::read(&temp_path).map_err(|e| format!("read screencapture output failed: {e}"))?;
    let _ = fs::remove_file(&temp_path); // best-effort cleanup

    // Permission-denial heuristic: macOS writes a black image (small file)
    // when Screen Recording isn't authorised. Surface a specific error so
    // the IDE can show the actionable "enable in System Settings" toast.
    if bytes.len() < 10_000 {
        return Err("screencapture wrote an unexpectedly small file — likely \
            Screen Recording permission denied. Enable TM Code in System \
            Settings → Privacy & Security → Screen Recording, then quit \
            and reopen the app."
            .to_string());
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
