mod sidecar;

// SQLite schema + migrations are now owned entirely by the Node runtime
// (sidecar/src/db). The Rust layer no longer opens or migrates the database;
// it only manages the sidecar/runtime processes and the IPC transport.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .manage(sidecar::SidecarState::new())
        .manage(sidecar::RuntimeState::new())
        .invoke_handler(tauri::generate_handler![
            sidecar::cos_send,
            sidecar::cos_count_tokens,
            sidecar::cos_check_relevance,
            sidecar::cos_send_channel,
            sidecar::send_to_runtime
        ])
        .setup(|app| {
            sidecar::spawn(app.handle().clone());
            sidecar::spawn_runtime(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
