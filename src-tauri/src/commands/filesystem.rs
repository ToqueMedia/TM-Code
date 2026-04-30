use glob::glob as glob_match;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

use super::{canonicalize_path, normalize_path_for_frontend};

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
    copy_dir_safe(&template_path, dest_path, &mut visited)
        .map_err(|e| format!("Failed to scaffold template: {}", e))
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

// === Deploy bundle collector ===

#[derive(Debug, Serialize)]
pub struct DeployBundleFile {
    pub path: String,
    pub content: String,
    pub encoding: String, // "utf8" | "base64"
}

#[derive(Debug, Serialize)]
pub struct DeployBundle {
    pub files: Vec<DeployBundleFile>,
    pub worker_file: Option<DeployBundleFile>,
    pub has_database: bool,
    pub has_api_routes: bool,
    pub migration_sql: Option<String>,
}

/// Heuristic: a file is treated as text/UTF-8 when its extension matches one
/// of the well-known web/build asset types we expect to ship to R2. Anything
/// else (images, fonts, wasm) is base64-encoded so it round-trips through JSON
/// without corruption.
fn is_text_extension(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    matches!(
        ext.as_str(),
        "html" | "htm" | "js" | "mjs" | "cjs" | "css" | "json" | "svg" | "txt"
            | "xml" | "map" | "webmanifest" | "ts" | "tsx" | "jsx" | "md"
    )
}

/// Walk a directory and produce a flat list of files keyed by their path
/// RELATIVE to `base`. Skips dotfiles and `node_modules` defensively.
fn walk_collect(
    dir: &Path,
    base: &Path,
    out: &mut Vec<DeployBundleFile>,
) -> std::io::Result<()> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "node_modules" {
            continue;
        }

        if file_type.is_dir() {
            walk_collect(&path, base, out)?;
            continue;
        }

        let rel = path
            .strip_prefix(base)
            .map_err(|_| std::io::Error::other("strip_prefix failed"))?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");

        if is_text_extension(&rel_str) {
            match std::fs::read_to_string(&path) {
                Ok(content) => out.push(DeployBundleFile {
                    path: rel_str,
                    content,
                    encoding: "utf8".to_string(),
                }),
                Err(_) => {
                    // Binary content masquerading as text extension — fall back to base64
                    let bytes = std::fs::read(&path)?;
                    out.push(DeployBundleFile {
                        path: rel_str,
                        content: B64.encode(&bytes),
                        encoding: "base64".to_string(),
                    });
                }
            }
        } else {
            let bytes = std::fs::read(&path)?;
            out.push(DeployBundleFile {
                path: rel_str,
                content: B64.encode(&bytes),
                encoding: "base64".to_string(),
            });
        }
    }
    Ok(())
}

/// Collects everything the backend `/v1/projects/deploy` endpoint needs from
/// an already-built project. Caller must run the project's build first
/// (`npm run build` etc.) — this command does NOT trigger a build.
///
/// Conventions:
///   - Frontend assets: read from `<project>/dist/` (Vite default)
///   - Worker bundle:   `<project>/dist/worker.js` or `<project>/worker.js`
///   - Migration source: `<project>/backend/src/db/schema.ts` (Drizzle)
///   - hasApiRoutes:    `<project>/backend/` directory exists
///   - hasDatabase:     `<project>/backend/src/db/schema.ts` exists
#[tauri::command]
pub async fn collect_deploy_bundle(project_path: String) -> Result<DeployBundle, String> {
    let project = Path::new(&project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let dist_dir = project.join("dist");
    if !dist_dir.exists() || !dist_dir.is_dir() {
        // Inspect package.json to surface the project's actual build command
        // — the canonical "npm run build" is right ~95% of the time but Vite
        // workspaces, pnpm scripts, or yarn dlx setups can be different and
        // a wrong suggestion costs the user a debugging round-trip.
        let pkg_path = project.join("package.json");
        let suggestion = if pkg_path.exists() {
            std::fs::read_to_string(&pkg_path)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| {
                    let scripts = v.get("scripts")?.as_object()?;
                    if scripts.contains_key("build") {
                        Some("npm run build".to_string())
                    } else {
                        None
                    }
                })
        } else {
            None
        };
        let hint = match suggestion {
            Some(cmd) => format!(" Run `{}` first to generate dist/.", cmd),
            None => String::from(" No build script in package.json — configure one (e.g. \"build\": \"vite build\") before publishing."),
        };
        return Err(format!("dist/ not found at {}.{}", project_path, hint));
    }

    let mut files = Vec::new();
    walk_collect(&dist_dir, &dist_dir, &mut files)
        .map_err(|e| format!("Failed to read dist: {}", e))?;

    // Worker bundle — search in canonical locations, in priority order:
    //   1. backend/dist/worker.js  → the Hono+esbuild boilerplate output
    //   2. dist/worker.js          → frontend build emitted alongside assets
    //   3. worker.js               → bare project-root bundle (legacy)
    // First match wins. If a project ships multiple bundles (e.g. ran both a
    // frontend build and a backend build) the backend one is canonical.
    let mut worker_file: Option<DeployBundleFile> = None;
    let candidates = [
        project.join("backend").join("dist").join("worker.js"),
        project.join("dist").join("worker.js"),
        project.join("worker.js"),
    ];
    for candidate in candidates.iter() {
        if candidate.exists() && candidate.is_file() {
            match std::fs::read_to_string(candidate) {
                Ok(content) => {
                    worker_file = Some(DeployBundleFile {
                        path: "worker.js".to_string(),
                        content,
                        encoding: "utf8".to_string(),
                    });
                    break;
                }
                Err(e) => {
                    return Err(format!("Failed to read worker bundle: {}", e));
                }
            }
        }
    }

    // Strip the worker bundle out of the static files list so it doesn't get
    // double-uploaded as an R2 asset.
    files.retain(|f| f.path != "worker.js");

    let backend_dir = project.join("backend");
    let has_backend = backend_dir.exists() && backend_dir.is_dir();

    // Surface a precise error if a backend exists but wasn't built. This is
    // the most common failure mode after `provision_auth` installs the Hono
    // boilerplate but the user only ran the frontend build.
    if has_backend && worker_file.is_none() {
        let backend_pkg = backend_dir.join("package.json");
        if backend_pkg.exists() {
            return Err(format!(
                "backend/ found but no worker bundle. Run `cd {} && npm install && npm run build` to produce backend/dist/worker.js, then publish again.",
                backend_dir.display()
            ));
        }
    }

    let schema_path = backend_dir.join("src").join("db").join("schema.ts");
    let has_database = schema_path.exists() && schema_path.is_file();

    // Migration SQL preference, in order:
    //   1. Concatenated *.sql under backend/migrations/   ← drizzle-kit generate output (preferred — produced by Drizzle so syntax is exact)
    //   2. Raw schema.ts content                          ← fallback for the brittle regex extractor in deployOrchestrator
    let migration_sql = if has_database {
        let migrations_dir = backend_dir.join("migrations");
        let sql_files: Option<Vec<PathBuf>> = if migrations_dir.exists() && migrations_dir.is_dir() {
            std::fs::read_dir(&migrations_dir)
                .ok()
                .map(|rd| {
                    let mut files: Vec<PathBuf> = rd
                        .filter_map(|e| e.ok())
                        .map(|e| e.path())
                        .filter(|p| p.extension().is_some_and(|ext| ext == "sql"))
                        .collect();
                    files.sort();
                    files
                })
        } else {
            None
        };

        match sql_files.filter(|f| !f.is_empty()) {
            Some(files) => {
                let mut combined = String::new();
                for f in files {
                    if let Ok(content) = std::fs::read_to_string(&f) {
                        combined.push_str(&content);
                        if !content.ends_with('\n') {
                            combined.push('\n');
                        }
                    }
                }
                Some(combined)
            }
            None => std::fs::read_to_string(&schema_path).ok(),
        }
    } else {
        None
    };

    Ok(DeployBundle {
        files,
        worker_file,
        has_database,
        has_api_routes: has_backend,
        migration_sql,
    })
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

    let canonical_project = canonicalize_path(project)
        .map_err(|e| format!("Invalid project path: {}", e))?;

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

    std::fs::write(&env_path, &merged)
        .map_err(|e| format!("Failed to write .env: {}", e))?;

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
