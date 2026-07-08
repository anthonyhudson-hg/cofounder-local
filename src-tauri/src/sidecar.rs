use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

// How often the exit-watcher polls the child instead of blocking on `child.wait()` for
// the process's whole lifetime — releasing the lock between polls is what lets
// `kill_now()` (called from the app's Exit handler) actually acquire it (report §4.2).
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(300);

/// State for the agent runtime process (owns SQLite, serves the typed
/// command/query/event protocol). Full cutover: this is now the ONLY Node
/// process the app spawns — the legacy sidecar (raw `cos_*` JSON-over-stdio
/// protocol) has been retired; the runtime owns DM send, channel send, token
/// counting, and everything else that used to be split across both processes.
pub struct RuntimeState {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

impl RuntimeState {
    pub fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
        }
    }

    /// Best-effort immediate kill, called from the app's `RunEvent::Exit` handler.
    /// `kill_on_drop(true)` on the spawned `Command` is the primary safety net, but it
    /// only fires if the `Child` value is actually dropped through normal Rust
    /// unwinding — a shutdown path that bypasses that (e.g. the process being torn
    /// down abruptly) could otherwise leave the runtime orphaned, still holding the
    /// SQLite file open (report §4.2). Uses `try_lock` (non-blocking, safe to call
    /// from the synchronous event-loop callback) since this is a best-effort
    /// backstop, not the only line of defense.
    fn kill_now(&self) {
        if let Ok(mut guard) = self.child.try_lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}

/// Kills the managed child process — called once from the app's `RunEvent::Exit`
/// handler in `lib.rs` (report §4.2).
pub fn kill_children(app: &AppHandle) {
    app.state::<RuntimeState>().kill_now();
}

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

/// Spawns `node <script>` with piped stdio and `kill_on_drop`.
struct SpawnedProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
}

fn spawn_node_process(script: &PathBuf, extra_env: &[(&str, &std::ffi::OsStr)]) -> Result<SpawnedProcess, String> {
    let mut cmd = Command::new("node");
    cmd.arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn node process at {script:?}: {e}"))?;

    let stdin = child.stdin.take().ok_or("process missing stdin")?;
    let stdout = child.stdout.take().ok_or("process missing stdout")?;
    let stderr = child.stderr.take().ok_or("process missing stderr")?;
    Ok(SpawnedProcess { child, stdin, stdout, stderr })
}

/// Polls the child until it exits (rather than blocking on `child.wait()` for the
/// process's whole lifetime), clearing `stdin`/`child` in `state` once it does so a
/// later `send_to_runtime` call sees a clear "not running" error instead of silently
/// hitting a stale pipe and failing with a raw broken-pipe OS error (report §4.2,
/// item 2). Releasing the lock between polls is also what lets `kill_now()` acquire it.
async fn watch_for_exit(
    log_prefix: &'static str,
    stdin_mutex: &Mutex<Option<ChildStdin>>,
    child_mutex: &Mutex<Option<Child>>,
) {
    let status = loop {
        let mut guard = child_mutex.lock().await;
        let poll_result = match guard.as_mut() {
            Some(child) => child.try_wait(),
            None => return,
        };
        match poll_result {
            Ok(Some(status)) => break status,
            Ok(None) => {
                drop(guard);
                tokio::time::sleep(EXIT_POLL_INTERVAL).await;
            }
            Err(e) => {
                eprintln!("[{log_prefix}] error polling process status: {e}");
                return;
            }
        }
    };
    eprintln!("[{log_prefix}] process exited: {status:?}");
    *stdin_mutex.lock().await = None;
    *child_mutex.lock().await = None;
}

pub fn spawn_runtime(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = spawn_runtime_inner(app.clone()).await {
            eprintln!("[runtime] failed to start: {err}");
            let _ = app.emit("runtime://startup-error", err);
        }
    });
}

async fn spawn_runtime_inner(app: AppHandle) -> Result<(), String> {
    let script = resolve_runtime_script(&app)?;
    let db_path = resolve_db_path(&app)?;
    let db_path_os = db_path.as_os_str();

    let proc = spawn_node_process(&script, &[("COFOUNDER_DB_PATH", db_path_os)])?;

    {
        let state = app.state::<RuntimeState>();
        *state.stdin.lock().await = Some(proc.stdin);
        *state.child.lock().await = Some(proc.child);
    }

    // Forward every runtime stdout line (event/result/ready) to the webview as
    // an opaque JSON value; the client's runtimeClient routes by kind + id.
    let stdout_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(proc.stdout).lines();
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
        let mut lines = BufReader::new(proc.stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[runtime:stderr] {line}");
        }
    });

    let wait_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = wait_app.state::<RuntimeState>();
        watch_for_exit("runtime", &state.stdin, &state.child).await;
    });

    Ok(())
}

/// Generic transport: forward an opaque client Command/Query (already a typed
/// envelope on the TS side) to the runtime over stdin. Replies come back async
/// via the `runtime://event` stream, correlated by `id`.
#[tauri::command]
pub async fn send_to_runtime(app: AppHandle, message: serde_json::Value) -> Result<(), String> {
    // A minimal shape check before this privileged, DB-owning process's stdin sees
    // it — Rust was previously a pure pass-through with no validation at all
    // (report §4.2).
    if !message.is_object() {
        return Err("send_to_runtime: message must be a JSON object".to_string());
    }

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
