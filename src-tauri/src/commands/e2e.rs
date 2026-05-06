use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, Clone)]
pub struct BrowserInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub channel: Option<String>,
    pub executable_path: Option<String>,
}

#[tauri::command]
pub fn detect_test_browsers() -> Vec<BrowserInfo> {
    let mut found: Vec<BrowserInfo> = Vec::new();

    for candidate in candidates() {
        if let Some(path) = first_existing(&candidate.paths) {
            let path_str = super::normalize_path_for_frontend(&path);
            found.push(BrowserInfo {
                id: candidate.id.to_string(),
                name: candidate.name.to_string(),
                path: path_str.clone(),
                channel: candidate.channel.map(|c| c.to_string()),
                executable_path: if candidate.channel.is_none() {
                    Some(path_str)
                } else {
                    None
                },
            });
        }
    }

    found
}

struct Candidate {
    id: &'static str,
    name: &'static str,
    channel: Option<&'static str>,
    paths: Vec<PathBuf>,
}

fn candidates() -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();

    if cfg!(target_os = "macos") {
        out.push(Candidate {
            id: "chrome",
            name: "Google Chrome",
            channel: Some("chrome"),
            paths: vec![PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )],
        });
        out.push(Candidate {
            id: "chrome-beta",
            name: "Google Chrome Beta",
            channel: Some("chrome-beta"),
            paths: vec![PathBuf::from(
                "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
            )],
        });
        out.push(Candidate {
            id: "msedge",
            name: "Microsoft Edge",
            channel: Some("msedge"),
            paths: vec![PathBuf::from(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            )],
        });
        out.push(Candidate {
            id: "msedge-beta",
            name: "Microsoft Edge Beta",
            channel: Some("msedge-beta"),
            paths: vec![PathBuf::from(
                "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
            )],
        });
        out.push(Candidate {
            id: "brave",
            name: "Brave Browser",
            channel: None,
            paths: vec![PathBuf::from(
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            )],
        });
        out.push(Candidate {
            id: "chromium",
            name: "Chromium",
            channel: None,
            paths: vec![PathBuf::from(
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            )],
        });
    } else if cfg!(target_os = "windows") {
        let pf =
            std::env::var("ProgramFiles").unwrap_or_else(|_| String::from("C:\\Program Files"));
        let pf86 = std::env::var("ProgramFiles(x86)")
            .unwrap_or_else(|_| String::from("C:\\Program Files (x86)"));
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();

        // Helper: only include LOCALAPPDATA-rooted paths if the env var is set.
        // Without this guard, an empty LOCALAPPDATA produces relative paths like
        // `\Google\Chrome\Application\chrome.exe` which silently never match.
        let with_local = |path: &str| -> Option<PathBuf> {
            if local.is_empty() {
                None
            } else {
                Some(PathBuf::from(format!("{local}\\{path}")))
            }
        };

        let mut chrome_paths = vec![
            PathBuf::from(format!("{pf}\\Google\\Chrome\\Application\\chrome.exe")),
            PathBuf::from(format!("{pf86}\\Google\\Chrome\\Application\\chrome.exe")),
        ];
        if let Some(p) = with_local("Google\\Chrome\\Application\\chrome.exe") {
            chrome_paths.push(p);
        }
        out.push(Candidate {
            id: "chrome",
            name: "Google Chrome",
            channel: Some("chrome"),
            paths: chrome_paths,
        });
        out.push(Candidate {
            id: "chrome-beta",
            name: "Google Chrome Beta",
            channel: Some("chrome-beta"),
            paths: vec![
                PathBuf::from(format!(
                    "{pf}\\Google\\Chrome Beta\\Application\\chrome.exe"
                )),
                PathBuf::from(format!(
                    "{pf86}\\Google\\Chrome Beta\\Application\\chrome.exe"
                )),
            ],
        });
        let mut edge_paths = vec![
            PathBuf::from(format!("{pf86}\\Microsoft\\Edge\\Application\\msedge.exe")),
            PathBuf::from(format!("{pf}\\Microsoft\\Edge\\Application\\msedge.exe")),
        ];
        if let Some(p) = with_local("Microsoft\\Edge\\Application\\msedge.exe") {
            edge_paths.push(p);
        }
        out.push(Candidate {
            id: "msedge",
            name: "Microsoft Edge",
            channel: Some("msedge"),
            paths: edge_paths,
        });
        out.push(Candidate {
            id: "msedge-beta",
            name: "Microsoft Edge Beta",
            channel: Some("msedge-beta"),
            paths: vec![PathBuf::from(format!(
                "{pf86}\\Microsoft\\Edge Beta\\Application\\msedge.exe"
            ))],
        });
        out.push(Candidate {
            id: "brave",
            name: "Brave Browser",
            channel: None,
            paths: vec![
                PathBuf::from(format!(
                    "{pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
                )),
                PathBuf::from(format!(
                    "{pf86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
                )),
            ],
        });
    } else {
        // Linux: PATH lookup PLUS absolute paths that don't always live in
        // PATH (Snap exports symlinks to /snap/bin which IS in PATH on most
        // distros, but not all; Flatpak exports go to /var/lib/flatpak/...
        // which usually isn't; vendor packages drop into /opt/<vendor>).
        let home = std::env::var("HOME").unwrap_or_default();
        let extras: &[(&str, &[&str])] = &[
            (
                "chrome",
                &[
                    "/opt/google/chrome/google-chrome",
                    "/opt/google/chrome/chrome",
                    "/snap/bin/google-chrome",
                    "/var/lib/flatpak/exports/bin/com.google.Chrome",
                ],
            ),
            (
                "chrome-beta",
                &["/opt/google/chrome-beta/google-chrome-beta"],
            ),
            (
                "msedge",
                &[
                    "/opt/microsoft/msedge/microsoft-edge",
                    "/opt/microsoft/msedge/msedge",
                    "/snap/bin/microsoft-edge",
                ],
            ),
            (
                "brave",
                &[
                    "/opt/brave.com/brave/brave-browser",
                    "/opt/brave.com/brave/brave",
                    "/snap/bin/brave",
                ],
            ),
            (
                "chromium",
                &[
                    "/snap/bin/chromium",
                    "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
                ],
            ),
        ];

        let mut user_flatpaks: Vec<(&str, PathBuf)> = Vec::new();
        if !home.is_empty() {
            user_flatpaks.push((
                "chrome",
                PathBuf::from(format!(
                    "{home}/.local/share/flatpak/exports/bin/com.google.Chrome"
                )),
            ));
            user_flatpaks.push((
                "chromium",
                PathBuf::from(format!(
                    "{home}/.local/share/flatpak/exports/bin/org.chromium.Chromium"
                )),
            ));
        }

        for (id, name, channel, bins) in [
            (
                "chrome",
                "Google Chrome",
                Some("chrome"),
                &["google-chrome", "google-chrome-stable"][..],
            ),
            (
                "chrome-beta",
                "Google Chrome Beta",
                Some("chrome-beta"),
                &["google-chrome-beta"][..],
            ),
            (
                "msedge",
                "Microsoft Edge",
                Some("msedge"),
                &["microsoft-edge", "microsoft-edge-stable"][..],
            ),
            (
                "msedge-beta",
                "Microsoft Edge Beta",
                Some("msedge-beta"),
                &["microsoft-edge-beta"][..],
            ),
            (
                "brave",
                "Brave Browser",
                None,
                &["brave-browser", "brave"][..],
            ),
            (
                "chromium",
                "Chromium",
                None,
                &["chromium", "chromium-browser"][..],
            ),
        ] {
            let mut paths: Vec<PathBuf> = bins.iter().filter_map(|b| which_in_path(b)).collect();
            for (eid, candidates) in extras {
                if *eid == id {
                    for c in *candidates {
                        let p = PathBuf::from(c);
                        if p.exists() {
                            paths.push(p);
                        }
                    }
                }
            }
            for (uid, p) in &user_flatpaks {
                if *uid == id && p.exists() {
                    paths.push(p.clone());
                }
            }
            if !paths.is_empty() {
                out.push(Candidate {
                    id,
                    name,
                    channel,
                    paths,
                });
            }
        }
    }

    out
}

fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.exists()).cloned()
}

fn which_in_path(bin: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(bin);
        if candidate.exists() && is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}
