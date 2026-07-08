use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

pub struct SidecarState {
    stdin: Mutex<Option<ChildStdin>>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
        }
    }
}

/// State for the new agent runtime process (owns SQLite, serves the typed
/// command/query/event protocol). Runs alongside the legacy sidecar during the
/// strangler transition.
pub struct RuntimeState {
    stdin: Mutex<Option<ChildStdin>>,
}

impl RuntimeState {
    pub fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct SendRequest<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a str,
    #[serde(rename = "conversationId")]
    conversation_id: &'a str,
    #[serde(rename = "companyId")]
    company_id: Option<&'a str>,
    provider: Option<&'a str>,
    model: &'a str,
    effort: &'a str,
    #[serde(rename = "systemPrompt")]
    system_prompt: &'a str,
    prompt: &'a str,
    #[serde(rename = "resumeSessionId")]
    resume_session_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
struct CountTokensRequest<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a str,
    provider: Option<&'a str>,
    model: &'a str,
    #[serde(rename = "systemPrompt")]
    system_prompt: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct CheckRelevanceRequest<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a str,
    #[serde(rename = "employeeContext")]
    employee_context: &'a str,
    #[serde(rename = "channelName")]
    channel_name: &'a str,
    #[serde(rename = "triggerMessage")]
    trigger_message: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadRef {
    pub id: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionTarget {
    pub id: String,
    pub author: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
struct SendChannelRequest<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a str,
    #[serde(rename = "companyId")]
    company_id: Option<&'a str>,
    provider: Option<&'a str>,
    model: &'a str,
    effort: &'a str,
    #[serde(rename = "systemPrompt")]
    system_prompt: &'a str,
    prompt: &'a str,
    #[serde(rename = "resumeSessionId")]
    resume_session_id: Option<&'a str>,
    #[serde(rename = "openThreads")]
    open_threads: &'a [ThreadRef],
    #[serde(rename = "reactionTargets")]
    reaction_targets: &'a [ReactionTarget],
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SidecarEvent {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "delta")]
    Delta { id: String, text: String },
    #[serde(rename = "done")]
    Done {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        success: bool,
        usage: Usage,
        #[serde(rename = "totalCostUsd")]
        total_cost_usd: f64,
    },
    #[serde(rename = "error")]
    Error { id: String, message: String },
    #[serde(rename = "token_count")]
    TokenCount { id: String, tokens: i64, exact: bool },
    #[serde(rename = "relevance_result")]
    RelevanceResult {
        id: String,
        respond: bool,
        reason: String,
    },
    #[serde(rename = "channel_result")]
    ChannelResult {
        id: String,
        #[serde(rename = "respondsWithText")]
        responds_with_text: bool,
        text: String,
        #[serde(rename = "replyToMessageId")]
        reply_to_message_id: Option<String>,
        #[serde(rename = "threadRootId")]
        thread_root_id: Option<String>,
        reactions: Vec<ChannelReaction>,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        success: bool,
        usage: Usage,
        #[serde(rename = "totalCostUsd")]
        total_cost_usd: f64,
    },
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ChannelReaction {
    #[serde(rename = "messageId")]
    message_id: String,
    emoji: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Usage {
    #[serde(rename = "inputTokens")]
    input_tokens: i64,
    #[serde(rename = "outputTokens")]
    output_tokens: i64,
    #[serde(rename = "cacheCreationInputTokens")]
    cache_creation_input_tokens: i64,
    #[serde(rename = "cacheReadInputTokens")]
    cache_read_input_tokens: i64,
}

fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("sidecar").join("dist").join("index.js");
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("dist")
        .join("index.js");
    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err(format!(
        "Could not locate sidecar entry point. Looked in resource dir and {:?}",
        dev_path
    ))
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = spawn_inner(app).await {
            eprintln!("[sidecar] failed to start: {err}");
        }
    });
}

async fn spawn_inner(app: AppHandle) -> Result<(), String> {
    let script = resolve_sidecar_script(&app)?;

    let mut child: Child = Command::new("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn node sidecar at {script:?}: {e}"))?;

    let stdin = child.stdin.take().ok_or("sidecar missing stdin")?;
    let stdout = child.stdout.take().ok_or("sidecar missing stdout")?;
    let stderr = child.stderr.take().ok_or("sidecar missing stderr")?;

    {
        let state = app.state::<SidecarState>();
        *state.stdin.lock().await = Some(stdin);
    }

    let stdout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<SidecarEvent>(&line) {
                        Ok(event) => {
                            let _ = stdout_app.emit("cos://event", event);
                        }
                        Err(e) => {
                            eprintln!("[sidecar] unparseable line: {line} ({e})");
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("[sidecar] stdout read error: {e}");
                    break;
                }
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[sidecar:stderr] {line}");
        }
    });

    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        eprintln!("[sidecar] process exited: {status:?}");
    });

    Ok(())
}

async fn write_request(app: &AppHandle, req: &impl Serialize) -> Result<(), String> {
    let mut line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    line.push('\n');

    let state = app.state::<SidecarState>();
    let mut guard = state.stdin.lock().await;
    let stdin = guard.as_mut().ok_or("sidecar is not running")?;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("failed to write to sidecar stdin: {e}"))?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cos_send(
    app: AppHandle,
    id: String,
    conversation_id: String,
    company_id: Option<String>,
    provider: Option<String>,
    model: String,
    effort: String,
    system_prompt: String,
    prompt: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    let req = SendRequest {
        kind: "send",
        id: &id,
        conversation_id: &conversation_id,
        company_id: company_id.as_deref(),
        provider: provider.as_deref(),
        model: &model,
        effort: &effort,
        system_prompt: &system_prompt,
        prompt: &prompt,
        resume_session_id: resume_session_id.as_deref(),
    };
    write_request(&app, &req).await
}

#[tauri::command]
pub async fn cos_count_tokens(
    app: AppHandle,
    id: String,
    provider: Option<String>,
    model: String,
    system_prompt: String,
) -> Result<(), String> {
    let req = CountTokensRequest {
        kind: "count_tokens",
        id: &id,
        provider: provider.as_deref(),
        model: &model,
        system_prompt: &system_prompt,
    };
    write_request(&app, &req).await
}

#[tauri::command]
pub async fn cos_check_relevance(
    app: AppHandle,
    id: String,
    employee_context: String,
    channel_name: String,
    trigger_message: String,
) -> Result<(), String> {
    let req = CheckRelevanceRequest {
        kind: "check_relevance",
        id: &id,
        employee_context: &employee_context,
        channel_name: &channel_name,
        trigger_message: &trigger_message,
    };
    write_request(&app, &req).await
}

// ---------------------------------------------------------------------------
// New agent runtime: process management + generic typed transport.
// ---------------------------------------------------------------------------

fn resolve_runtime_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir
            .join("sidecar")
            .join("dist")
            .join("runtime")
            .join("index.js");
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("dist")
        .join("runtime")
        .join("index.js");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    Err(format!(
        "Could not locate runtime entry point. Looked in resource dir and {dev_path:?}"
    ))
}

/// The SQLite file the runtime owns — the same file tauri-plugin-sql opens, so
/// the (transitional) client reader and the runtime writer share one database.
fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir app config dir: {e}"))?;
    Ok(dir.join("cofounder.db"))
}

pub fn spawn_runtime(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = spawn_runtime_inner(app).await {
            eprintln!("[runtime] failed to start: {err}");
        }
    });
}

async fn spawn_runtime_inner(app: AppHandle) -> Result<(), String> {
    let script = resolve_runtime_script(&app)?;
    let db_path = resolve_db_path(&app)?;

    let mut child: Child = Command::new("node")
        .arg(&script)
        .env("COFOUNDER_DB_PATH", &db_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn runtime at {script:?}: {e}"))?;

    let stdin = child.stdin.take().ok_or("runtime missing stdin")?;
    let stdout = child.stdout.take().ok_or("runtime missing stdout")?;
    let stderr = child.stderr.take().ok_or("runtime missing stderr")?;

    {
        let state = app.state::<RuntimeState>();
        *state.stdin.lock().await = Some(stdin);
    }

    // Forward every runtime stdout line (event/result/ready) to the webview as
    // an opaque JSON value; the client's runtimeClient routes by kind + id.
    let stdout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(value) => {
                    let _ = stdout_app.emit("runtime://event", value);
                }
                Err(e) => eprintln!("[runtime] unparseable line: {line} ({e})"),
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[runtime:stderr] {line}");
        }
    });

    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        eprintln!("[runtime] process exited: {status:?}");
    });

    Ok(())
}

/// Generic transport: forward an opaque client Command/Query (already a typed
/// envelope on the TS side) to the runtime over stdin. Replies come back async
/// via the `runtime://event` stream, correlated by `id`.
#[tauri::command]
pub async fn send_to_runtime(app: AppHandle, message: serde_json::Value) -> Result<(), String> {
    let mut line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    line.push('\n');
    let state = app.state::<RuntimeState>();
    let mut guard = state.stdin.lock().await;
    let stdin = guard.as_mut().ok_or("runtime is not running")?;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("failed to write to runtime stdin: {e}"))?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cos_send_channel(
    app: AppHandle,
    id: String,
    company_id: Option<String>,
    provider: Option<String>,
    model: String,
    effort: String,
    system_prompt: String,
    prompt: String,
    resume_session_id: Option<String>,
    open_threads: Vec<ThreadRef>,
    reaction_targets: Vec<ReactionTarget>,
) -> Result<(), String> {
    let req = SendChannelRequest {
        kind: "send_channel",
        id: &id,
        company_id: company_id.as_deref(),
        provider: provider.as_deref(),
        model: &model,
        effort: &effort,
        system_prompt: &system_prompt,
        prompt: &prompt,
        resume_session_id: resume_session_id.as_deref(),
        open_threads: &open_threads,
        reaction_targets: &reaction_targets,
    };
    write_request(&app, &req).await
}
