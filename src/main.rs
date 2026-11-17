#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod assets;
mod error;
mod fsutil;
mod index;
mod window;

use std::sync::Arc;
use tauri::Manager;

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    if getrandom::getrandom(&mut bytes).is_err() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((now >> ((index % 16) * 8)) & 0xff) as u8;
        }
    }
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn main() {
    let local = fsutil::local_app_data().join("FileDock");
    let demo_root = local.join("demo");
    let _ = std::fs::create_dir_all(&local);
    assets::ensure_demo(&demo_root);

    let app_root = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let allowed_root = std::env::var("FILEDOCK_ROOT")
        .or_else(|_| std::env::var("TWINPAD_ROOT"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| fsutil::resolve_path(Some(&value), None).ok());

    let state = Arc::new(api::AppState::new(
        random_token(),
        env!("CARGO_PKG_VERSION").to_string(),
        allowed_root,
        demo_root,
        app_root,
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            {
                let mut handle = state.app.lock().unwrap_or_else(|e| e.into_inner());
                *handle = Some(app.handle().clone());
            }

            let port = match api::start_server(state.clone()) {
                Ok(port) => port,
                Err(err) => {
                    eprintln!("[desktop] 本地服务无法启动：{}", err);
                    return Err(err.into());
                }
            };

            let window = window::create_main_window(app.handle(), &state, port)?;
            window::attach_events(&window, state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("FileDock 启动失败");
}
