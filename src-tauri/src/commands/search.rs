use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};

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
        return Err(format!("Directory does not exist or is not a directory: {}", directory));
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
    cmd.arg("--glob").arg("!node_modules/**")
       .arg("--glob").arg("!.git/**")
       .arg("--glob").arg("!dist/**")
       .arg("--glob").arg("!build/**")
       .arg("--glob").arg("!.next/**")
       .arg("--glob").arg("!coverage/**")
       .arg("--glob").arg("!*.min.js")
       .arg("--glob").arg("!*.map");

    // Add the search pattern and directory
    cmd.arg(&query).arg(&directory);

    // Execute the command
    let output = cmd.output()
        .map_err(|e| format!("Failed to execute ripgrep: {}. Make sure ripgrep (rg) is installed.", e))?;

    if !output.status.success() {
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
                                json.get("data").and_then(|d| d.get("path")).and_then(|p| p.get("text")).and_then(|t| t.as_str()),
                                json.get("data").and_then(|d| d.get("line_number")).and_then(|l| l.as_u64()),
                                json.get("data").and_then(|d| d.get("lines")).and_then(|l| l.get("text")).and_then(|t| t.as_str())
                            ) {
                                // Get or create file result
                                if current_file.is_none() || current_file.as_ref().unwrap().file_path != path {
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
                                let column = json.get("data")
                                    .and_then(|d| d.get("submatches"))
                                    .and_then(|s| s.as_array())
                                    .and_then(|arr| arr.get(0))
                                    .and_then(|sm| sm.get("start"))
                                    .and_then(|start| start.as_u64())
                                    .unwrap_or(0) as u32;

                                let match_text = json.get("data")
                                    .and_then(|d| d.get("submatches"))
                                    .and_then(|s| s.as_array())
                                    .and_then(|arr| arr.get(0))
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
            Err(_) => {
                // Skip invalid JSON lines
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
        return Err(format!("Directory does not exist or is not a directory: {}", directory));
    }

    let mut cmd = Command::new("rg");
    
    // Enable replacement mode
    cmd.arg("--replace").arg(&replacement);
    cmd.arg("--files-with-matches");

    // Case sensitivity
    if !options.case_sensitive {
        cmd.arg("--ignore-case");
    }

    // Whole word matching
    if options.whole_word {
        cmd.arg("--word-regexp");
    }

    // Include/exclude patterns
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
    cmd.arg("--glob").arg("!node_modules/**")
       .arg("--glob").arg("!.git/**")
       .arg("--glob").arg("!dist/**")
       .arg("--glob").arg("!build/**");

    cmd.arg(&query).arg(&directory);

    let output = cmd.output()
        .map_err(|e| format!("Failed to execute ripgrep replace: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Replace operation failed: {}", stderr));
    }

    // Count the number of files that would be affected
    let stdout = String::from_utf8_lossy(&output.stdout);
    let affected_files = stdout.lines().filter(|line| !line.trim().is_empty()).count();

    Ok(affected_files as u32)
}

#[tauri::command] 
pub async fn check_ripgrep_available() -> Result<bool, String> {
    match Command::new("rg").arg("--version").output() {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}