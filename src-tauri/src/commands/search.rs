use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::normalize_str_for_frontend;

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
    pub max_results: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchMatch {
    pub line_number: u32,
    pub column: u32,
    pub text: String,
    pub match_text: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileSearchResult {
    pub file_path: String,
    pub matches: Vec<SearchMatch>,
    pub total_matches: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileNameMatch {
    pub file_path: String,
    pub file_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub query: String,
    pub total_files: usize,
    pub total_matches: usize,
    pub files: Vec<FileSearchResult>,
    /// Files whose name contains the query (file-name search, not content)
    pub file_name_matches: Vec<FileNameMatch>,
    pub duration_ms: u64,
    pub truncated: bool,
}

/// Global hard cap on total matches to prevent IPC/UI explosion.
const GLOBAL_MAX_MATCHES: usize = 500;
/// Max line length sent to frontend (longer lines are truncated).
const MAX_LINE_LENGTH: usize = 500;

#[tauri::command]
pub async fn search_in_files(
    query: String,
    directory: String,
    options: SearchOptions,
) -> Result<SearchResult, String> {
    let start_time = std::time::Instant::now();

    if query.trim().is_empty() {
        return Ok(SearchResult {
            query,
            total_files: 0,
            total_matches: 0,
            files: vec![],
            file_name_matches: vec![],
            duration_ms: 0,
            truncated: false,
        });
    }

    let directory_path = PathBuf::from(&directory);
    if !directory_path.exists() || !directory_path.is_dir() {
        return Err(format!(
            "Directory does not exist or is not a directory: {}",
            directory
        ));
    }

    let directory_path = std::fs::canonicalize(&directory_path)
        .map_err(|e| format!("Failed to resolve directory path: {}", e))?;

    // Security: reject search outside the user's home directory to prevent
    // path traversal attacks (e.g. searching /etc/passwd via the agent).
    // Canonicalize home too — on Windows, canonicalize() returns UNC paths (\\?\C:\...)
    // which won't match non-canonicalized paths from dirs::home_dir().
    if let Some(home) = dirs::home_dir() {
        let canonical_home = std::fs::canonicalize(&home).unwrap_or(home);
        if !directory_path.starts_with(&canonical_home) {
            return Err(format!(
                "Search directory must be within home directory: {}",
                directory_path.display()
            ));
        }
    }

    let directory = directory_path.to_string_lossy().to_string();

    let has_rg = tokio::process::Command::new("rg")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_rg {
        // On Windows, grep is not available — use findstr as last resort.
        // On macOS/Linux, grep is always available.
        if cfg!(target_os = "windows") {
            return search_with_findstr(&query, &directory, &options, start_time).await;
        }
        return search_with_grep(&query, &directory, &options, start_time).await;
    }

    let global_limit = options
        .max_results
        .map(|m| m.min(GLOBAL_MAX_MATCHES))
        .unwrap_or(GLOBAL_MAX_MATCHES);

    // Build ripgrep command — non-blocking via tokio::process
    let mut cmd = tokio::process::Command::new("rg");

    cmd.arg("--json")
        .arg("--line-number")
        .arg("--column")
        .arg("--no-heading")
        .arg("--max-filesize")
        .arg("1M")
        // Limit matches per file so results span more files instead of
        // flooding from a few files with hundreds of hits.
        .arg("--max-count")
        .arg("10");

    if !options.case_sensitive {
        cmd.arg("--ignore-case");
    }
    if options.whole_word {
        cmd.arg("--word-regexp");
    }

    // Include patterns
    for pattern in &options.include_patterns {
        if !pattern.trim().is_empty() {
            cmd.arg("--glob").arg(pattern);
        }
    }

    // User exclude patterns
    for pattern in &options.exclude_patterns {
        if !pattern.trim().is_empty() {
            cmd.arg("--glob").arg(format!("!{}", pattern));
        }
    }

    // Exclude hidden directories (.*/) and common build artifacts/lock files
    cmd.arg("--hidden") // needed so --glob can match dotfiles to exclude them
        .arg("--glob")
        .arg("!.*/**"); // exclude ALL dot-directories (.git, .next, .yarn, .nuxt, .pnpm, etc.)

    for exclude in &[
        "!node_modules/**",
        "!dist/**",
        "!build/**",
        "!coverage/**",
        "!target/**",
        "!*.min.js",
        "!*.min.css",
        "!*.map",
        "!package-lock.json",
        "!yarn.lock",
        "!pnpm-lock.yaml",
        "!*.tsbuildinfo",
    ] {
        cmd.arg("--glob").arg(exclude);
    }

    cmd.arg(&query).arg(&directory);

    let output = cmd.output().await.map_err(|e| {
        format!(
            "Failed to execute ripgrep: {}. Make sure ripgrep (rg) is installed.",
            e
        )
    })?;

    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code == 1 {
        // No content matches — but file-name matches may exist
        let duration = start_time.elapsed();
        return Ok(SearchResult {
            query,
            total_files: 0,
            total_matches: 0,
            files: vec![],
            file_name_matches: vec![],
            duration_ms: duration.as_millis() as u64,
            truncated: false,
        });
    }
    if exit_code >= 2 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Ripgrep search failed: {}", stderr));
    }

    // Parse ripgrep JSON output with a global match limit
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<FileSearchResult> = vec![];
    let mut current_file: Option<FileSearchResult> = None;
    let mut total_matches = 0;
    let mut truncated = false;

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }

        // Stop early once we hit the global limit
        if total_matches >= global_limit {
            truncated = true;
            break;
        }

        let json: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let type_field = match json.get("type").and_then(|t| t.as_str()) {
            Some(t) => t,
            None => continue,
        };

        // Only process "match" lines — skip "begin", "end", "context", "summary"
        if type_field != "match" {
            continue;
        }

        let data = match json.get("data") {
            Some(d) => d,
            None => continue,
        };

        let path = match data
            .get("path")
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
        {
            Some(p) => p,
            None => continue,
        };

        let line_number = match data.get("line_number").and_then(|l| l.as_u64()) {
            Some(n) => n as u32,
            None => continue,
        };

        let text_raw = data
            .get("lines")
            .and_then(|l| l.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        // Truncate long lines to prevent IPC bloat (char-safe for UTF-8)
        let text = if text_raw.len() > MAX_LINE_LENGTH {
            match text_raw.char_indices().nth(MAX_LINE_LENGTH) {
                Some((byte_idx, _)) => format!("{}…", &text_raw[..byte_idx]),
                None => text_raw.to_string(), // fewer chars than MAX despite more bytes
            }
        } else {
            text_raw.to_string()
        };

        // Start new file group if path changed
        if current_file.is_none() || current_file.as_ref().unwrap().file_path != path {
            if let Some(file) = current_file.take() {
                files.push(file);
            }
            current_file = Some(FileSearchResult {
                file_path: normalize_str_for_frontend(path),
                matches: vec![],
                total_matches: 0,
            });
        }

        let column = data
            .get("submatches")
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|sm| sm.get("start"))
            .and_then(|start| start.as_u64())
            .unwrap_or(0) as u32;

        let match_text = data
            .get("submatches")
            .and_then(|s| s.as_array())
            .and_then(|arr| arr.first())
            .and_then(|sm| sm.get("match"))
            .and_then(|m| m.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        if let Some(ref mut file) = current_file {
            file.matches.push(SearchMatch {
                line_number,
                column,
                text,
                match_text,
                context_before: vec![],
                context_after: vec![],
            });
            file.total_matches += 1;
            total_matches += 1;
        }
    }

    if let Some(file) = current_file {
        files.push(file);
    }

    if !truncated {
        if let Some(max) = options.max_results {
            if total_matches >= max {
                truncated = true;
            }
        }
    }

    // Sort: files whose basename contains the query come first,
    // then by path alphabetically. This ensures "index.ts" appears
    // near the top when searching for "index".
    let query_lower = query.to_lowercase();
    files.sort_by(|a, b| {
        let a_name = std::path::Path::new(&a.file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| a.file_path.to_lowercase());
        let b_name = std::path::Path::new(&b.file_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| b.file_path.to_lowercase());
        let a_in_name = a_name.contains(&query_lower);
        let b_in_name = b_name.contains(&query_lower);
        match (a_in_name, b_in_name) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_path.cmp(&b.file_path),
        }
    });

    let duration = start_time.elapsed();

    Ok(SearchResult {
        query,
        total_files: files.len(),
        total_matches,
        files,
        file_name_matches: vec![],
        duration_ms: duration.as_millis() as u64,
        truncated,
    })
}

/// Fallback search using grep when ripgrep is not installed (non-blocking)
async fn search_with_grep(
    query: &str,
    directory: &str,
    options: &SearchOptions,
    start_time: std::time::Instant,
) -> Result<SearchResult, String> {
    let mut cmd = tokio::process::Command::new("grep");
    cmd.arg("-rn");

    if !options.case_sensitive {
        cmd.arg("-i");
    }
    if options.whole_word {
        cmd.arg("-w");
    }
    if options.use_regex {
        cmd.arg("-E");
    } else {
        cmd.arg("-F");
    }

    cmd.arg("--exclude-dir=.*") // all dot-directories
        .arg("--exclude-dir=node_modules")
        .arg("--exclude-dir=dist")
        .arg("--exclude-dir=build")
        .arg("--exclude-dir=target")
        .arg("--exclude-dir=coverage")
        .arg("--exclude=*.min.js")
        .arg("--exclude=*.min.css")
        .arg("--exclude=*.map")
        .arg("--exclude=package-lock.json")
        .arg("--exclude=yarn.lock")
        .arg("--exclude=pnpm-lock.yaml");

    for pattern in &options.exclude_patterns {
        if !pattern.trim().is_empty() {
            let clean = pattern.replace("**/", "").replace("/**", "");
            cmd.arg(format!("--exclude-dir={}", clean));
        }
    }

    if let Some(max) = options.max_results {
        cmd.arg("-m").arg(max.min(GLOBAL_MAX_MATCHES).to_string());
    } else {
        cmd.arg("-m").arg(GLOBAL_MAX_MATCHES.to_string());
    }

    cmd.arg("--").arg(query).arg(directory);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("grep failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut file_map: std::collections::HashMap<String, FileSearchResult> =
        std::collections::HashMap::new();
    let mut total_matches = 0;

    for line in stdout.lines() {
        if total_matches >= GLOBAL_MAX_MATCHES {
            break;
        }

        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() < 3 {
            continue;
        }

        let file_path = parts[0].to_string();
        let line_number = parts[1].parse::<u32>().unwrap_or(0);
        let text_raw = parts[2];
        let text = if text_raw.len() > MAX_LINE_LENGTH {
            match text_raw.char_indices().nth(MAX_LINE_LENGTH) {
                Some((byte_idx, _)) => format!("{}…", &text_raw[..byte_idx]),
                None => text_raw.to_string(),
            }
        } else {
            text_raw.to_string()
        };

        let entry = file_map
            .entry(file_path.clone())
            .or_insert_with(|| FileSearchResult {
                file_path,
                matches: vec![],
                total_matches: 0,
            });

        entry.matches.push(SearchMatch {
            line_number,
            column: 1,
            text: text.clone(),
            match_text: query.to_string(),
            context_before: vec![],
            context_after: vec![],
        });
        entry.total_matches += 1;
        total_matches += 1;
    }

    let files: Vec<FileSearchResult> = file_map.into_values().collect();
    let duration = start_time.elapsed();
    let truncated = total_matches >= GLOBAL_MAX_MATCHES;

    Ok(SearchResult {
        query: query.to_string(),
        total_files: files.len(),
        total_matches,
        files,
        file_name_matches: vec![], // grep fallback doesn't do filename search
        duration_ms: duration.as_millis() as u64,
        truncated,
    })
}

/// Windows-only fallback using findstr when neither ripgrep nor grep are available.
#[allow(dead_code)]
async fn search_with_findstr(
    query: &str,
    directory: &str,
    options: &SearchOptions,
    start_time: std::time::Instant,
) -> Result<SearchResult, String> {
    let mut cmd = tokio::process::Command::new("findstr");
    cmd.arg("/S") // search subdirectories
        .arg("/N"); // print line numbers

    if !options.case_sensitive {
        cmd.arg("/I");
    }

    if !options.use_regex {
        cmd.arg("/L"); // literal match (default, but explicit)
    } else {
        cmd.arg("/R"); // regex (basic, not full PCRE)
    }

    // findstr pattern and file spec
    cmd.arg(query).arg(format!("{}\\*", directory));

    // Hide console window on Windows
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("findstr failed: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut file_map: std::collections::HashMap<String, FileSearchResult> =
        std::collections::HashMap::new();
    let mut total_matches = 0;

    // findstr output format: "filepath:line_number:text"
    for line in stdout.lines() {
        if total_matches >= GLOBAL_MAX_MATCHES {
            break;
        }

        let parts: Vec<&str> = line.splitn(3, ':').collect();
        // Windows paths have C: prefix — need at least 4 parts for drive letter
        let (file_path, line_number, text) = if parts.len() >= 2
            && parts[0].len() == 1
            && parts[0]
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false)
        {
            // Drive letter detected: "C:path:line:text"
            let rest: Vec<&str> = line[2..].splitn(3, ':').collect();
            if rest.len() < 3 {
                continue;
            }
            (
                format!("{}:{}", parts[0], rest[0]),
                rest[1].parse::<u32>().unwrap_or(0),
                rest[2].to_string(),
            )
        } else if parts.len() >= 3 {
            (
                parts[0].to_string(),
                parts[1].parse::<u32>().unwrap_or(0),
                parts[2].to_string(),
            )
        } else {
            continue;
        };

        let text = if text.len() > MAX_LINE_LENGTH {
            match text.char_indices().nth(MAX_LINE_LENGTH) {
                Some((byte_idx, _)) => format!("{}…", &text[..byte_idx]),
                None => text,
            }
        } else {
            text
        };

        let entry = file_map
            .entry(file_path.clone())
            .or_insert_with(|| FileSearchResult {
                file_path,
                matches: vec![],
                total_matches: 0,
            });

        entry.matches.push(SearchMatch {
            line_number,
            column: 1,
            text: text.clone(),
            match_text: query.to_string(),
            context_before: vec![],
            context_after: vec![],
        });
        entry.total_matches += 1;
        total_matches += 1;
    }

    let files: Vec<FileSearchResult> = file_map.into_values().collect();
    let duration = start_time.elapsed();
    let truncated = total_matches >= GLOBAL_MAX_MATCHES;

    Ok(SearchResult {
        query: query.to_string(),
        total_files: files.len(),
        total_matches,
        files,
        file_name_matches: vec![],
        duration_ms: duration.as_millis() as u64,
        truncated,
    })
}

#[tauri::command]
pub async fn replace_in_files(
    query: String,
    replacement: String,
    directory: String,
    options: SearchOptions,
) -> Result<u32, String> {
    if query.trim().is_empty() {
        return Err("Search query cannot be empty".to_string());
    }

    let directory_path = PathBuf::from(&directory);
    if !directory_path.exists() || !directory_path.is_dir() {
        return Err(format!(
            "Directory does not exist or is not a directory: {}",
            directory
        ));
    }

    let directory_path = std::fs::canonicalize(&directory_path)
        .map_err(|e| format!("Failed to resolve directory path: {}", e))?;
    let directory = directory_path.to_string_lossy().to_string();

    let mut cmd = tokio::process::Command::new("rg");
    cmd.arg("--files-with-matches");

    if !options.case_sensitive {
        cmd.arg("--ignore-case");
    }
    if options.whole_word {
        cmd.arg("--word-regexp");
    }

    for pattern in &options.include_patterns {
        if !pattern.trim().is_empty() {
            cmd.arg("--glob").arg(pattern);
        }
    }
    for pattern in &options.exclude_patterns {
        if !pattern.trim().is_empty() {
            cmd.arg("--glob").arg(format!("!{}", pattern));
        }
    }

    for exclude in &[
        "!node_modules/**",
        "!.git/**",
        "!dist/**",
        "!build/**",
        "!package-lock.json",
        "!yarn.lock",
        "!pnpm-lock.yaml",
    ] {
        cmd.arg("--glob").arg(exclude);
    }

    cmd.arg(&query).arg(&directory);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute ripgrep: {}", e))?;

    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code == 1 {
        return Ok(0);
    }
    if exit_code >= 2 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Replace search failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut affected_count: u32 = 0;

    let regex = if options.use_regex {
        if options.case_sensitive {
            regex::Regex::new(&query)
        } else {
            regex::Regex::new(&format!("(?i){}", query))
        }
    } else {
        let escaped = regex::escape(&query);
        let pattern = if options.whole_word {
            format!(r"\b{}\b", escaped)
        } else {
            escaped
        };
        if options.case_sensitive {
            regex::Regex::new(&pattern)
        } else {
            regex::Regex::new(&format!("(?i){}", pattern))
        }
    }
    .map_err(|e| format!("Invalid search pattern: {}", e))?;

    for file_path in &files {
        // Canonicalize to match directory_path (which is canonicalized).
        // On Windows, canonicalize returns UNC paths (\\?\C:\...) — both must match.
        let path = std::fs::canonicalize(file_path).unwrap_or_else(|_| PathBuf::from(file_path));
        if !path.starts_with(&directory_path) {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                let new_content = regex
                    .replace_all(&content, replacement.as_str())
                    .to_string();
                if new_content != content {
                    if let Err(e) = std::fs::write(&path, &new_content) {
                        eprintln!("Failed to write replacement to {}: {}", file_path, e);
                        continue;
                    }
                    affected_count += 1;
                }
            }
            Err(e) => {
                eprintln!("Failed to read {}: {}", file_path, e);
            }
        }
    }

    Ok(affected_count)
}

#[tauri::command]
pub async fn check_ripgrep_available() -> Result<bool, String> {
    match tokio::process::Command::new("rg")
        .arg("--version")
        .output()
        .await
    {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}
