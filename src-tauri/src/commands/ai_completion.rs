use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Serialize)]
struct OllamaFimRequest {
    model: String,
    prompt: String,
    suffix: String,
    stream: bool,
    keep_alive: String,
    options: OllamaOptions,
}

#[derive(Serialize)]
struct OllamaOptions {
    temperature: f32,
    num_predict: u32,
    stop: Vec<String>,
}

#[derive(Deserialize)]
struct OllamaFimResponse {
    response: String,
}

pub struct FimState {
    current_task: Mutex<Option<tokio::task::AbortHandle>>,
}

impl FimState {
    pub fn new() -> Self {
        Self {
            current_task: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub async fn fim_completion(
    fim_state: tauri::State<'_, FimState>,
    http_client: tauri::State<'_, reqwest::Client>,
    ollama_url: String,
    model: String,
    prefix: String,
    suffix: String,
) -> Result<String, String> {
    // Abort any previous in-flight request — frees the GPU immediately
    if let Some(handle) = fim_state
        .current_task
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        handle.abort();
    }

    let client = http_client.inner().clone();
    let url = format!("{}/api/generate", ollama_url.trim_end_matches('/'));

    let body = OllamaFimRequest {
        model,
        prompt: prefix,
        suffix,
        stream: false,
        keep_alive: "30m".to_string(),
        options: OllamaOptions {
            temperature: 0.01,
            num_predict: 128,
            stop: vec!["\n\n\n".to_string()],
        },
    };

    let task = tokio::spawn(async move {
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Ollama request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Ollama error ({}): {}", status, text));
        }

        let data: OllamaFimResponse = resp
            .json()
            .await
            .map_err(|e| format!("Ollama parse error: {}", e))?;

        Ok(data.response)
    });

    // Store abort handle so next request can cancel this one
    *fim_state
        .current_task
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(task.abort_handle());

    match task.await {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => Err("cancelled".to_string()),
        Err(e) => Err(format!("FIM task failed: {}", e)),
    }
}
