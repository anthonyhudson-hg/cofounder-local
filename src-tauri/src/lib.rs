mod sidecar;

// SQLite schema + migrations are now owned entirely by the Node runtime
// (sidecar/src/db). The Rust layer no longer opens or migrates the database;
// it only manages the sidecar/runtime processes and the IPC transport.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(sidecar::RuntimeState::new())
        .invoke_handler(tauri::generate_handler![sidecar::send_to_runtime])
        .setup(|app| {
            sidecar::spawn_runtime(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Explicitly kill the sidecar/runtime child processes on shutdown instead of
    // relying solely on `kill_on_drop` — that only fires if the `Child` values are
    // dropped through normal Rust unwinding, which some shutdown paths bypass,
    // otherwise orphaning them still holding the SQLite file open (report §4.2).
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            sidecar::kill_children(app_handle);
        }
    });
}
