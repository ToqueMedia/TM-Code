use serde::Serialize;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use super::terminal::get_user_path;

/// Resolve a usable `git` binary path. On Windows, GUI apps launched from
/// Explorer may not inherit the Git for Windows install dir on PATH, so we
/// fall back to standard install locations.
fn resolve_git_binary() -> &'static str {
    static GIT_BIN: OnceLock<String> = OnceLock::new();
    GIT_BIN
        .get_or_init(|| {
            // Default: rely on PATH lookup
            let default = "git".to_string();

            #[cfg(target_os = "windows")]
            {
                // Try `git --version` from PATH first; if it fails, search known dirs
                let path_works = silent_command("git")
                    .arg("--version")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if path_works {
                    return default;
                }
                let candidates = [
                    r"C:\Program Files\Git\bin\git.exe",
                    r"C:\Program Files\Git\cmd\git.exe",
                    r"C:\Program Files (x86)\Git\bin\git.exe",
                    r"C:\Program Files (x86)\Git\cmd\git.exe",
                ];
                for candidate in &candidates {
                    if PathBuf::from(candidate).exists() {
                        eprintln!("[git] Using fallback git binary: {}", candidate);
                        return (*candidate).to_string();
                    }
                }
            }
            default
        })
        .as_str()
}

/// Create a Command that does NOT show a console window on Windows.
#[cfg(target_os = "windows")]
fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn silent_command(program: &str) -> Command {
    Command::new(program)
}

/// Create a git Command with the user's full PATH (so git installed
/// via brew/xcode-select is found even without a login shell). On Windows,
/// suppresses the brief console window flash and falls back to standard
/// Git for Windows install paths if `git` is not on PATH.
fn git_cmd(cwd: &str) -> Command {
    let mut cmd = Command::new(resolve_git_binary());
    cmd.current_dir(cwd);
    if let Some(path) = get_user_path() {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Same as git_cmd but accepts a Path
fn git_cmd_path(cwd: &std::path::Path) -> Command {
    let mut cmd = Command::new(resolve_git_binary());
    cmd.current_dir(cwd);
    if let Some(path) = get_user_path() {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[derive(Debug, Serialize, Clone)]
pub struct GitLineChange {
    pub kind: String, // "added", "modified", "removed"
    pub start_line: u32,
    pub line_count: u32,
}

/// Parse a unified diff hunk header: @@ -old_start[,old_count] +new_start[,new_count] @@
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let line = line.trim_start_matches("@@ ");
    let parts: Vec<&str> = line.split(" @@").next()?.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let old = parts[0].trim_start_matches('-');
    let new = parts[1].trim_start_matches('+');

    let (old_start, old_count) = parse_range(old)?;
    let (new_start, new_count) = parse_range(new)?;

    Some((old_start, old_count, new_start, new_count))
}

fn parse_range(s: &str) -> Option<(u32, u32)> {
    if let Some(idx) = s.find(',') {
        let start = s[..idx].parse::<u32>().ok()?;
        let count = s[idx + 1..].parse::<u32>().ok()?;
        Some((start, count))
    } else {
        let start = s.parse::<u32>().ok()?;
        Some((start, 1))
    }
}

#[tauri::command]
pub async fn git_diff_lines(file_path: String) -> Result<Vec<GitLineChange>, String> {
    let abs_path = std::path::Path::new(&file_path);
    let parent = abs_path.parent().unwrap_or(std::path::Path::new("."));

    // Find the git repo root
    let repo_root = git_cmd_path(parent)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to find git root: {}", e))?;

    if !repo_root.status.success() {
        return Err("Not a git repository".to_string());
    }

    let root = String::from_utf8_lossy(&repo_root.stdout)
        .trim()
        .to_string();

    // Convert absolute path to relative path from git root
    let rel_path = abs_path
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| file_path.clone());

    // Run git diff with no context (-U0) for precise line ranges
    let output = git_cmd(&root)
        .args(["diff", "-U0", "HEAD", "--", &rel_path])
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    // If file is untracked, check git status
    if !output.status.success() || output.stdout.is_empty() {
        // Check if file is untracked (new file)
        let status = git_cmd(&root)
            .args(["status", "--porcelain", "--", &rel_path])
            .output()
            .map_err(|e| format!("Failed to run git status: {}", e))?;

        let status_str = String::from_utf8_lossy(&status.stdout);
        if status_str.starts_with("??") || status_str.starts_with("A ") {
            // Entire file is new — count lines
            let content = std::fs::read_to_string(&file_path).unwrap_or_default();
            let line_count = content.lines().count() as u32;
            if line_count > 0 {
                return Ok(vec![GitLineChange {
                    kind: "added".to_string(),
                    start_line: 1,
                    line_count,
                }]);
            }
        }
        return Ok(vec![]);
    }

    let diff_output = String::from_utf8_lossy(&output.stdout);
    let mut changes = Vec::new();

    for line in diff_output.lines() {
        if !line.starts_with("@@") {
            continue;
        }

        if let Some((old_start, old_count, new_start, new_count)) = parse_hunk_header(line) {
            if old_count == 0 && new_count > 0 {
                // Pure addition
                changes.push(GitLineChange {
                    kind: "added".to_string(),
                    start_line: new_start,
                    line_count: new_count,
                });
            } else if old_count > 0 && new_count == 0 {
                // Pure deletion — show at the line where content was removed
                changes.push(GitLineChange {
                    kind: "removed".to_string(),
                    start_line: if new_start == 0 { 1 } else { new_start },
                    line_count: 1,
                });
            } else if old_count > 0 && new_count > 0 {
                // Modification
                changes.push(GitLineChange {
                    kind: "modified".to_string(),
                    start_line: new_start,
                    line_count: new_count,
                });
            }
            let _ = old_start; // suppress unused warning
        }
    }

    Ok(changes)
}

#[derive(Debug, Serialize, Clone)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "added", "modified", "deleted", "renamed", "untracked"
    pub staged: bool,
}

/// Get list of changed files via `git status --porcelain`
#[tauri::command]
pub async fn git_status_files(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let output = git_cmd(&project_path)
        .args(["status", "--porcelain", "-uall"])
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let index_status = line.chars().next().unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let file_path = line[3..].to_string();

        // Skip empty paths
        if file_path.trim().is_empty() {
            continue;
        }

        // Handle renames: "R  old -> new"
        let display_path = if file_path.contains(" -> ") {
            file_path
                .split(" -> ")
                .last()
                .unwrap_or(&file_path)
                .to_string()
        } else {
            file_path
        };

        // ('M','M') = both staged AND unstaged changes — emit TWO entries
        if index_status == 'M' && worktree_status == 'M' {
            files.push(GitFileStatus {
                path: display_path.clone(),
                status: "modified".to_string(),
                staged: true,
            });
            files.push(GitFileStatus {
                path: display_path,
                status: "modified".to_string(),
                staged: false,
            });
            continue;
        }

        let (status, staged) = match (index_status, worktree_status) {
            ('?', '?') => ("untracked", false),
            ('A', _) => ("added", true),
            ('M', ' ') => ("modified", true),
            (' ', 'M') => ("modified", false),
            ('D', _) => ("deleted", true),
            (' ', 'D') => ("deleted", false),
            ('R', _) => ("renamed", true),
            _ => ("modified", false),
        };

        files.push(GitFileStatus {
            path: display_path,
            status: status.to_string(),
            staged,
        });
    }

    Ok(files)
}

/// Stage a file
#[tauri::command]
pub async fn git_stage_file(project_path: String, file_path: String) -> Result<(), String> {
    let output = git_cmd(&project_path)
        .args(["add", "--", &file_path])
        .output()
        .map_err(|e| format!("git add failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

/// Stage all files
#[tauri::command]
pub async fn git_stage_all(project_path: String) -> Result<(), String> {
    let output = git_cmd(&project_path)
        .args(["add", "-A"])
        .output()
        .map_err(|e| format!("git add -A failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

/// Unstage a file
#[tauri::command]
pub async fn git_unstage_file(project_path: String, file_path: String) -> Result<(), String> {
    let output = git_cmd(&project_path)
        .args(["reset", "HEAD", "--", &file_path])
        .output()
        .map_err(|e| format!("git reset failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

/// Unstage all files
#[tauri::command]
pub async fn git_unstage_all(project_path: String) -> Result<(), String> {
    let output = git_cmd(&project_path)
        .args(["reset", "HEAD"])
        .output()
        .map_err(|e| format!("git reset failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

/// Discard changes in a file (checkout from HEAD)
#[tauri::command]
pub async fn git_discard_file(project_path: String, file_path: String) -> Result<(), String> {
    // Check if the file is untracked
    let status = git_cmd(&project_path)
        .args(["status", "--porcelain", "--", &file_path])
        .output()
        .map_err(|e| format!("git status failed: {}", e))?;

    let status_str = String::from_utf8_lossy(&status.stdout);
    if status_str.starts_with("??") {
        // Untracked file — delete it
        let full_path = std::path::Path::new(&project_path).join(&file_path);
        std::fs::remove_file(full_path).map_err(|e| format!("Failed to delete: {}", e))?;
    } else {
        // Tracked file — restore from HEAD
        let output = git_cmd(&project_path)
            .args(["checkout", "HEAD", "--", &file_path])
            .output()
            .map_err(|e| format!("git checkout failed: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }
    Ok(())
}

/// Discard all unstaged changes (tracked files restored, untracked deleted)
#[tauri::command]
pub async fn git_discard_all(project_path: String) -> Result<(), String> {
    // Restore all tracked files
    let output = git_cmd(&project_path)
        .args(["checkout", "HEAD", "--", "."])
        .output()
        .map_err(|e| format!("git checkout failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    // Remove untracked files
    let output2 = git_cmd(&project_path)
        .args(["clean", "-fd"])
        .output()
        .map_err(|e| format!("git clean failed: {}", e))?;
    if !output2.status.success() {
        return Err(String::from_utf8_lossy(&output2.stderr).to_string());
    }

    Ok(())
}

/// Commit staged changes
#[tauri::command]
pub async fn git_commit(project_path: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }

    // Append TM Code co-author signature if not already present
    let signed_message = if message.contains("Co-Authored-By:") {
        message
    } else {
        format!(
            "{}\n\nCo-Authored-By: TM Code <tm.code@toquemedia.net>",
            message.trim()
        )
    };

    let output = git_cmd(&project_path)
        .args(["commit", "-m", &signed_message])
        .output()
        .map_err(|e| format!("git commit failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Get file content from the last commit (HEAD)
#[tauri::command]
pub async fn git_show_file(project_path: String, file_path: String) -> Result<String, String> {
    // file_path is relative to project root
    let output = git_cmd(&project_path)
        .args(["show", &format!("HEAD:{}", file_path)])
        .output()
        .map_err(|e| format!("git show failed: {}", e))?;

    if !output.status.success() {
        // File doesn't exist in HEAD (new file)
        return Ok(String::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Get the current git branch name (handles detached HEAD)
#[tauri::command]
pub async fn git_current_branch(project_path: String) -> Result<String, String> {
    let output = git_cmd(&project_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get git branch: {}", e))?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Detached HEAD returns "HEAD" — get short commit hash instead
    if branch == "HEAD" {
        let hash = git_cmd(&project_path)
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "HEAD".to_string());
        return Ok(format!("HEAD ({})", hash));
    }

    Ok(branch)
}

/// Push to remote
#[tauri::command]
pub async fn git_push(
    project_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let mut cmd = git_cmd(&project_path);
    cmd.arg("push");
    if let Some(r) = &remote {
        cmd.arg(r);
    }
    if let Some(b) = &branch {
        cmd.arg(b);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("git push failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    // git push/pull write progress to stderr — return whichever has content
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// Pull from remote
#[tauri::command]
pub async fn git_pull(
    project_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<String, String> {
    let mut cmd = git_cmd(&project_path);
    cmd.arg("pull");
    if let Some(r) = &remote {
        cmd.arg(r);
    }
    if let Some(b) = &branch {
        cmd.arg(b);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("git pull failed: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok(if stdout.is_empty() { stderr } else { stdout })
}
