use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestInput {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseOutput {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub duration_ms: u64,
    pub size_bytes: u64,
}

/// Proxy HTTP requests from the frontend — bypasses CORS like Postman.
/// Each request creates its own client with configurable timeout and
/// accepts self-signed certificates for local dev servers.
#[tauri::command]
pub async fn http_client_request(input: HttpRequestInput) -> Result<HttpResponseOutput, String> {
    let timeout = input.timeout_secs.unwrap_or(30);

    // Only accept invalid certs for localhost dev servers (self-signed).
    // Remote URLs must have valid TLS certificates.
    let is_localhost = reqwest::Url::parse(&input.url)
        .map(|u| {
            matches!(
                u.host_str(),
                Some("localhost" | "127.0.0.1" | "0.0.0.0" | "::1")
            )
        })
        .unwrap_or(false);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .danger_accept_invalid_certs(is_localhost)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("TM-Code-HttpClient/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let method = match input.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => reqwest::Method::from_bytes(other.as_bytes())
            .map_err(|_| format!("Invalid HTTP method: {}", other))?,
    };

    guard_ssrf(&input.url)?;

    let mut req = client.request(method, &input.url);

    for (k, v) in &input.headers {
        req = req.header(k.as_str(), v.as_str());
    }

    if let Some(ref body) = input.body {
        req = req.body(body.clone());
    }

    let start = Instant::now();

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("Request timed out after {}s", timeout)
        } else if e.is_connect() {
            format!("Connection failed: {}", e)
        } else {
            format!("Request failed: {}", e)
        }
    })?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let status = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or("Unknown")
        .to_string();

    // Collect headers as Vec of tuples — preserves duplicate keys (e.g. Set-Cookie)
    let mut resp_headers: Vec<(String, String)> = Vec::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            resp_headers.push((k.to_string(), s.to_string()));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;
    let size_bytes = bytes.len() as u64;
    let body = String::from_utf8_lossy(&bytes).to_string();

    Ok(HttpResponseOutput {
        status,
        status_text,
        headers: resp_headers,
        body,
        duration_ms,
        size_bytes,
    })
}

/// Guarda SSRF partilhada por TODOS os caminhos de rede do agente.
///
/// Extraída de dentro do `http_client_request` quando o `fetch_pdf_text` foi
/// acrescentado: duplicá-la teria criado um segundo caminho de rede sem as
/// mesmas protecções, que é exactamente como um bypass nasce.
fn guard_ssrf(raw_url: &str) -> Result<(), String> {
    let url = match reqwest::Url::parse(raw_url) {
        Ok(u) => u,
        Err(_) => return Ok(()),
    };
    let Some(host) = url.host_str() else {
        return Ok(());
    };
    // Block link-local metadata (AWS/GCP/Azure)
    if host == "169.254.169.254" || host == "metadata.google.internal" {
        return Err("Blocked: cloud metadata endpoint".to_string());
    }
    // Block non-routable/internal ranges (except localhost for dev servers)
    if let Ok(ip) = host.parse::<IpAddr>() {
        let blocked = match ip {
            IpAddr::V4(v4) => {
                v4.is_link_local()           // 169.254.x.x
                || v4.is_broadcast()         // 255.255.255.255
                || v4.octets()[0] == 0 // 0.x.x.x
            }
            IpAddr::V6(v6) => v6.is_loopback() && host != "::1",
        };
        if blocked {
            return Err(format!("Blocked: request to internal address {}", host));
        }
    }
    Ok(())
}

/// Descarrega um PDF e devolve a sua camada de TEXTO.
///
/// Existe porque o agente recebia os bytes crus de um PDF colado pelo
/// developer (`%PDF-1.7` + streams FlateDecode) e não conseguia ler nada — o
/// texto de um PDF vive comprimido. Nunca devolve bytes: ou texto, ou um erro
/// que explica porquê (um PDF digitalizado não tem camada de texto).
#[tauri::command]
pub async fn fetch_pdf_text(url: String, timeout_secs: Option<u64>) -> Result<String, String> {
    guard_ssrf(&url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs.unwrap_or(60)))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    const MAX_PDF_BYTES: u64 = 40 * 1024 * 1024;
    // Recusar ANTES de descarregar quando o servidor declara o tamanho: puxar
    // 500 MB para depois dizer "grande demais" gasta a rede do developer para
    // chegar à mesma conclusão.
    if let Some(len) = resp.content_length() {
        if len > MAX_PDF_BYTES {
            return Err(format!(
                "PDF too large ({:.1} MB, cap {} MB) — not downloaded.",
                len as f64 / (1024.0 * 1024.0),
                MAX_PDF_BYTES / (1024 * 1024)
            ));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Could not read response body: {e}"))?;
    // Segunda verificação: sem `content-length` (chunked) só se sabe no fim.
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(format!(
            "PDF too large ({:.1} MB)",
            bytes.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    let text = tokio::task::spawn_blocking(move || pdf_extract::extract_text_from_mem(&bytes))
        .await
        .map_err(|e| format!("PDF task failed: {e}"))?
        .map_err(|e| format!("Could not extract text: {e}"))?;
    if text.trim().is_empty() {
        return Err(
            "This PDF has no extractable text layer (likely scanned or image-only).".to_string(),
        );
    }
    Ok(text)
}
