//! BYOK (Bring Your Own Key) keychain commands.
//!
//! Stores per-provider API keys with two strategies:
//!   1. **OS keychain** (preferred) — macOS Security framework, Windows
//!      Credential Manager, Linux libsecret. Real OS-level protection.
//!   2. **Encrypted file fallback** — when keychain isn't available
//!      (unsigned dev builds where macOS silently rejects writes, Linux
//!      without libsecret running). XOR obfuscation with a machine-UID-
//!      derived keystream + Unix mode 0600 on the file. NOT real crypto;
//!      just enough to defeat opportunistic file scanners and to make the
//!      key non-trivial to read with `cat`.
//!
//! The fallback is automatic — `byok_set_key` writes to keychain first and
//! verifies with `get_password`. If verify fails (key didn't actually
//! persist, classic dev-build symptom on macOS), it falls back to the file.
//! `byok_get_key` and `byok_has_key` check keychain first, then file.
//!
//! Keys NEVER appear in Zustand state, localStorage, or any persisted IDE
//! config — only metadata ("provider X has a key set") lives in byokStore.
//! `byok_get_key` is called from agentService just-in-time when building a
//! chat request; the key never sits in renderer-process memory longer than
//! the duration of one fetch.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use keyring::Entry;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::error::Error as StdError;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

const KEYRING_SERVICE: &str = "tm-code-byok";

/// Abort registry for BYOK direct streaming (`byok_chat_stream`). Maps a
/// `request_id` → a oneshot sender; `byok_chat_abort` fires it so the agent's
/// Stop button truly cancels the in-flight reqwest stream. Without it the JS
/// transport unsubscribes from the events but the Rust task keeps draining the
/// user's provider for up to the 5-min timeout — real money on a BYOK key.
#[derive(Default)]
pub struct ByokStreamRegistry(pub Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>);

fn redacted_reqwest_url(url: &reqwest::Url) -> String {
    let mut out = format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or("<missing-host>")
    );
    if let Some(port) = url.port() {
        out.push_str(&format!(":{port}"));
    }
    out.push_str(url.path());
    out
}

fn format_reqwest_request_error(err: &reqwest::Error) -> String {
    let mut tags = Vec::new();
    if err.is_timeout() {
        tags.push("timeout");
    }
    if err.is_connect() {
        tags.push("connect");
    }
    if err.is_request() {
        tags.push("request");
    }
    if err.is_body() {
        tags.push("body");
    }
    if err.is_decode() {
        tags.push("decode");
    }

    let mut details = Vec::new();
    if !tags.is_empty() {
        details.push(format!("kind={}", tags.join(",")));
    }
    if let Some(status) = err.status() {
        details.push(format!("status={status}"));
    }
    if let Some(url) = err.url() {
        details.push(format!("url={}", redacted_reqwest_url(url)));
    }

    let mut causes = Vec::new();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !causes.iter().any(|existing| existing == &text) {
            causes.push(text);
        }
        if causes.len() >= 6 {
            break;
        }
        source = cause.source();
    }

    let mut msg = format!("request failed: {err}");
    if !details.is_empty() {
        msg.push_str(&format!(" ({})", details.join(", ")));
    }
    if !causes.is_empty() {
        msg.push_str(&format!("; cause chain: {}", causes.join(" → ")));
    }
    msg
}

/// Decodifica bytes de stream SSE preservando um sufixo UTF-8 incompleto
/// entre chunks TCP. O decode per-chunk com `from_utf8_lossy` transformava um
/// codepoint multi-byte partido na fronteira em U+FFFD IRRECUPERÁVEL (o JS
/// re-encoda a string) — impacto desproporcional em providers com output CJK
/// (Qwen/DashScope, Kimi, MiMo) e em emoji/acentuação (auditoria BYOK 05-08).
/// `pending` guarda o sufixo por decodificar; no fim do stream, o que restar
/// deve ser drenado com `flush_utf8`.
fn drain_utf8(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            // Sufixo incompleto (fronteira de chunk): decodifica o prefixo
            // válido e retém o resto para o próximo chunk.
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            let tail = pending.split_off(valid);
            *pending = tail;
            out
        }
        Err(e) => {
            // Byte genuinamente inválido a meio. Faz-se lossy SÓ até ao fim da
            // sequência inválida e RETÉM-SE o resto: descartar o buffer todo
            // levava à frente um prefixo válido do codepoint seguinte, que no
            // chunk seguinte ficava órfão — um stray byte corrompia DOIS
            // caracteres em vez de um (auditoria 05-08).
            let bad_end = e.valid_up_to() + e.error_len().unwrap_or(1);
            let cut = bad_end.min(pending.len());
            let out = String::from_utf8_lossy(&pending[..cut]).into_owned();
            let tail = pending.split_off(cut);
            *pending = tail;
            out
        }
    }
}

/// Drena o que restar em `pending` no fim do stream (stream cortado a meio de
/// um codepoint) — lossy, porque já não vem mais nada.
fn flush_utf8(pending: &mut Vec<u8>) -> String {
    if pending.is_empty() {
        return String::new();
    }
    let out = String::from_utf8_lossy(pending).into_owned();
    pending.clear();
    out
}

fn is_unsafe_transport_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length"
            | "transfer-encoding"
            | "connection"
            | "host"
            | "expect"
            | "te"
            | "trailer"
            | "upgrade"
    )
}

fn entry_for(provider: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, provider).map_err(|e| format!("keyring init failed: {e}"))
}

// ── File fallback ──

fn fallback_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "platform data_dir unavailable".to_string())?;
    let dir = base.join("toquemedia-studio").join("byok");
    fs::create_dir_all(&dir).map_err(|e| format!("byok dir create failed: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }

    Ok(dir)
}

fn fallback_path(provider: &str) -> Result<PathBuf, String> {
    Ok(fallback_dir()?.join(format!("{provider}.key")))
}

/// XOR obfuscate (symmetric — same call decrypts) with a keystream derived
/// from the machine UID and provider id. Not real crypto; defeats casual
/// scanners. The file is also chmod 0600 so other users on the machine
/// can't read it.
fn xor_obfuscate(data: &[u8], provider: &str) -> Vec<u8> {
    let machine = machine_uid::get().unwrap_or_else(|_| "no-machine-uid".to_string());
    let mut hasher = Sha256::new();
    hasher.update(format!("byok-fallback-v1|{machine}|{provider}").as_bytes());
    let mut keystream = hasher.finalize().to_vec();

    while keystream.len() < data.len() {
        let mut h = Sha256::new();
        h.update(&keystream);
        keystream.extend_from_slice(&h.finalize());
    }

    data.iter()
        .zip(keystream.iter())
        .map(|(b, k)| b ^ k)
        .collect()
}

fn write_fallback(provider: &str, key: &str) -> Result<(), String> {
    let path = fallback_path(provider)?;
    let obfuscated = xor_obfuscate(key.as_bytes(), provider);
    let encoded = B64.encode(&obfuscated);

    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }

    let mut file = opts
        .open(&path)
        .map_err(|e| format!("fallback open failed: {e}"))?;
    file.write_all(encoded.as_bytes())
        .map_err(|e| format!("fallback write failed: {e}"))?;
    Ok(())
}

fn read_fallback(provider: &str) -> Result<Option<String>, String> {
    let path = fallback_path(provider)?;
    if !path.exists() {
        return Ok(None);
    }
    let encoded = fs::read_to_string(&path).map_err(|e| format!("fallback read failed: {e}"))?;
    let obfuscated = B64
        .decode(encoded.trim())
        .map_err(|e| format!("fallback decode failed: {e}"))?;
    let plain = xor_obfuscate(&obfuscated, provider);
    let key = String::from_utf8(plain).map_err(|e| format!("fallback utf8: {e}"))?;
    Ok(Some(key))
}

fn delete_fallback(provider: &str) -> Result<(), String> {
    let path = fallback_path(provider)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("fallback delete failed: {e}"))?;
    }
    Ok(())
}

// ── Tauri commands ──

#[tauri::command]
pub fn byok_set_key(provider: String, key: String) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }
    if key.is_empty() {
        return Err("key is required".into());
    }

    // Write to BOTH stores. The macOS keychain in unsigned dev builds will
    // sometimes accept set_password and even pass an immediate verify, but
    // then drop the entry between sessions. If we relied on the keychain
    // alone (or — worse — deleted the file fallback after a keychain
    // success), the next byok_has_key call would return false and the IDE
    // would flip `hasKey` to false on every window-restore refresh.
    //
    // Treating the file as the durable source of truth and the keychain as
    // a faster-path cache eliminates that drift entirely.
    let keychain_state: &str = if let Ok(entry) = entry_for(&provider) {
        match entry.set_password(&key) {
            Ok(()) => match entry.get_password() {
                Ok(stored) if stored == key => "ok",
                Ok(_) => "set-but-readback-mismatch",
                Err(_) => "set-but-readback-noentry",
            },
            Err(e) => {
                eprintln!("[byok] keychain set failed for {provider}: {e}");
                "set-failed"
            }
        }
    } else {
        "init-failed"
    };

    // Always write the file fallback — durable source of truth.
    write_fallback(&provider, &key)?;
    eprintln!("[byok] set_key({provider}) -> keychain={keychain_state}, file=ok");
    Ok(())
}

#[tauri::command]
pub fn byok_get_key(provider: String) -> Result<Option<String>, String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }

    if let Ok(entry) = entry_for(&provider) {
        match entry.get_password() {
            Ok(pw) => return Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => { /* fall through to file */ }
            Err(_) => { /* keychain error — try file before failing */ }
        }
    }

    read_fallback(&provider)
}

#[tauri::command]
pub fn byok_delete_key(provider: String) -> Result<(), String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }

    // Best-effort delete from BOTH stores. If either succeeds, treat as ok.
    let mut keychain_err: Option<String> = None;
    if let Ok(entry) = entry_for(&provider) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => keychain_err = Some(format!("keyring delete failed: {e}")),
        }
    }

    let file_err = delete_fallback(&provider).err();

    match (keychain_err, file_err) {
        (None, None) => Ok(()),
        // Both failed — surface the keychain error first
        (Some(k), Some(_)) => Err(k),
        (Some(k), None) => Err(k),
        (None, Some(f)) => Err(f),
    }
}

// ── Local provider streaming (Ollama, LM Studio) ──
//
// The cloud BYOK path goes through the worker proxy, which injects the user's
// key and converts SSE shapes. Local providers can't go through the worker
// (proxy.ts:1111 refuses local URLs) AND running directly from the WebView
// hits CORS — `localhost:14300` (WebView origin) → `localhost:11434` (Ollama)
// is cross-origin and Ollama 403s by default unless OLLAMA_ORIGINS is set.
//
// This command opens the streaming HTTP request from Rust (no CORS) and
// emits chunks as Tauri events scoped to a caller-supplied request_id. The
// JS bridge listens for `byok-stream-{request_id}` events with shape:
//
//   { "type": "chunk", "data": "..." }   — raw bytes (UTF-8) from upstream
//   { "type": "done" }                    — stream completed normally
//   { "type": "error", "error": "..." }   — request or stream failed
//   { "type": "http_error", "status": N, "body": "..." }
//                                          — HTTP non-2xx; body included
//
// The data text is whatever the upstream sent — typically OpenAI-shape SSE
// (`data: {…}\n\n`). The JS side reassembles and parses.
//
// Restricted to localhost to avoid being repurposed as a generic HTTP egress.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatStreamInput {
    pub request_id: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// SEM CHAMADOR NO FRONTEND (verificado 2026-08-05): `byokTransport.ts` invoca
/// apenas `byok_chat_stream`/`byok_chat_abort`, e o caminho local passa pelo
/// mesmo comando (o guard de egress já permite localhost). Fica registado no
/// `lib.rs` e na allow-list, portanto continua invocável — mas note-se que,
/// ao contrário do `byok_chat_stream`, este NÃO tem entrada no
/// `ByokStreamRegistry` nem `tokio::select!` de abort: um upstream local
/// pendurado prende a task até ao timeout total. Antes de lhe dar um
/// chamador, dar-lhe primeiro o registry.
#[tauri::command]
pub async fn byok_local_chat_stream(
    app: AppHandle,
    input: LocalChatStreamInput,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&input.url).map_err(|e| format!("invalid url: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?;
    if !matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "::1") {
        return Err(format!(
            "byok_local_chat_stream is restricted to localhost; got '{host}'"
        ));
    }

    let client = reqwest::Client::builder()
        // Teto TOTAL do pedido (inclui ler o corpo em streaming): 300s cortava
        // turnos legítimos de raciocínio profundo / modelos locais em CPU a
        // meio, em ciclo de corte-e-retoma (auditoria BYOK 05-08). 30 min dá
        // folga real; o connect_timeout curto continua a apanhar hosts mortos.
        .timeout(Duration::from_secs(1800))
        .connect_timeout(Duration::from_secs(20))
        .http1_only()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("client init failed: {e}"))?;

    let event_name = format!("byok-stream-{}", input.request_id);
    let mut req = client
        .post(parsed)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .body(input.body);
    for (k, v) in input.headers.iter() {
        if is_unsafe_transport_header(k) {
            continue;
        }
        req = req.header(k, v);
    }

    tokio::spawn(async move {
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    &event_name,
                    serde_json::json!({
                        "type": "error",
                        "error": format_reqwest_request_error(&e),
                    }),
                );
                return;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let _ = app.emit(
                &event_name,
                serde_json::json!({
                    "type": "http_error",
                    "status": status.as_u16(),
                    "body": body,
                }),
            );
            return;
        }

        let mut stream = resp.bytes_stream();
        let mut utf8_pending: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    // Fronteiras de chunk podem partir um codepoint multi-byte
                    // — drain_utf8 retém o sufixo incompleto para o chunk
                    // seguinte em vez de o U+FFFD'ar (ver o helper).
                    let text = drain_utf8(&mut utf8_pending, &bytes);
                    if text.is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        &event_name,
                        serde_json::json!({
                            "type": "chunk",
                            "data": text,
                        }),
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        &event_name,
                        serde_json::json!({
                            "type": "error",
                            "error": format!("stream error: {e}"),
                        }),
                    );
                    return;
                }
            }
        }

        let tail = flush_utf8(&mut utf8_pending);
        if !tail.is_empty() {
            let _ = app.emit(
                &event_name,
                serde_json::json!({ "type": "chunk", "data": tail }),
            );
        }
        let _ = app.emit(
            &event_name,
            serde_json::json!({
                "type": "done",
            }),
        );
    });

    Ok(())
}

// ── BYOK direct streaming (cloud + local) ──
//
// The agentic BYOK path is IDE → SDK → provider DIRECT (never the TM worker).
// Cloud providers (Anthropic / Google / DashScope) block browser `fetch` from
// the WebView origin (CORS), so the streaming POST is opened here in Rust
// (no CORS) and chunks are relayed as Tauri events, exactly like
// `byok_local_chat_stream`. Same event protocol:
//
//   { "type": "chunk", "data": "..." }   — raw UTF-8 bytes from upstream
//   { "type": "done" }                    — stream completed normally
//   { "type": "error", "error": "..." }   — request or stream failed
//   { "type": "http_error", "status": N, "body": "..." }  — HTTP non-2xx
//
// Egress guard: this is NOT a generic HTTP egress. It only allows (a) localhost
// (local providers) or (b) https to EXACTLY the `expected_host` the IDE derived
// from the active provider's baseURL. The JS transport (byokTransport.ts) sets
// all auth headers per provider+shape; we forward them verbatim.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamInput {
    pub request_id: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: String,
    /// Host the IDE expects to talk to (from the provider's baseURL). The
    /// request URL's host must equal this for any non-localhost target.
    pub expected_host: String,
}

#[tauri::command]
pub async fn byok_chat_stream(
    app: AppHandle,
    registry: State<'_, ByokStreamRegistry>,
    input: ChatStreamInput,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&input.url).map_err(|e| format!("invalid url: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?
        .to_string();
    let scheme = parsed.scheme().to_string();
    let is_local = matches!(host.as_str(), "localhost" | "127.0.0.1" | "0.0.0.0" | "::1");

    // Egress guard. Localhost OR https to exactly the configured provider host.
    let allowed = is_local || (scheme == "https" && host == input.expected_host);
    if !allowed {
        return Err(format!(
            "byok_chat_stream: refused egress to '{host}' (scheme={scheme}, expected_host={})",
            input.expected_host
        ));
    }

    // Runtime evidence: this request goes straight to the user's provider with
    // their own key — the TM data-plane worker is bypassed entirely, so no TM
    // metering runs. (We log host + path only; never the key.)
    let has_auth = input
        .headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("authorization") || k.eq_ignore_ascii_case("x-api-key"));
    eprintln!(
        "[byok] direct → POST {host}{} (TM worker bypassed; user_key={})",
        parsed.path(),
        if has_auth { "present" } else { "none(local)" }
    );

    let mut builder = reqwest::Client::builder()
        // 300s → 1800s: ver o comentário no builder local (mesmo racional).
        .timeout(Duration::from_secs(1800))
        .connect_timeout(Duration::from_secs(20))
        .http1_only();
    if is_local {
        // Self-signed local gateways (rare) — accept invalid certs only for
        // localhost, NEVER for cloud.
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder
        .build()
        .map_err(|e| format!("client init failed: {e}"))?;

    let event_name = format!("byok-stream-{}", input.request_id);
    let mut req = client.post(parsed).body(input.body);

    // Forward caller headers verbatim — Authorization / x-api-key /
    // anthropic-version / Content-Type / Accept are all decided JS-side per
    // provider + apiShape. Only default the two transport headers when absent.
    let mut has_content_type = false;
    let mut has_accept = false;
    for (k, v) in input.headers.iter() {
        if is_unsafe_transport_header(k) {
            continue;
        }
        if k.eq_ignore_ascii_case("content-type") {
            has_content_type = true;
        }
        if k.eq_ignore_ascii_case("accept") {
            has_accept = true;
        }
        req = req.header(k, v);
    }
    if !has_content_type {
        req = req.header("Content-Type", "application/json");
    }
    if !has_accept {
        req = req.header("Accept", "text/event-stream");
    }

    // Register the abort channel BEFORE spawning so a near-instant abort can't
    // race the insert.
    let (abort_tx, mut abort_rx) = oneshot::channel::<()>();
    registry
        .0
        .lock()
        .unwrap()
        .insert(input.request_id.clone(), abort_tx);
    let registry_arc = registry.0.clone();
    let request_id = input.request_id.clone();

    tokio::spawn(async move {
        let cleanup = |reg: &Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>| {
            reg.lock().unwrap().remove(&request_id);
        };

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit(
                    &event_name,
                    serde_json::json!({ "type": "error", "error": format_reqwest_request_error(&e) }),
                );
                cleanup(&registry_arc);
                return;
            }
        };

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let _ = app.emit(
                &event_name,
                serde_json::json!({ "type": "http_error", "status": status.as_u16(), "body": body }),
            );
            cleanup(&registry_arc);
            return;
        }

        let mut stream = resp.bytes_stream();
        let mut utf8_pending: Vec<u8> = Vec::new();
        loop {
            tokio::select! {
                // Stop button (JS aborted) — drop the stream, emit nothing more.
                _ = &mut abort_rx => break,
                maybe = stream.next() => match maybe {
                    Some(Ok(bytes)) => {
                        // Codepoint partido na fronteira do chunk → drain_utf8
                        // retém o sufixo em vez de U+FFFD (ver o helper).
                        let text = drain_utf8(&mut utf8_pending, &bytes);
                        if text.is_empty() {
                            continue;
                        }
                        let _ = app.emit(
                            &event_name,
                            serde_json::json!({ "type": "chunk", "data": text }),
                        );
                    }
                    Some(Err(e)) => {
                        let _ = app.emit(
                            &event_name,
                            serde_json::json!({ "type": "error", "error": format!("stream error: {e}") }),
                        );
                        break;
                    }
                    None => {
                        let tail = flush_utf8(&mut utf8_pending);
                        if !tail.is_empty() {
                            let _ = app.emit(&event_name, serde_json::json!({ "type": "chunk", "data": tail }));
                        }
                        let _ = app.emit(&event_name, serde_json::json!({ "type": "done" }));
                        break;
                    }
                },
            }
        }
        cleanup(&registry_arc);
    });

    Ok(())
}

#[tauri::command]
pub fn byok_chat_abort(
    registry: State<'_, ByokStreamRegistry>,
    request_id: String,
) -> Result<(), String> {
    if let Some(tx) = registry.0.lock().unwrap().remove(&request_id) {
        // Receiver in the spawned task's select! wakes and breaks the loop.
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub fn byok_has_key(provider: String) -> Result<bool, String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }

    if let Ok(entry) = entry_for(&provider) {
        match entry.get_password() {
            Ok(_) => {
                eprintln!("[byok] has_key({provider}) -> true (keychain)");
                return Ok(true);
            }
            Err(keyring::Error::NoEntry) => { /* fall through */ }
            Err(e) => {
                eprintln!("[byok] has_key({provider}) keychain error: {e} — checking file");
            }
        }
    }

    let path = fallback_path(&provider)?;
    let exists = path.exists();
    eprintln!(
        "[byok] has_key({provider}) -> {exists} (file at {})",
        path.display()
    );
    Ok(exists)
}
