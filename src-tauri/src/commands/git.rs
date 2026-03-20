use serde::Serialize;
use std::process::Command;

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
    // Find the git repo root
    let repo_root = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(
            std::path::Path::new(&file_path)
                .parent()
                .unwrap_or(std::path::Path::new("/")),
        )
        .output()
        .map_err(|e| format!("Failed to find git root: {}", e))?;

    if !repo_root.status.success() {
        return Err("Not a git repository".to_string());
    }

    let root = String::from_utf8_lossy(&repo_root.stdout).trim().to_string();

    // Run git diff with no context (-U0) for precise line ranges
    let output = Command::new("git")
        .args(["diff", "-U0", "HEAD", "--", &file_path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    // If file is untracked, check git status
    if !output.status.success() || output.stdout.is_empty() {
        // Check if file is untracked (new file)
        let status = Command::new("git")
            .args(["status", "--porcelain", "--", &file_path])
            .current_dir(&root)
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

/// Get the current git branch name
#[tauri::command]
pub async fn git_current_branch(project_path: String) -> Result<String, String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&project_path)
        .output()
        .map_err(|e| format!("Failed to get git branch: {}", e))?;

    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
