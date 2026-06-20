//! GitHub OAuth Device Flow + access-token storage.
//!
//! Why this exists: cloning a PRIVATE github.com repo needs credentials, but
//! `git_clone_repository` runs git with `CREATE_NO_WINDOW` and no TTY, so
//! git's interactive credential prompt has nowhere to go and the process hangs
//! forever (the original "clone fica preso" bug on Windows). Rather than lean
//! on a system credential helper — which may itself pop a blocking GUI — the
//! IDE obtains its OWN GitHub token via the OAuth 2.0 Device Authorization
//! Grant and injects it into the clone.
//!
//! Device flow is the correct grant for a native/desktop app: it needs only a
//! PUBLIC `client_id` (no client secret), so nothing secret ships in the
//! binary. Flow (https://docs.github.com/apps/oauth/device-flow):
//!   1. POST /login/device/code        → user_code + verification_uri + device_code
//!   2. user opens verification_uri, types user_code, authorizes
//!   3. poll POST /login/oauth/access_token until it returns access_token
//!
//! The token is persisted through the BYOK durable keychain+file store (so we
//! inherit its macOS unsigned-dev-build fallback) under a reserved provider id,
//! and is read back by `git_clone_repository` and injected as a per-command
//! `http.extraHeader` so it NEVER lands in any cloned repo's `.git/config`.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use std::time::Duration;

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_USER_URL: &str = "https://api.github.com/user";

/// Reserved BYOK provider id for the GitHub OAuth token. The `__tm_` prefix
/// keeps it from ever colliding with a real AI-provider id (those are plain
/// names like "openai") and from surfacing in the BYOK settings UI, which only
/// ever queries known AI providers.
const TOKEN_PROVIDER: &str = "__tm_github_oauth";

/// `repo` scope grants read/write to private repositories (clone needs read).
const DEFAULT_SCOPE: &str = "repo";

/// GitHub's REST API requires a User-Agent on every request.
const USER_AGENT: &str = "TM-Code-IDE";

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("http client init failed: {e}"))
}

fn str_field(v: &serde_json::Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("GitHub response missing '{key}'"))
}

// ── token storage (reuses the BYOK durable keychain+file store) ──

/// Read the stored GitHub token, if any. `pub(crate)` so `git_clone_repository`
/// can inject it without the token ever crossing into the JS layer.
pub(crate) fn stored_token() -> Option<String> {
    super::byok::byok_get_key(TOKEN_PROVIDER.to_string())
        .ok()
        .flatten()
        .filter(|t| !t.trim().is_empty())
}

fn save_token(token: &str) -> Result<(), String> {
    super::byok::byok_set_key(TOKEN_PROVIDER.to_string(), token.to_string())
}

/// If `url` is an HTTPS github.com URL and we have a stored token, return the
/// value for a `http.extraHeader` Basic-auth header that authenticates the
/// clone. GitHub accepts any username with the token as the password; we use
/// the conventional `x-access-token`. Returns `None` for non-GitHub / SSH /
/// already-public cases — git handles those exactly as before.
pub(crate) fn clone_auth_header(url: &str) -> Option<String> {
    let lower = url.trim().to_ascii_lowercase();
    let is_github_https =
        lower.starts_with("https://github.com/") || lower.starts_with("https://www.github.com/");
    if !is_github_https {
        return None;
    }
    let token = stored_token()?;
    let basic = B64.encode(format!("x-access-token:{token}"));
    Some(format!("Authorization: Basic {basic}"))
}

// ── device-flow commands ──

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeResponse {
    pub user_code: String,
    pub device_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Step 1: request a device + user code. The frontend shows `user_code`, opens
/// `verification_uri` in the browser, then polls `github_device_poll` every
/// `interval` seconds until the user authorizes (or `expires_in` elapses).
#[tauri::command]
pub async fn github_device_start(
    client_id: String,
    scope: Option<String>,
) -> Result<DeviceCodeResponse, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("GitHub client_id is not configured (set VITE_GITHUB_CLIENT_ID)".into());
    }
    let scope = scope
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SCOPE.to_string());

    let resp = http_client()?
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", scope.as_str())])
        .send()
        .await
        .map_err(|e| format!("GitHub device-code request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub device-code error ({status}): {body}"));
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("invalid GitHub response: {e} — {body}"))?;
    // GitHub returns `error`/`error_description` with HTTP 200 for some failures
    // (e.g. a client_id whose OAuth app hasn't enabled device flow).
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        let desc = json
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or(err);
        return Err(format!("GitHub: {desc}"));
    }

    Ok(DeviceCodeResponse {
        user_code: str_field(&json, "user_code")?,
        device_code: str_field(&json, "device_code")?,
        verification_uri: str_field(&json, "verification_uri")?,
        expires_in: json
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(900),
        interval: json.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollResponse {
    /// "authorized" | "pending" | "slow_down" | "expired" | "denied" | "error"
    pub status: String,
    /// On "slow_down", GitHub's new minimum poll interval (seconds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Step 3: poll once for the access token. On success the token is persisted
/// (it NEVER crosses back to JS) and `status: "authorized"` is returned. The
/// frontend loops on this, honouring `interval`/`slow_down`, until terminal.
#[tauri::command]
pub async fn github_device_poll(
    client_id: String,
    device_code: String,
) -> Result<DevicePollResponse, String> {
    let client_id = client_id.trim();
    let device_code = device_code.trim();
    if client_id.is_empty() || device_code.is_empty() {
        return Err("client_id and device_code are required".into());
    }

    let resp = http_client()?
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("GitHub token poll failed: {e}"))?;

    let body = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("invalid GitHub response: {e} — {body}"))?;

    if let Some(token) = json.get("access_token").and_then(|v| v.as_str()) {
        save_token(token)?;
        return Ok(DevicePollResponse {
            status: "authorized".into(),
            interval: None,
            message: None,
        });
    }

    // Pending/terminal states are reported via `error` (with HTTP 200).
    let err = json
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("error");
    let status = match err {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" => "expired",
        "access_denied" => "denied",
        _ => "error",
    };
    let message = json
        .get("error_description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(DevicePollResponse {
        status: status.into(),
        interval: json.get("interval").and_then(|v| v.as_u64()),
        message,
    })
}

/// Whether a GitHub token is currently stored.
#[tauri::command]
pub fn github_token_status() -> Result<bool, String> {
    Ok(stored_token().is_some())
}

/// Forget the stored GitHub token ("Disconnect").
#[tauri::command]
pub fn github_disconnect() -> Result<(), String> {
    super::byok::byok_delete_key(TOKEN_PROVIDER.to_string())
}

/// Best-effort GitHub login for the connected token, for display only
/// ("Connected as @login"). Returns `None` when there is no token or the
/// request fails — callers fall back to a generic "connected" label.
#[tauri::command]
pub async fn github_account() -> Result<Option<String>, String> {
    let Some(token) = stored_token() else {
        return Ok(None);
    };
    let resp = http_client()?
        .get(API_USER_URL)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("GitHub user request failed: {e}"))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("GitHub user parse failed: {e}"))?;
    Ok(json
        .get("login")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string()))
}
