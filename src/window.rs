use crate::api::{AppState, Bounds};
use crate::fsutil;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow};

#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct SavedState {
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
}

fn state_dir() -> PathBuf {
    fsutil::app_data_dir().join("FileDock")
}

fn state_file() -> PathBuf {
    state_dir().join("window-state.json")
}

fn migrate_state() {
    let target = state_file();
    if target.exists() {
        return;
    }
    let legacy = fsutil::app_data_dir()
        .join("TwinPad")
        .join("window-state.json");
    if !legacy.exists() {
        return;
    }
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::copy(legacy, target);
}

pub fn load_state() -> SavedState {
    migrate_state();
    let fallback = SavedState {
        x: None,
        y: None,
        width: 1360.0,
        height: 860.0,
        maximized: false,
    };
    let Ok(text) = fs::read_to_string(state_file()) else {
        return fallback;
    };
    let Ok(saved) = serde_json::from_str::<SavedState>(&text) else {
        return fallback;
    };
    if !saved.width.is_finite() || !saved.height.is_finite() {
        return fallback;
    }
    SavedState {
        width: saved.width.max(940.0),
        height: saved.height.max(620.0),
        ..saved
    }
}

fn position_visible(app: &AppHandle, x: f64, y: f64) -> bool {
    let monitors = app.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        return false;
    }
    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let position = monitor.position();
        let size = monitor.size();
        let left = position.x as f64 / scale;
        let top = position.y as f64 / scale;
        let right = left + size.width as f64 / scale;
        let bottom = top + size.height as f64 / scale;
        x < right - 80.0 && x + 200.0 > left && y < bottom - 40.0 && y + 120.0 > top
    })
}

pub fn save_state(window: &WebviewWindow, state: &AppState) {
    let maximized = window.is_maximized().unwrap_or(false);
    if !maximized {
        if let (Ok(position), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.inner_size(),
            window.scale_factor(),
        ) {
            let scale = if scale > 0.0 { scale } else { 1.0 };
            let bounds = Bounds {
                x: (position.x as f64 / scale).round() as i32,
                y: (position.y as f64 / scale).round() as i32,
                width: (size.width as f64 / scale).round() as u32,
                height: (size.height as f64 / scale).round() as u32,
            };
            *state.normal_bounds.lock().unwrap_or_else(|e| e.into_inner()) = Some(bounds);
        }
    }

    let bounds = *state
        .normal_bounds
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some(bounds) = bounds else {
        return;
    };

    let payload = SavedState {
        x: Some(bounds.x as f64),
        y: Some(bounds.y as f64),
        width: bounds.width as f64,
        height: bounds.height as f64,
        maximized,
    };
    if let Some(parent) = state_file().parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(&payload) {
        let _ = fs::write(state_file(), text);
    }
}

pub fn note_bounds(window: &WebviewWindow, state: Arc<AppState>) {
    let maximized = window.is_maximized().unwrap_or(false);
    if !maximized {
        if let (Ok(position), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.inner_size(),
            window.scale_factor(),
        ) {
            let scale = if scale > 0.0 { scale } else { 1.0 };
            let bounds = Bounds {
                x: (position.x as f64 / scale).round() as i32,
                y: (position.y as f64 / scale).round() as i32,
                width: (size.width as f64 / scale).round() as u32,
                height: (size.height as f64 / scale).round() as u32,
            };
            *state.normal_bounds.lock().unwrap_or_else(|e| e.into_inner()) = Some(bounds);
        }
    }

    let generation = state.bounds_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if state.bounds_gen.load(Ordering::SeqCst) == generation {
            save_state(&window, &state);
        }
    });
}

pub fn toggle_maximize(window: &WebviewWindow) {
    let maximized = window.is_maximized().unwrap_or(false);
    let _ = if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    };
    let now = window.is_maximized().unwrap_or(!maximized);
    let _ = window.eval(&format!(
        "window.__filedockWindowState && window.__filedockWindowState({});",
        now
    ));
}

pub fn force_close(window: &WebviewWindow, state: &AppState) {
    state.closing.store(true, Ordering::SeqCst);
    save_state(window, state);
    let _ = window.destroy();
}

pub fn create_main_window(
    app: &AppHandle,
    state: &Arc<AppState>,
    port: u16,
) -> tauri::Result<WebviewWindow> {
    let saved = load_state();
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External(
            format!("http://127.0.0.1:{}/", port)
                .parse()
                .expect("local url"),
        ),
    )
    .title("FileDock")
    .inner_size(saved.width, saved.height)
    .min_inner_size(940.0, 620.0)
    .decorations(false)
    .background_color(tauri::window::Color(13, 19, 25, 255))
    .visible(true);

    if let (Some(x), Some(y)) = (saved.x, saved.y) {
        if position_visible(app, x, y) {
            builder = builder.position(x, y);
        }
    }

    let window = builder.build()?;
    if saved.maximized {
        let _ = window.maximize();
        state.was_maximized.store(true, Ordering::SeqCst);
    }

    if let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) {
        if !saved.maximized {
            let scale = if scale > 0.0 { scale } else { 1.0 };
            *state.normal_bounds.lock().unwrap_or_else(|e| e.into_inner()) = Some(Bounds {
                x: (position.x as f64 / scale).round() as i32,
                y: (position.y as f64 / scale).round() as i32,
                width: (size.width as f64 / scale).round() as u32,
                height: (size.height as f64 / scale).round() as u32,
            });
        }
    }

    Ok(window)
}

pub fn attach_events(window: &WebviewWindow, state: Arc<AppState>) {
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if state.closing.load(Ordering::SeqCst) {
                save_state(&handle, &state);
            } else {
                api.prevent_close();
                let _ = handle.eval(
                    "window.__filedockCloseRequested && window.__filedockCloseRequested();",
                );
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            let maximized = handle.is_maximized().unwrap_or(false);
            let previously = state.was_maximized.swap(maximized, Ordering::SeqCst);
            if maximized != previously {
                let _ = handle.eval(&format!(
                    "window.__filedockWindowState && window.__filedockWindowState({});",
                    maximized
                ));
            }
            note_bounds(&handle, state.clone());
        }
        tauri::WindowEvent::DragDrop(event) => match event {
            tauri::DragDropEvent::Enter { .. } | tauri::DragDropEvent::Over { .. } => {
                let _ = handle.eval("window.__filedockDragState && window.__filedockDragState(true);");
            }
            tauri::DragDropEvent::Leave => {
                let _ = handle.eval("window.__filedockDragState && window.__filedockDragState(false);");
            }
            tauri::DragDropEvent::Drop { paths, .. } => {
                let files: Vec<String> = paths.iter().map(|path| fsutil::path_string(path)).collect();
                let literal = serde_json::to_string(&files).unwrap_or_else(|_| "[]".to_string());
                let _ = handle.eval(&format!(
                    "window.__filedockDragState && window.__filedockDragState(false); window.__filedockDrop && window.__filedockDrop({});",
                    literal
                ));
            }
            _ => {}
        },
        _ => {}
    });
}
