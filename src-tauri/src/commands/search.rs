use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

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
pub struct SearchResult {
    pub query: String,
    pub total_files: usize,
    pub total_matches: usize,
    pub files: Vec<FileSearchResult>,
    pub duration_ms: u64,
    pub truncated: bool,
}

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

    // Canonicalize to prevent path traversal
    let directory_path = std::fs::canonicalize(&directory_path)
        .map_err(|e| format!("Failed to resolve directory path: {}", e))?;
    let directory = directory_path.to_string_lossy().to_string();

    // Check if ripgrep is available, fall back to grep
    let has_rg = Command::new("rg").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);

    if !has_rg {
        return search_with_grep(&query, &directory, &options, start_time);
    }

    // Build ripgrep command
    let mut cmd = Command::new("rg");

    // Basic search parameters
    cmd.arg("--json")
        .arg("--heading")
        .arg("--line-number")
        .arg("--column")
        .arg("--with-filename")
        .arg("--no-heading");

    // Case sensitivity
    if !options.case_sensitive {
        cmd.arg("--ignore-case");
    }

    // Whole word matching
    if options.whole_word {
        cmd.arg("--word-regexp");
    }

    // Context lines (show 2 lines before and after)
    cmd.arg("--context").arg("2");

    // Max results limit
    if let Some(max_results) = options.max_results {
        cmd.arg("--max-count").arg(max_results.to_string());
    }

    // Include patterns
    for pattern in &options.include_patterns {
        if !pattern.trim().is_empty() {
            cmd.arg("--glob").arg(pattern);
        }
    }

    // Exclude patterns
    for pattern in &options.exclude_patterns {
        if !pattern.trim().is_empty() {
            cmd.arg("--glob").arg(format!("!{}", pattern));
        }
    }

    // Default exclusions for common IDE patterns
    cmd.arg("--glob")
        .arg("!node_modules/**")
        .arg("--glob")
        .arg("!.git/**")
        .arg("--glob")
        .arg("!dist/**")
        .arg("--glob")
        .arg("!build/**")
        .arg("--glob")
        .arg("!.next/**")
        .arg("--glob")
        .arg("!coverage/**")
        .arg("--glob")
        .arg("!*.min.js")
        .arg("--glob")
        .arg("!*.map");

    // Add the search pattern and directory
    cmd.arg(&query).arg(&directory);

    // Execute the command
    let output = cmd.output().map_err(|e| {
        format!(
            "Failed to execute ripgrep: {}. Make sure ripgrep (rg) is installed.",
            e
        )
    })?;

    // Ripgrep exit codes: 0 = matches found, 1 = no matches, 2+ = error
    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code == 1 {
        // No matches found — return empty result, not an error
        let duration = start_time.elapsed();
        return Ok(SearchResult {
            query,
            total_files: 0,
            total_matches: 0,
            files: vec![],
            duration_ms: duration.as_millis() as u64,
            truncated: false,
        });
    }
    if exit_code >= 2 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Ripgrep search failed: {}", stderr));
    }

    // Parse ripgrep JSON output
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<FileSearchResult> = vec![];
    let mut current_file: Option<FileSearchResult> = None;
    let mut total_matches = 0;
    let mut truncated = false;

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }

        // Parse each JSON line from ripgrep
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(json) => {
                if let Some(type_field) = json.get("type").and_then(|t| t.as_str()) {
                    match type_field {
                        "match" => {
                            if let (Some(path), Some(line_number), Some(text)) = (
                                json.get("data")
                                    .and_then(|d| d.get("path"))
                                    .and_then(|p| p.get("text"))
                                    .and_then(|t| t.as_str()),
                                json.get("data")
                                    .and_then(|d| d.get("line_number"))
                                    .and_then(|l| l.as_u64()),
                                json.get("data")
                                    .and_then(|d| d.get("lines"))
                                    .and_then(|l| l.get("text"))
                                    .and_then(|t| t.as_str()),
                            ) {
                                // Get or create file result
                                if current_file.is_none()
                                    || current_file.as_ref().unwrap().file_path != path
                                {
                                    if let Some(file) = current_file {
                                        files.push(file);
                                    }
                                    current_file = Some(FileSearchResult {
                                        file_path: path.to_string(),
                                        matches: vec![],
                                        total_matches: 0,
                                    });
                                }

                                // Extract match information
                                let column =
                                    json.get("data")
                                        .and_then(|d| d.get("submatches"))
                                        .and_then(|s| s.as_array())
                                        .and_then(|arr| arr.first())
                                        .and_then(|sm| sm.get("start"))
                                        .and_then(|start| start.as_u64())
                                        .unwrap_or(0) as u32;

                                let match_text = json
                                    .get("data")
                                    .and_then(|d| d.get("submatches"))
                                    .and_then(|s| s.as_array())
                                    .and_then(|arr| arr.first())
                                    .and_then(|sm| sm.get("match"))
                                    .and_then(|m| m.get("text"))
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("")
                                    .to_string();

                                let search_match = SearchMatch {
                                    line_number: line_number as u32,
                                    column,
                                    text: text.to_string(),
                                    match_text,
                                    context_before: vec![], // We'll populate this from context data
                                    context_after: vec![],
                                };

                                if let Some(ref mut file) = current_file {
                                    file.matches.push(search_match);
                                    file.total_matches += 1;
                                    total_matches += 1;
                                }
                            }
                        }
                        "context" => {
                            // Handle context lines if needed
                        }
                        _ => {}
                    }
                }
            }
            Err(e) => {
                eprintln!("Warning: failed to parse ripgrep JSON line: {}", e);
                continue;
            }
        }
    }

    // Don't forget to add the last file
    if let Some(file) = current_file {
        files.push(file);
    }

    // Check if we hit the limit
    if let Some(max_results) = options.max_results {
        if total_matches >= max_results {
            truncated = true;
        }
    }

    let duration = start_time.elapsed();

    Ok(SearchResult {
        query,
        total_files: files.len(),
        total_matches,
        files,
        duration_ms: duration.as_millis() as u64,
        truncated,
    })
}

/// Fallback search using grep when ripgrep is not installed
fn search_with_grep(
    query: &str,
    directory: &str,
    options: &SearchOptions,
    start_time: std::time::Instant,
) -> Result<SearchResult, String> {
    let mut cmd = Command::new("grep");
    cmd.arg("-rn"); // recursive + line numbers

    if !options.case_sensitive {
        cmd.arg("-i");
    }
    if options.whole_word {
        cmd.arg("-w");
    }
    if options.use_regex {
        cmd.arg("-E");
    } else {
        cmd.arg("-F"); // fixed string
    }

    // Exclusions
    cmd.arg("--exclude-dir=node_modules")
        .arg("--exclude-dir=.git")
        .arg("--exclude-dir=dist")
        .arg("--exclude-dir=build")
        .arg("--exclude-dir=target")
        .arg("--exclude-dir=.next")
        .arg("--exclude-dir=coverage")
        .arg("--exclude=*.min.js")
        .arg("--exclude=*.map");

    for pattern in &options.exclude_patterns {
        if !pattern.trim().is_empty() {
            let clean = pattern.replace("**/", "").replace("/**", "");
            cmd.arg(format!("--exclude-dir={}", clean));
        }
    }

    // Max results
    if let Some(max) = options.max_results {
        cmd.arg("-m").arg(max.to_string());
    }

    cmd.arg("--").arg(query).arg(directory);

    let output = cmd.output().map_err(|e| format!("grep failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut file_map: std::collections::HashMap<String, FileSearchResult> = std::collections::HashMap::new();
    let mut total_matches = 0;

    for line in stdout.lines() {
        // grep output: "filepath:linenumber:text"
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() < 3 { continue; }

        let file_path = parts[0].to_string();
        let line_number = parts[1].parse::<u32>().unwrap_or(0);
        let text = parts[2].to_string();

        let entry = file_map.entry(file_path.clone()).or_insert_with(|| FileSearchResult {
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
    let truncated = options.max_results.map(|m| total_matches >= m).unwrap_or(false);

    Ok(SearchResult {
        query: query.to_string(),
        total_files: files.len(),
        total_matches,
        files,
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

    // Canonicalize to prevent path traversal
    let directory_path = std::fs::canonicalize(&directory_path)
        .map_err(|e| format!("Failed to resolve directory path: {}", e))?;
    let directory = directory_path.to_string_lossy().to_string();

    // Step 1: Use ripgrep to find files containing matches
    let mut cmd = Command::new("rg");
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

    // Default exclusions
    cmd.arg("--glob")
        .arg("!node_modules/**")
        .arg("--glob")
        .arg("!.git/**")
        .arg("--glob")
        .arg("!dist/**")
        .arg("--glob")
        .arg("!build/**");

    cmd.arg(&query).arg(&directory);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute ripgrep: {}", e))?;

    let exit_code = output.status.code().unwrap_or(-1);
    if exit_code == 1 {
        // No matches found
        return Ok(0);
    }
    if exit_code >= 2 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Replace search failed: {}", stderr));
    }

    // Step 2: Read each matched file, perform replacement, and write back
    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut affected_count: u32 = 0;

    // Build the regex for replacement
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
        let path = PathBuf::from(file_path);
        // Ensure the file is within the project directory
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
    match Command::new("rg").arg("--version").output() {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}
