use glob::glob as glob_match;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

use super::{canonicalize_path, normalize_path_for_frontend};

// Deploy-pipeline ops (collect_deploy_bundle, collect_backend_tarball,
// validate_backend_for_cloud_run) live in `super::deploy`.

/// Validates that a template ID contains only safe characters (alphanumeric, hyphens).
/// Prevents path traversal via crafted IDs like "../../../etc".
fn validate_template_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("Template ID cannot be empty".to_string());
    }
    if id.contains("..") || id.contains('/') || id.contains('\\') || id.contains('\0') {
        return Err(format!("Invalid template ID: {}", id));
    }
    // Allow only alphanumeric, hyphens, and underscores
    if !id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Invalid template ID: {}", id));
    }
    Ok(())
}

/// Scaffold a template from bundled resources to a destination directory.
/// Resolves the template path internally via Tauri's resource system —
/// the frontend never sends raw filesystem paths.
#[tauri::command]
pub async fn scaffold_template(
    app: tauri::AppHandle,
    template_id: String,
    destination: String,
) -> Result<(), String> {
    validate_template_id(&template_id)?;

    let dest_path = Path::new(&destination);
    if !dest_path.exists() {
        std::fs::create_dir_all(dest_path)
            .map_err(|e| format!("Failed to create destination: {}", e))?;
    }

    // Resolve template from bundled resources via Tauri's resource resolver.
    // In dev mode this resolves to src-tauri/resources/templates/{id}.
    // In production this resolves into the app bundle's resource directory.
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

    let template_path = resource_dir
        .join("resources")
        .join("templates")
        .join(&template_id);

    if !template_path.exists() || !template_path.is_dir() {
        return Err(format!(
            "Template '{}' not found at {:?}",
            template_id, template_path
        ));
    }

    let mut visited = HashSet::new();
    copy_template_dir(&template_path, dest_path, &mut visited)
        .map_err(|e| format!("Failed to scaffold template: {}", e))
}

/// Like `copy_dir_safe` but renames bundler-friendly underscore-prefixed
/// names back to dotfiles on the destination side: `_gitignore` →
/// `.gitignore`, `_env.example` → `.env.example`. The reason: Tauri's
/// resource bundler (and many CI pipelines) silently exclude dotfiles via
/// glob defaults, so we ship dotfiles as `_xxx` in the source tree and
/// restore the dot at scaffold time. Only the prefix is rewritten — the
/// rest of the filename is unchanged. Subdirectories inherit nothing.
fn copy_template_dir(
    src: &Path,
    dst: &Path,
    visited: &mut HashSet<PathBuf>,
) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    if let Ok(canonical) = canonicalize_path(src) {
        if !visited.insert(canonical) {
            return Ok(());
        }
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let raw_name = entry.file_name();
        let name_str = raw_name.to_string_lossy();

        // Restore dotfile prefix only at the leaf level. We don't rename
        // directories — none of our templates ship dot-directories.
        let resolved_name = if let Some(rest) = name_str.strip_prefix('_') {
            // Whitelist the rewrite to known dotfile names so a stray
            // _foo file doesn't get clobbered into .foo unintentionally.
            match rest {
                "gitignore" | "env.example" | "env" | "dockerignore" | "npmignore"
                | "prettierrc" | "prettierrc.json" | "eslintrc" | "eslintrc.json" => {
                    format!(".{}", rest)
                }
                _ => name_str.to_string(),
            }
        } else {
            name_str.to_string()
        };

        let dest_entry = dst.join(&resolved_name);

        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            copy_template_dir(&entry.path(), &dest_entry, visited)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest_entry)?;
        }
    }

    Ok(())
}

/// Generic copy_directory exposed to the frontend.
/// Validates source/destination and uses safe recursive copy.
#[tauri::command]
pub async fn copy_directory(source: String, destination: String) -> Result<(), String> {
    let source_path = Path::new(&source);
    let dest_path = Path::new(&destination);

    if !source_path.exists() {
        return Err(format!("Source does not exist: {}", source));
    }

    // Canonicalize to prevent path traversal via symlinks in the source arg
    let canonical_source =
        canonicalize_path(source_path).map_err(|e| format!("Invalid source path: {}", e))?;

    let mut visited = HashSet::new();
    copy_dir_safe(&canonical_source, dest_path, &mut visited)
        .map_err(|e| format!("Failed to copy directory: {}", e))
}

/// Recursively copies a directory, skipping symlinks and tracking visited
/// inodes to prevent infinite loops from circular symlinks.
fn copy_dir_safe(src: &Path, dst: &Path, visited: &mut HashSet<PathBuf>) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    // Track canonical path to detect cycles
    if let Ok(canonical) = canonicalize_path(src) {
        if !visited.insert(canonical) {
            // Already visited this directory — cycle detected, skip
            return Ok(());
        }
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_entry = dst.join(entry.file_name());

        // Skip symlinks entirely — templates should never contain them
        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            copy_dir_safe(&entry.path(), &dest_entry, visited)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dest_entry)?;
        }
        // Skip special files (sockets, pipes, etc.)
    }

    Ok(())
}

#[tauri::command]
pub async fn glob_files(pattern: String, directory: String) -> Result<Vec<String>, String> {
    // Block path traversal in pattern
    if pattern.contains("..") {
        return Err("Invalid glob pattern: '..' is not allowed".to_string());
    }
    // Block absolute patterns
    if pattern.starts_with('/') || pattern.starts_with('\\') {
        return Err("Invalid glob pattern: absolute paths are not allowed".to_string());
    }

    let full_pattern = format!("{}/{}", directory, pattern);

    // Canonicalize directory to compare results against
    let canonical_dir = canonicalize_path(std::path::Path::new(&directory))
        .map_err(|e| format!("Invalid directory: {}", e))?;

    let mut results = Vec::new();

    let entries = glob_match(&full_pattern).map_err(|e| format!("Invalid glob pattern: {}", e))?;

    for entry in entries {
        match entry {
            Ok(path) => {
                // Verify result is within directory (defense in depth)
                if let Ok(canonical_p) = canonicalize_path(&path) {
                    if !canonical_p.starts_with(&canonical_dir) {
                        continue;
                    }
                }

                let path_str = normalize_path_for_frontend(&path);
                // Check excluded directories (always uses / after normalization)
                let has_excluded = |segment: &str| path_str.contains(&format!("/{}/", segment));
                if !has_excluded("node_modules")
                    && !has_excluded(".git")
                    && !has_excluded("dist")
                    && !has_excluded("build")
                {
                    results.push(path_str);
                }
            }
            Err(e) => {
                eprintln!("Glob error: {}", e);
            }
        }
    }

    if results.len() > 500 {
        results.truncate(500);
    }

    Ok(results)
}

// === Bundled Skills ===

#[derive(Debug, Serialize)]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct SkillContent {
    pub content: String,
    pub references: Vec<String>,
}

/// Lists all bundled skills from the app's resource directory.
/// Each skill is a directory containing a SKILL.md file.
#[tauri::command]
pub async fn list_skills_bundled(app: tauri::AppHandle) -> Result<Vec<SkillEntry>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {}", e))?;

    let skills_dir = resource_dir.join("resources").join("skills");

    if !skills_dir.exists() || !skills_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();

    let read_dir = std::fs::read_dir(&skills_dir)
        .map_err(|e| format!("Failed to read skills directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            let skill_file = path.join("SKILL.md");
            if skill_file.exists() {
                let name = entry.file_name().to_string_lossy().to_string();
                entries.push(SkillEntry {
                    name,
                    path: normalize_path_for_frontend(&path),
                });
            }
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

// === Secure .env writes ===

#[derive(Debug, serde::Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

/// Validates an env var key: must match `^[A-Z_][A-Z0-9_]*$`. This is the
/// POSIX-portable subset; rejects lowercase, dots, dashes, anything that
/// would make `KEY=value` parsing ambiguous when the .env is loaded by
/// dotenv/Vite/Node. Returning an error here prevents a malicious tool
/// argument from injecting a newline + a different key.
fn validate_env_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("Env var key cannot be empty".to_string());
    }
    let mut chars = key.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_uppercase() || first == '_') {
        return Err(format!(
            "Invalid env var key '{}': must start with A-Z or _",
            key
        ));
    }
    for c in chars {
        if !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
            return Err(format!(
                "Invalid env var key '{}': only A-Z, 0-9, _ allowed",
                key
            ));
        }
    }
    Ok(())
}

/// Merge `vars` into `<project_path>/.env`, preserving any keys not in the
/// new set and overwriting keys that already exist. Creates the file with
/// mode 0600 (owner read/write) on Unix if it doesn't exist.
///
/// This is the **only** legitimate write path for `.env` from the agent flow.
/// The agent itself is blocked from touching .env (see toolExecutor.ts) —
/// this command is invoked by the user submitting the credential form.
#[tauri::command]
pub async fn write_env_vars(project_path: String, vars: Vec<EnvVar>) -> Result<(), String> {
    if vars.is_empty() {
        return Ok(());
    }

    let project = Path::new(&project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let canonical_project =
        canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;

    let env_path = canonical_project.join(".env");

    // Defense-in-depth: confirm the resolved .env still sits inside the project.
    if !env_path.starts_with(&canonical_project) {
        return Err("Resolved .env path escapes project root".to_string());
    }

    for v in &vars {
        validate_env_key(&v.key)?;
        if v.value.contains('\n') || v.value.contains('\r') {
            return Err(format!(
                "Value for '{}' contains a newline — refusing to write",
                v.key
            ));
        }
    }

    let existing = if env_path.exists() {
        std::fs::read_to_string(&env_path)
            .map_err(|e| format!("Failed to read existing .env: {}", e))?
    } else {
        String::new()
    };

    let new_keys: HashSet<&str> = vars.iter().map(|v| v.key.as_str()).collect();

    let mut merged = String::new();
    for line in existing.lines() {
        let trimmed = line.trim_start();
        // Preserve comments and blank lines as-is
        if trimmed.is_empty() || trimmed.starts_with('#') {
            merged.push_str(line);
            merged.push('\n');
            continue;
        }
        // Preserve lines whose key isn't being overwritten
        if let Some(eq_idx) = trimmed.find('=') {
            let key = &trimmed[..eq_idx];
            if !new_keys.contains(key) {
                merged.push_str(line);
                merged.push('\n');
            }
        } else {
            // Malformed line — keep it untouched
            merged.push_str(line);
            merged.push('\n');
        }
    }

    // Append the new/overwritten keys at the end
    for v in &vars {
        let needs_quoting = v.value.contains(' ') || v.value.contains('"') || v.value.contains('#');
        if needs_quoting {
            let escaped = v.value.replace('\\', "\\\\").replace('"', "\\\"");
            merged.push_str(&format!("{}=\"{}\"\n", v.key, escaped));
        } else {
            merged.push_str(&format!("{}={}\n", v.key, v.value));
        }
    }

    std::fs::write(&env_path, &merged).map_err(|e| format!("Failed to write .env: {}", e))?;

    // Restrict permissions on Unix (owner read/write only).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&env_path, perms)
            .map_err(|e| format!("Failed to set .env permissions: {}", e))?;
    }

    Ok(())
}

/// Read selected env vars from a project's `.env`. Returns a map containing
/// only the requested `keys` that are present in the file; missing keys are
/// simply absent from the result. Whitespace and surrounding quotes are
/// stripped from values; `\"` and `\\` escapes inside double-quoted values
/// are decoded. Comment lines (`#...`) and blank lines are ignored.
///
/// This is a *read* counterpart to `write_env_vars` — used by the data viewer
/// to fetch `TMDB_URL` + `TMDB_TOKEN` without exposing the rest of `.env`.
#[tauri::command]
pub async fn read_env_vars(
    project_path: String,
    keys: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    if keys.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let project = Path::new(&project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical_project =
        canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;

    let env_path = canonical_project.join(".env");
    if !env_path.starts_with(&canonical_project) {
        return Err("Resolved .env path escapes project root".to_string());
    }
    if !env_path.exists() {
        return Ok(std::collections::HashMap::new());
    }

    for k in &keys {
        validate_env_key(k)?;
    }
    let wanted: HashSet<&str> = keys.iter().map(|s| s.as_str()).collect();

    let content =
        std::fs::read_to_string(&env_path).map_err(|e| format!("Failed to read .env: {}", e))?;

    let mut out: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq_idx) = trimmed.find('=') else {
            continue;
        };
        let key = trimmed[..eq_idx].trim();
        if !wanted.contains(key) {
            continue;
        }
        let raw = trimmed[eq_idx + 1..].trim();
        let value = parse_env_value(raw);
        out.insert(key.to_string(), value);
    }
    Ok(out)
}

/// Decode a `.env` value: strip a matched pair of surrounding double-quotes
/// (and unescape `\"` / `\\` inside) or single-quotes (kept literal), and
/// otherwise return the trimmed input. Inline comments after an unquoted value
/// are dropped at the first ` #`.
fn parse_env_value(raw: &str) -> String {
    if raw.len() >= 2 {
        let bytes = raw.as_bytes();
        if bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
            let inner = &raw[1..raw.len() - 1];
            let mut out = String::with_capacity(inner.len());
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('"') => out.push('"'),
                        Some('\\') => out.push('\\'),
                        Some('n') => out.push('\n'),
                        Some('r') => out.push('\r'),
                        Some('t') => out.push('\t'),
                        Some(other) => {
                            out.push('\\');
                            out.push(other);
                        }
                        None => out.push('\\'),
                    }
                } else {
                    out.push(c);
                }
            }
            return out;
        }
        if bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'' {
            return raw[1..raw.len() - 1].to_string();
        }
    }
    if let Some(idx) = raw.find(" #") {
        return raw[..idx].trim_end().to_string();
    }
    raw.to_string()
}

/// Reads the content of a skill directory (SKILL.md + optional references/*.md).
#[tauri::command]
pub async fn read_skill_content(skill_path: String) -> Result<SkillContent, String> {
    let base = Path::new(&skill_path);

    // Read main SKILL.md
    let skill_file = base.join("SKILL.md");
    let content = std::fs::read_to_string(&skill_file)
        .map_err(|e| format!("Failed to read SKILL.md: {}", e))?;

    // Read optional references
    let mut references = Vec::new();
    let refs_dir = base.join("references");
    if refs_dir.exists() && refs_dir.is_dir() {
        if let Ok(read_dir) = std::fs::read_dir(&refs_dir) {
            for entry in read_dir.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "md") {
                    if let Ok(ref_content) = std::fs::read_to_string(&path) {
                        references.push(ref_content);
                    }
                }
            }
        }
    }

    Ok(SkillContent {
        content,
        references,
    })
}

// ── Agent state persistence (.toquemedia/) ─────────────────────────────
//
// Per-project hidden folder for agent state that must survive across:
//   - app restarts (battery dies, crash, IDE quit + reopen),
//   - session boundaries (budget interrupt, then resume hours later),
//   - filesystem-as-snapshot views (the folder is committable so the
//     state can travel with the project to another machine / agent).
//
// The folder lives at `<project>/.toquemedia/`. Only files whose name
// matches `[a-zA-Z0-9_.-]+` are read or written — no path traversal,
// no nested directories, no symlinks followed. The whole API is
// project-rooted: the caller passes the project path; the resolved
// `.toquemedia/<filename>` MUST live underneath after canonicalisation
// or the call refuses.
//
// Pattern matches `write_env_vars` defense-in-depth: canonicalise the
// project root, join, then `starts_with(project_root)` check before
// any I/O.

fn validate_agent_state_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty() {
        return Err("Agent state filename cannot be empty".to_string());
    }
    if filename.len() > 64 {
        return Err(format!(
            "Agent state filename too long ({} chars)",
            filename.len()
        ));
    }
    if !filename
        .chars()
        .all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!("Invalid agent state filename: {}", filename));
    }
    if filename.starts_with('.') || filename.contains("..") {
        return Err(format!(
            "Agent state filename cannot start with . or contain .. ({})",
            filename
        ));
    }
    Ok(())
}

fn agent_state_path(project_path: &str, filename: &str) -> Result<PathBuf, String> {
    validate_agent_state_filename(filename)?;
    let project = Path::new(project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical_project =
        canonicalize_path(project).map_err(|e| format!("Invalid project path: {}", e))?;
    let dir = canonical_project.join(".toquemedia");
    let file = dir.join(filename);
    // Defense-in-depth: resolved file path must still be inside the project.
    if !file.starts_with(&canonical_project) {
        return Err("Resolved .toquemedia path escapes project root".to_string());
    }
    Ok(file)
}

/// Read a JSON state blob from `<project>/.toquemedia/<filename>`.
///
/// Returns `Ok(None)` when the file does not exist — distinguishes
/// "never written" from "read failure" so the TS layer can hydrate from
/// scratch on first open without surfacing a misleading error.
#[tauri::command]
pub async fn read_agent_state(
    project_path: String,
    filename: String,
) -> Result<Option<String>, String> {
    let path = agent_state_path(&project_path, &filename)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("Failed to read {}: {}", filename, e))
}

/// Write a JSON state blob to `<project>/.toquemedia/<filename>`.
///
/// Creates the `.toquemedia/` directory on first call. Writes are
/// atomic-ish: write to `<filename>.tmp` then rename, so a crash mid-
/// write does not leave a half-file the next read would parse as
/// corrupted JSON.
#[tauri::command]
pub async fn write_agent_state(
    project_path: String,
    filename: String,
    content: String,
) -> Result<(), String> {
    let path = agent_state_path(&project_path, &filename)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .toquemedia/: {}", e))?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {}", filename, e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Failed to commit {}: {}", filename, e))?;
    Ok(())
}
