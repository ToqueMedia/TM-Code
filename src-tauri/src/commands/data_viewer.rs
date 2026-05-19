use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;

use super::canonicalize_path;

/// Cell value as the frontend will receive it. JSON-friendly subset of SQLite
/// types; BLOBs surface as a tagged object `{ __binary: N }` instead of being
/// stuffed into the Text variant — the previous design used a string sentinel
/// (`<binary, N bytes>`) and JS detected it by substring, which would also
/// match a legitimate TEXT row that happened to use the same shape. The
/// tagged variant lets the renderer key off the discriminator instead.
///
/// The non-Blob variants stay `untagged` so they serialize as bare JSON
/// primitives (`42`, `"hello"`, `null`) — the front-end keeps the same
/// `Cell = null | number | string | boolean` union for them.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum CellValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    /// Tagged BLOB placeholder: `{ "__binary": <byteCount> }`.
    Blob(BlobMarker),
}

#[derive(Debug, Serialize)]
pub struct BlobMarker {
    #[serde(rename = "__binary")]
    pub binary: u64,
}

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<CellValue>>,
}

/// Opens the project's `dev.db` in read-only mode. Refuses any path that
/// resolves outside `<project_path>/dev.db` (mirrors the JS-side
/// `validatePathWithinProject` from toolExecutor.ts:644).
fn open_dev_db(project_path: &str) -> Result<Connection, String> {
    let project = Path::new(project_path);
    if !project.exists() || !project.is_dir() {
        return Err(format!("Project path does not exist: {}", project_path));
    }
    let canonical_project = canonicalize_path(project)
        .map_err(|e| format!("Invalid project path: {}", e))?;

    let db_path = canonical_project.join("dev.db");
    if !db_path.starts_with(&canonical_project) {
        return Err("Resolved dev.db path escapes project root".to_string());
    }
    if !db_path.exists() {
        return Err(format!(
            "No dev.db found at {}. Run a migration first.",
            db_path.display()
        ));
    }

    Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open dev.db: {}", e))
}

/// Gate every query on a leading `SELECT` (case-insensitive, comments stripped).
/// `PRAGMA table_info(...)` is also allowed since the viewer needs column metadata.
fn ensure_read_only_statement(sql: &str) -> Result<(), String> {
    let trimmed = strip_leading_comments(sql).trim_start();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("select") || lower.starts_with("pragma table_info") {
        return Ok(());
    }
    Err(format!(
        "Only SELECT and PRAGMA table_info(...) statements are allowed in the data viewer (got: {}...)",
        &sql[..sql.len().min(40)]
    ))
}

/// Strip leading `--` line comments and `/* ... */` block comments so the
/// SELECT-only gate cannot be bypassed by `/*x*/DROP …`.
fn strip_leading_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            if let Some(nl) = rest.find('\n') {
                s = rest[nl + 1..].trim_start();
                continue;
            }
            return "";
        }
        if let Some(rest) = s.strip_prefix("/*") {
            if let Some(end) = rest.find("*/") {
                s = rest[end + 2..].trim_start();
                continue;
            }
            return "";
        }
        break;
    }
    s
}

fn value_ref_to_cell(v: ValueRef) -> CellValue {
    match v {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(i) => CellValue::Integer(i),
        ValueRef::Real(f) => CellValue::Real(f),
        ValueRef::Text(bytes) => {
            CellValue::Text(String::from_utf8_lossy(bytes).into_owned())
        }
        ValueRef::Blob(bytes) => CellValue::Blob(BlobMarker {
            binary: bytes.len() as u64,
        }),
    }
}

/// Run a SELECT or PRAGMA table_info(...) against the project's dev.db.
///
/// Parameters are forwarded verbatim — the viewer is responsible for using
/// `?` placeholders for LIMIT/OFFSET. Table names cannot be parameterized in
/// SQLite, so the viewer must validate them against `^[A-Za-z_][A-Za-z0-9_]*$`
/// before composing the query (see PLAN-DATA-VIEWER.md §6).
#[tauri::command]
pub async fn data_viewer_dev_query(
    project_path: String,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<QueryResult, String> {
    ensure_read_only_statement(&sql)?;
    let conn = open_dev_db(&project_path)?;

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare statement: {}", e))?;

    let column_count = stmt.column_count();
    let columns: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("").to_string())
        .collect();

    let rusqlite_params: Vec<Box<dyn rusqlite::ToSql>> = params
        .into_iter()
        .map(|v| -> Box<dyn rusqlite::ToSql> {
            match v {
                serde_json::Value::Null => Box::new(rusqlite::types::Null),
                serde_json::Value::Bool(b) => Box::new(b),
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        Box::new(i)
                    } else if let Some(f) = n.as_f64() {
                        Box::new(f)
                    } else {
                        Box::new(n.to_string())
                    }
                }
                serde_json::Value::String(s) => Box::new(s),
                other => Box::new(other.to_string()),
            }
        })
        .collect();
    let param_refs: Vec<&dyn rusqlite::ToSql> =
        rusqlite_params.iter().map(|b| b.as_ref()).collect();

    let mut rows_iter = stmt
        .query(rusqlite::params_from_iter(param_refs.iter()))
        .map_err(|e| format!("Query failed: {}", e))?;

    let mut rows: Vec<Vec<CellValue>> = Vec::new();
    while let Some(row) = rows_iter
        .next()
        .map_err(|e| format!("Row read failed: {}", e))?
    {
        let mut cells: Vec<CellValue> = Vec::with_capacity(column_count);
        for i in 0..column_count {
            let v = row
                .get_ref(i)
                .map_err(|e| format!("Column read failed: {}", e))?;
            cells.push(value_ref_to_cell(v));
        }
        rows.push(cells);
    }

    Ok(QueryResult { columns, rows })
}
