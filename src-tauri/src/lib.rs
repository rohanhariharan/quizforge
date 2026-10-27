// QuizForge native layer.
//
// Deliberately small: the webview owns extraction, prompts, validation and the
// quiz itself. Rust only provides what a browser cannot do reliably —
// provider-agnostic HTTP with no CORS, and disk access for chooser-picked files.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use std::{fs, path::Path};

const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;
const HTTP_TIMEOUT_SECS: u64 = 600;
const OPENROUTER_DEFAULT: &str = "https://openrouter.ai/api/v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn default_kind() -> String {
    "openai".to_string()
}

#[derive(Clone, Debug, Deserialize)]
pub struct ImagePart {
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: ProviderConfig,
    pub system: String,
    pub user: String,
    #[serde(default)]
    pub images: Vec<ImagePart>,
}

#[derive(Debug, Serialize)]
pub struct ChatReply {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context: u64,
    pub prompt_price: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub ok: bool,
    pub label: String,
    pub usage: f64,
    pub limit: Option<f64>,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct FilePayload {
    pub name: String,
    pub size: u64,
    pub data: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("QuizForge/1.0")
        .build()
        .map_err(|e| format!("Could not start the HTTP client: {e}"))
}

fn endpoint(kind: &str, base: &str, route: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    match kind {
        "ollama" => {
            let base = if base.is_empty() { "http://localhost:11434" } else { base };
            format!("{base}/api/{route}")
        }
        "anthropic" => {
            let base = if base.is_empty() { "https://api.anthropic.com" } else { base };
            if base.ends_with("/v1") {
                format!("{base}/{route}")
            } else {
                format!("{base}/v1/{route}")
            }
        }
        _ => {
            let base = if base.is_empty() { OPENROUTER_DEFAULT } else { base };
            if base.contains("/v1") || base.ends_with("/openai") {
                format!("{base}/{route}")
            } else {
                format!("{base}/v1/{route}")
            }
        }
    }
}

fn tidied(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "the server sent an empty response".to_string();
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        for pointer in ["/error/message", "/error", "/message", "/detail"] {
            if let Some(s) = v.pointer(pointer).and_then(Value::as_str) {
                if !s.is_empty() {
                    return clip(s, 500);
                }
            }
        }
    }
    clip(trimmed, 500)
}

fn clip(s: &str, max: usize) -> String {
    let clean = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max {
        clean
    } else {
        let mut out: String = clean.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn text_from(kind: &str, v: &Value) -> String {
    match kind {
        "ollama" => v
            .pointer("/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "anthropic" => v
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        _ => {
            let content = &v["choices"][0]["message"]["content"];
            if let Some(s) = content.as_str() {
                s.to_string()
            } else if let Some(parts) = content.as_array() {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            } else {
                String::new()
            }
        }
    }
}

fn is_openrouter(url: &str) -> bool {
    url.to_ascii_lowercase().contains("openrouter.ai")
}

fn reasoning_model(model: &str) -> bool {
    let name = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .trim()
        .to_ascii_lowercase();
    name.starts_with("o1")
        || name.starts_with("o3")
        || name.starts_with("o4")
        || name.starts_with("gpt-5")
        || name.starts_with("gpt-6")
}

fn build_payload(
    request: &ChatRequest,
    provider: &ProviderConfig,
    max_tokens: u32,
    temperature: f64,
) -> (String, Value, &'static str) {
    let kind = provider.kind.as_str();
    match kind {
        "ollama" => {
            let mut user = json!({ "role": "user", "content": request.user });
            if !request.images.is_empty() {
                let images: Vec<String> = request.images.iter().map(|i| i.data.clone()).collect();
                user["images"] = json!(images);
            }
            let payload = json!({
                "model": provider.model,
                "stream": false,
                "format": "json",
                "messages": [
                    { "role": "system", "content": request.system },
                    user
                ],
                "options": { "temperature": temperature, "num_predict": max_tokens }
            });
            (endpoint(kind, &provider.base_url, "chat"), payload, "Ollama")
        }
        "anthropic" => {
            let mut content: Vec<Value> = request
                .images
                .iter()
                .map(|img| {
                    json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": img.mime, "data": img.data }
                    })
                })
                .collect();
            content.push(json!({ "type": "text", "text": request.user }));
            let payload = json!({
                "model": provider.model,
                "max_tokens": max_tokens,
                "temperature": temperature.min(1.0),
                "system": request.system,
                "messages": [{ "role": "user", "content": content }]
            });
            (endpoint(kind, &provider.base_url, "messages"), payload, "Anthropic")
        }
        _ => {
            let user_content = if request.images.is_empty() {
                json!(request.user)
            } else {
                let mut parts: Vec<Value> = request
                    .images
                    .iter()
                    .map(|img| {
                        json!({
                            "type": "image_url",
                            "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data) }
                        })
                    })
                    .collect();
                parts.push(json!({ "type": "text", "text": request.user }));
                json!(parts)
            };
            let mut payload = json!({
                "model": provider.model,
                "stream": false,
                "max_tokens": max_tokens,
                "messages": [
                    { "role": "system", "content": request.system },
                    { "role": "user", "content": user_content }
                ]
            });
            if !reasoning_model(&provider.model) {
                payload["temperature"] = json!(temperature);
            }
            (endpoint(kind, &provider.base_url, "chat/completions"), payload, "OpenRouter")
        }
    }
}

fn affordable_tokens(body: &str) -> Option<u32> {
    let marker = "can only afford ";
    let start = body.find(marker)? + marker.len();
    let digits: String = body[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

#[tauri::command]
async fn chat_completion(request: ChatRequest) -> Result<ChatReply, String> {
    let provider = request.provider.clone();
    let kind = provider.kind.as_str();

    if provider.model.trim().is_empty() {
        return Err("No model is selected. Open Settings and choose an OpenRouter model.".into());
    }

    if kind != "ollama" {
        let key = provider.api_key.clone().unwrap_or_default();
        if key.trim().is_empty() {
            return Err(if kind == "anthropic" {
                "An API key is required. Add one in Settings.".to_string()
            } else {
                "Add your OpenRouter API key in Settings first.".to_string()
            });
        }
    }

    let temperature = provider.temperature.unwrap_or(0.7).clamp(0.0, 1.5);
    let mut max_tokens = provider.max_tokens.unwrap_or(6000).clamp(256, 32_000);
    let http = client()?;
    let mut last_error = String::new();

    for attempt in 0..2 {
        let (url, payload, label) = build_payload(&request, &provider, max_tokens, temperature);

        let mut req = http.post(&url).json(&payload);
        if kind == "anthropic" {
            let key = provider.api_key.clone().unwrap_or_default();
            req = req
                .header("x-api-key", key.trim())
                .header("anthropic-version", "2023-06-01");
        } else if kind != "ollama" {
            let key = provider.api_key.clone().unwrap_or_default();
            req = req.bearer_auth(key.trim());
            if is_openrouter(&url) {
                req = req
                    .header("HTTP-Referer", "https://quizforge.app")
                    .header("X-Title", "QuizForge");
            }
        }

        let res = req
            .send()
            .await
            .map_err(|e| format!("Could not reach {label}: {e}"))?;
        let status = res.status();
        let body = res
            .text()
            .await
            .map_err(|e| format!("Could not read the response from {label}: {e}"))?;

        if !status.is_success() {
            last_error = format!(
                "{label} returned HTTP {}. {}{}",
                status.as_u16(),
                tidied(&body),
                match status.as_u16() {
                    401 => " Check the key in Settings.",
                    402 => " Add credits at openrouter.ai/settings/credits, or choose a cheaper model.",
                    429 => " Too many requests — wait a moment and try again.",
                    _ => "",
                }
            );

            // OpenRouter rejects the request up front when max_tokens costs more
            // than the remaining balance. Retry once with what the account can
            // actually afford instead of failing the whole quiz.
            if status.as_u16() == 402 && attempt == 0 {
                if let Some(affordable) = affordable_tokens(&body) {
                    let next = affordable.saturating_sub(64).max(512);
                    if next < max_tokens {
                        max_tokens = next;
                        continue;
                    }
                }
            }
            return Err(last_error);
        }

        let parsed: Value = serde_json::from_str(&body)
            .map_err(|_| format!("{label} sent something that was not JSON: {}", tidied(&body)))?;
        let text = text_from(kind, &parsed);
        if text.trim().is_empty() {
            return Err(format!("{label} returned an empty response."));
        }
        return Ok(ChatReply { text });
    }

    Err(last_error)
}

#[tauri::command]
async fn list_models() -> Result<Vec<ModelInfo>, String> {
    let url = endpoint("openai", OPENROUTER_DEFAULT, "models");
    let http = client()?;
    let res = http
        .get(&url)
        .header("X-Title", "QuizForge")
        .send()
        .await
        .map_err(|e| format!("Could not load the OpenRouter catalogue: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Model list failed (HTTP {}): {}", status.as_u16(), tidied(&body)));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|_| format!("Unexpected model list: {}", tidied(&body)))?;
    let mut models: Vec<ModelInfo> = v["data"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?.to_string();
                    let name = m
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_string();
                    let context = m.get("context_length").and_then(Value::as_u64).unwrap_or(0);
                    let prompt_price = m
                        .pointer("/pricing/prompt")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    Some(ModelInfo { id, name, context, prompt_price: prompt_price.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

#[tauri::command]
async fn verify_openrouter(api_key: String) -> Result<KeyInfo, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Ok(KeyInfo {
            ok: false,
            label: String::new(),
            usage: 0.0,
            limit: None,
            detail: "Enter an OpenRouter API key.".into(),
        });
    }
    let url = endpoint("openai", OPENROUTER_DEFAULT, "key");
    let http = client()?;
    let res = http
        .get(&url)
        .bearer_auth(key)
        .header("X-Title", "QuizForge")
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(KeyInfo {
            ok: false,
            label: String::new(),
            usage: 0.0,
            limit: None,
            detail: "OpenRouter rejected that key.".into(),
        });
    }
    if !status.is_success() {
        return Ok(KeyInfo {
            ok: false,
            label: String::new(),
            usage: 0.0,
            limit: None,
            detail: format!("OpenRouter returned HTTP {}: {}", status.as_u16(), tidied(&body)),
        });
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    let data = v.get("data").cloned().unwrap_or(v);
    let label = data.get("label").and_then(Value::as_str).unwrap_or("OpenRouter key").to_string();
    let usage = data.get("usage").and_then(Value::as_f64).unwrap_or(0.0);
    let limit = data.get("limit").and_then(Value::as_f64);
    Ok(KeyInfo {
        ok: true,
        label,
        usage,
        limit,
        detail: "Connected to OpenRouter.".into(),
    })
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<FilePayload, String> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| format!("Could not open {path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} is a folder, not a file."));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{} is {} MB. The limit is 40 MB.",
            p.file_name().and_then(|n| n.to_str()).unwrap_or("That file"),
            meta.len() / (1024 * 1024)
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("Could not read {path}: {e}"))?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();
    Ok(FilePayload {
        name,
        size: bytes.len() as u64,
        data: B64.encode(bytes),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            chat_completion,
            list_models,
            verify_openrouter,
            read_file_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuizForge");
}
