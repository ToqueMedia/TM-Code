//! Deploy-pipeline filesystem ops.
//!
//! Three concerns live here, all sharing the same project-root walk:
//!   1. `collect_deploy_bundle` — read `dist/` for R2 upload + detect
//!      Drizzle schema + collect migration SQL.
//!   2. `collect_backend_tarball` — gzip the backend source for Cloud
//!      Build (composite deploys only).
//!   3. `validate_backend_for_cloud_run` — pre-flight lint that catches
//!      the Express 5 wildcard crash + Prisma-without-Drizzle gap
//!      *before* we ship a doomed build.
//!
//! The skip rules (`tarball_skip`, `tarball_skip_pattern`,
//! `tarball_skip_at_root`) are shared between the tarball walk and the
//! lint walk so the lint sees exactly the file set the tarball would.

use serde::Serialize;
use std::path::{Path, PathBuf};

// === Deploy bundle (static assets + DB detection) ===

#[derive(Debug, Serialize)]
pub struct DeployBundleFile {
    pub path: String,
    pub content: String,
    pub encoding: String, // "utf8" | "base64"
}

#[derive(Debug, Serialize)]
pub struct DeployBundle {
    pub files: Vec<DeployBundleFile>,
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
        "html"
            | "htm"
            | "js"
            | "mjs"
            | "cjs"
            | "css"
            | "json"
            | "svg"
            | "txt"
            | "xml"
            | "map"
            | "webmanifest"
            | "ts"
            | "tsx"
            | "jsx"
            | "md"
    )
}

/// Walk a directory and produce a flat list of files keyed by their path
/// RELATIVE to `base`. Skips dotfiles and `node_modules` defensively.
fn walk_collect(dir: &Path, base: &Path, out: &mut Vec<DeployBundleFile>) -> std::io::Result<()> {
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
///   - Frontend assets: read from `<project>/<output_dir>/`. Defaults to
///     `dist` when the caller doesn't supply one (Vite default). v2 strategies
///     resolve the right directory from the DeployPlan and pass it explicitly
///     (e.g. Angular's `dist/<app>/browser`).
///   - Migration source: `<project>/backend/src/db/schema.ts` (Drizzle)
///   - hasApiRoutes:    `<project>/backend/` directory exists
///   - hasDatabase:     `<project>/backend/src/db/schema.ts` exists
///
/// The v1 Hono Worker bundle path was removed in Phase 0 of PLAN-DEPLOY-V2.
/// v2 strategies collect backend artifacts plan-aware in their own modules.
#[tauri::command(rename_all = "camelCase")]
pub async fn collect_deploy_bundle(
    project_path: String,
    output_dir: Option<String>,
) -> Result<DeployBundle, String> {
    let project = Path::new(&project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    let resolved_output = output_dir.unwrap_or_else(|| "dist".to_string());
    let dist_dir = project.join(&resolved_output);
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
            Some(cmd) => format!(" Run `{}` first, then try Publish again.", cmd),
            None => String::from(" Add a `build` script to package.json (e.g. \"build\": \"vite build\"), then try Publish again."),
        };
        return Err(format!("Your project hasn't been built yet.{}", hint));
    }

    let mut files = Vec::new();
    walk_collect(&dist_dir, &dist_dir, &mut files)
        .map_err(|e| format!("Failed to read dist: {}", e))?;

    let backend_dir = project.join("backend");
    let has_backend = backend_dir.exists() && backend_dir.is_dir();

    let schema_path = backend_dir.join("src").join("db").join("schema.ts");
    let has_database = schema_path.exists() && schema_path.is_file();

    // Migration SQL preference, in order:
    //   1. Concatenated *.sql under backend/migrations/   ← drizzle-kit generate output (preferred — produced by Drizzle so syntax is exact)
    //   2. Raw schema.ts content                          ← fallback for the brittle regex extractor in deployOrchestrator
    let migration_sql = if has_database {
        let migrations_dir = backend_dir.join("migrations");
        let sql_files: Option<Vec<PathBuf>> = if migrations_dir.exists() && migrations_dir.is_dir()
        {
            std::fs::read_dir(&migrations_dir).ok().map(|rd| {
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
        has_database,
        has_api_routes: has_backend,
        migration_sql,
    })
}

// === Backend tarball (Cloud Build) ===

/// Walk the project root and produce a gzipped tar of the backend-side
/// files Cloud Build needs (Dockerfile, server source, package.json,
/// lockfile, tsconfig, drizzle.config.ts, schema/migrations).
///
/// Excludes node_modules, .git, the frontend bundle (dist/), local
/// SQLite databases, and any .env files (secrets reach the container
/// via Cloud Run env vars from the deployService.readBackendEnvVars
/// helper).
///
/// Returns the base64-encoded tarball. The deployService POSTs it to
/// /v1/projects/deploy/container/build which uploads to GCS and
/// triggers Cloud Build.
#[tauri::command(rename_all = "camelCase")]
pub async fn collect_backend_tarball(project_path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Cursor;

    let project = Path::new(&project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }

    // Dockerfile is the load-bearing entry — the platform's build pipeline
    // runs `docker build .` against it. If missing, ask the chat agent to
    // generate one for the project's backend stack.
    //
    // No `cloudbuild.yaml` requirement: the platform builds with an inline
    // spec server-side, so a file in the project would be unused dead code
    // (and would leak the build architecture). The previous check rejected
    // valid projects unnecessarily.
    if !project.join("Dockerfile").exists() {
        return Err(
            "Dockerfile missing at project root. Ask the chat agent to generate one — it knows the platform's publish-backend recipe.".to_string(),
        );
    }

    let buffer: Vec<u8> = Vec::new();
    let cursor = Cursor::new(buffer);
    let encoder = GzEncoder::new(cursor, Compression::default());
    let mut tar = tar::Builder::new(encoder);

    walk_for_tar(project, project, &mut tar)
        .map_err(|e| format!("Failed to build backend tarball: {}", e))?;

    let encoder = tar
        .into_inner()
        .map_err(|e| format!("tar finish failed: {}", e))?;
    let cursor = encoder
        .finish()
        .map_err(|e| format!("gzip finish failed: {}", e))?;
    let bytes = cursor.into_inner();

    Ok(B64.encode(&bytes))
}

/// True when `entry_name` should be excluded from the backend tarball.
/// Matches against the file/dir name (not full path) — applies at any
/// directory depth.
fn tarball_skip(entry_name: &str) -> bool {
    matches!(
        entry_name,
        "node_modules"
            | ".git"
            | "dist"           // Frontend build output — Cloudflare side handles this
            | ".next"
            | ".nuxt"
            | ".svelte-kit"
            | ".vercel"
            | ".astro"
            | ".turbo"
            | ".cache"
            | "coverage"
            | ".DS_Store"
    )
}

/// Skip files/dirs that match these patterns (case-insensitive).
/// Catches per-file rather than per-directory excludes (local sqlite,
/// .env files, etc.).
fn tarball_skip_pattern(entry_name: &str) -> bool {
    let lower = entry_name.to_ascii_lowercase();
    lower.starts_with(".env")
        || lower.ends_with(".db")
        || lower.ends_with(".db-journal")
        || lower.ends_with(".sqlite")
        || lower.ends_with(".sqlite3")
        || lower.ends_with(".log")
}

/// Frontend-shape entries to exclude **only at the project root**. The
/// backend Dockerfile's COPY filter would already keep them out of the
/// image, but they still cost upload bandwidth on the way to GCS. We don't
/// apply this list at deeper paths because legitimate backend code may live
/// under e.g. `server/src/` — only the project-root `src/` is the
/// frontend's.
fn tarball_skip_at_root(entry_name: &str) -> bool {
    matches!(
        entry_name,
        "src"
            | "public"
            | "index.html"
            | "vite.config.ts"
            | "vite.config.js"
            | "vite.config.mjs"
            | "tailwind.config.ts"
            | "tailwind.config.js"
            | "postcss.config.ts"
            | "postcss.config.js"
    )
}

/// Recursive walk that appends each kept file to the tar builder.
fn walk_for_tar(
    dir: &Path,
    base: &Path,
    tar: &mut tar::Builder<flate2::write::GzEncoder<std::io::Cursor<Vec<u8>>>>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();

        if tarball_skip(&name) {
            continue;
        }
        if tarball_skip_pattern(&name) {
            continue;
        }
        // Only apply the frontend-root exclusions when we're walking the
        // project root itself.
        if dir == base && tarball_skip_at_root(&name) {
            continue;
        }

        if file_type.is_dir() {
            walk_for_tar(&path, base, tar)?;
            continue;
        }

        // Path inside the tarball is relative to the project root.
        let rel = path
            .strip_prefix(base)
            .map_err(|_| std::io::Error::other("strip_prefix failed"))?;
        let mut file = std::fs::File::open(&path)?;
        tar.append_file(rel, &mut file)?;
    }
    Ok(())
}

// === Pre-deploy lint ===

/// Pre-deploy lint for Cloud Run / Express backends.
///
/// Cloud Run rejects containers that crash before binding `PORT=8080`. The
/// most common cause we've seen in user-generated projects is Express 5 +
/// `app.<verb>('*', ...)` — path-to-regexp 8 throws `Missing parameter name
/// at index 1: *` before the listen call, and the only signal the user gets
/// is "STARTUP TCP probe failed" with a Cloud Run logs URL. By the time
/// they click into the logs, they've already paid for a build that was
/// destined to fail.
///
/// This command runs **on the IDE side** before the tarball ships. Failures
/// here surface in the publish modal as a clear error pointing at the
/// offending file:line — the agent can fix it in seconds, and the user
/// never pays for a doomed Cloud Run revision.
///
/// Returns `Vec<String>` of human-readable findings. Empty = pass.
#[tauri::command(rename_all = "camelCase")]
pub async fn validate_backend_for_cloud_run(project_path: String) -> Result<Vec<String>, String> {
    let project = Path::new(&project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let mut findings: Vec<String> = Vec::new();

    // Prisma without Drizzle → deploy pipeline silently skips Turso
    // provisioning because `bundle.has_database` is driven by
    // `backend/src/db/schema.ts` (Drizzle convention). The container
    // boots expecting a DB, but Cloud Run env has no `TMDB_URL` /
    // `TMDB_TOKEN`, so the user's Turso dashboard stays empty AND the
    // backend crashes on first query.
    let has_prisma_schema = project.join("prisma").join("schema.prisma").exists()
        || project
            .join("server")
            .join("prisma")
            .join("schema.prisma")
            .exists()
        || project
            .join("backend")
            .join("prisma")
            .join("schema.prisma")
            .exists();
    let has_drizzle_schema = project
        .join("backend")
        .join("src")
        .join("db")
        .join("schema.ts")
        .exists();
    if has_prisma_schema && !has_drizzle_schema {
        findings.push(
            "prisma/schema.prisma — Prisma is not supported by the deploy pipeline. The platform provisions Turso (libSQL) and only detects Drizzle schemas at `backend/src/db/schema.ts`. Migrate to Drizzle via the `publish-backend` skill before publishing, otherwise the Turso dashboard stays empty and the container crashes on the first DB query.".to_string()
        );
    }

    walk_and_lint(project, project, &mut findings)
        .map_err(|e| format!("Lint walk failed: {}", e))?;
    Ok(findings)
}

fn walk_and_lint(dir: &Path, base: &Path, findings: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();

        if tarball_skip(&name) || tarball_skip_pattern(&name) {
            continue;
        }
        if dir == base && tarball_skip_at_root(&name) {
            continue;
        }

        if file_type.is_dir() {
            walk_and_lint(&path, base, findings)?;
            continue;
        }

        let rel = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        if name == "package.json" {
            if let Ok(content) = std::fs::read_to_string(&path) {
                scan_package_express_major(&content, &rel, findings);
            }
        } else if is_js_ts_source(&name) {
            if let Ok(content) = std::fs::read_to_string(&path) {
                scan_express_wildcard_routes(&content, &rel, findings);
            }
        }
    }
    Ok(())
}

fn is_js_ts_source(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".ts")
        || lower.ends_with(".tsx")
        || lower.ends_with(".js")
        || lower.ends_with(".jsx")
        || lower.ends_with(".mjs")
        || lower.ends_with(".cjs")
}

/// Detect `app.<verb>('*', ...)` and `router.<verb>('*', ...)` style routes
/// that crash under Express 5 + path-to-regexp 8.
fn scan_express_wildcard_routes(content: &str, rel_path: &str, findings: &mut Vec<String>) {
    // Verbs that take a path string as first arg.
    const PREFIXES: &[&str] = &[
        "app.get(",
        "app.use(",
        "app.all(",
        "app.post(",
        "app.put(",
        "app.delete(",
        "app.patch(",
        "app.options(",
        "app.head(",
        "router.get(",
        "router.use(",
        "router.all(",
        "router.post(",
        "router.put(",
        "router.delete(",
        "router.patch(",
    ];
    for (idx, line) in content.lines().enumerate() {
        let trimmed_line = line.trim_start();
        if trimmed_line.starts_with("//") || trimmed_line.starts_with("*") {
            continue; // Skip line comments / block-comment bodies (heuristic, not parser-perfect).
        }
        for prefix in PREFIXES {
            if let Some(pos) = line.find(prefix) {
                let after = &line[pos + prefix.len()..];
                let after_trim = after.trim_start();
                let is_bare_wildcard = after_trim.starts_with("'*'")
                    || after_trim.starts_with("\"*\"")
                    || after_trim.starts_with("`*`");
                if is_bare_wildcard {
                    findings.push(format!(
                        "{}:{} — `{}'*' ...)` is invalid in Express 5 (path-to-regexp 8 throws `Missing parameter name at index 1: *` at startup). Replace with `app.use((req, res) => ...)` for SPA fallbacks, or pin `\"express\": \"^4.21.2\"` in package.json.",
                        rel_path,
                        idx + 1,
                        prefix
                    ));
                }
            }
        }
    }
}

/// Detect `"express": "^5..."` / `"~5"` / `"5.x"` / `">=5"` in package.json
/// dependencies. Express 5 is fine in principle but the most common idiom
/// (`app.get('*', ...)`) crashes — so flag the version and let the wildcard
/// scan above pinpoint specific files. If express is v5 but no wildcards
/// were found, the warning still goes out because the user might add one
/// later; future-you can ignore it.
fn scan_package_express_major(content: &str, rel_path: &str, findings: &mut Vec<String>) {
    let value: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(_) => return, // Malformed package.json — skip silently.
    };
    for deps_key in ["dependencies", "devDependencies"] {
        let Some(deps) = value.get(deps_key).and_then(|d| d.as_object()) else {
            continue;
        };
        let Some(express) = deps.get("express").and_then(|e| e.as_str()) else {
            continue;
        };
        // Parse the first integer in the range string as the major version.
        let major_str: String = express
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(major) = major_str.parse::<u32>() {
            if major >= 5 {
                findings.push(format!(
                    "{} — express \"{}\" resolves to v{}.x. Express 5 ships path-to-regexp 8, which rejects bare wildcards (`app.get('*', ...)`). Pin to `\"express\": \"^4.21.2\"` unless every route uses named wildcards.",
                    rel_path, express, major
                ));
            }
        }
    }
}
