use crate::assets::PublicAssets;
use crate::error::{ApiError, ApiResult};
use crate::fsutil;
use crate::index::{self, IndexAction, IndexManager};
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{body::Body, Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const MAX_BODY: usize = 80 * 1024 * 1024;

#[derive(Clone, Copy)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub struct AppState {
    pub token: String,
    pub version: String,
    pub allowed_root: Option<PathBuf>,
    pub demo_root: PathBuf,
    pub app_root: PathBuf,
    pub index: IndexManager,
    pub app: Mutex<Option<AppHandle>>,
    pub closing: AtomicBool,
    pub bounds_gen: AtomicU64,
    pub normal_bounds: Mutex<Option<Bounds>>,
    pub was_maximized: AtomicBool,
}

impl AppState {
    pub fn new(
        token: String,
        version: String,
        allowed_root: Option<PathBuf>,
        demo_root: PathBuf,
        app_root: PathBuf,
    ) -> Self {
        Self {
            token,
            version,
            allowed_root,
            demo_root,
            app_root,
            index: IndexManager::new(),
            app: Mutex::new(None),
            closing: AtomicBool::new(false),
            bounds_gen: AtomicU64::new(0),
            normal_bounds: Mutex::new(None),
            was_maximized: AtomicBool::new(false),
        }
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/info", get(api_info))
        .route("/api/fs/roots", get(api_roots))
        .route("/api/fs/list", get(api_list))
        .route("/api/fs/stat", get(api_stat))
        .route("/api/fs/read", get(api_read))
        .route("/api/fs/files", get(api_files))
        .route("/api/fs/write", post(api_write))
        .route("/api/fs/mkdir", post(api_mkdir))
        .route("/api/fs/rename", post(api_rename))
        .route("/api/fs/delete", post(api_delete))
        .route("/api/fs/copy", post(api_copy))
        .route("/api/fs/reveal", post(api_reveal))
        .route("/api/index/search", get(api_index_search))
        .route("/api/index/status", get(api_index_status))
        .route("/api/index/build", post(api_index_build))
        .route("/api/search", get(api_search))
        .route("/api/replace", post(api_replace))
        .route("/api/diff/dirs", post(api_diff_dirs))
        .route("/api/desktop/minimize", post(api_minimize))
        .route("/api/desktop/toggle-maximize", post(api_toggle_maximize))
        .route("/api/desktop/start-drag", post(api_start_drag))
        .route("/api/desktop/close", post(api_close))
        .route("/api/desktop/force-close", post(api_force_close))
        .route("/api/desktop/state", get(api_desktop_state))
        .fallback(static_assets)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

/// Start the local HTTP server on its own thread and return the bound port.
pub fn start_server(state: Arc<AppState>) -> Result<u16, String> {
    let preferred = std::env::var("FILEDOCK_DESKTOP_PORT")
        .or_else(|_| std::env::var("TWINPAD_DESKTOP_PORT"))
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(5278);

    let (sender, receiver) = std::sync::mpsc::channel::<Result<u16, String>>();
    std::thread::Builder::new()
        .name("filedock-http".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    let _ = sender.send(Err(format!("无法创建运行时：{}", err)));
                    return;
                }
            };

            runtime.block_on(async move {
                let mut port = preferred;
                let listener = loop {
                    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                        Ok(listener) => break listener,
                        Err(err) => {
                            if port < preferred.saturating_add(30) {
                                port += 1;
                            } else {
                                let _ = sender.send(Err(format!(
                                    "端口 {}-{} 均不可用：{}",
                                    preferred,
                                    preferred.saturating_add(30),
                                    err
                                )));
                                return;
                            }
                        }
                    }
                };
                let actual = listener.local_addr().map(|addr| addr.port()).unwrap_or(port);
                let _ = sender.send(Ok(actual));
                println!("[desktop] 本地服务 http://127.0.0.1:{}", actual);
                if let Err(err) = axum::serve(listener, router(state)).await {
                    eprintln!("[http] {}", err);
                }
            });
        })
        .map_err(|err| format!("无法启动服务线程：{}", err))?;

    receiver
        .recv_timeout(Duration::from_secs(10))
        .map_err(|err| format!("等待服务启动超时：{}", err))?
}

async fn guard(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let hostname = host_only(host);
    if !hostname.is_empty()
        && !matches!(hostname, "127.0.0.1" | "localhost" | "[::1]" | "::1")
    {
        return ApiError::new(403, "仅允许本机访问").into_response();
    }

    if req.uri().path().starts_with("/api/") {
        let token = req
            .headers()
            .get("x-app-token")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !constant_time_eq(token.as_bytes(), state.token.as_bytes()) {
            return ApiError::new(403, "无效的访问令牌，请刷新页面").into_response();
        }
    }

    next.run(req).await
}

fn host_only(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        match rest.find(']') {
            Some(index) => &host[..index + 2],
            None => host,
        }
    } else {
        host.split(':').next().unwrap_or(host)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for index in 0..a.len() {
        diff |= a[index] ^ b[index];
    }
    diff == 0
}

async fn blocking<T, F>(task: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> ApiResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|err| ApiError::new(500, format!("后台任务失败：{}", err)))?
}

fn path_arg(q: &HashMap<String, String>) -> Option<&str> {
    q.get("path").map(|value| value.as_str())
}

fn root_arg(q: &HashMap<String, String>) -> String {
    q.get("root")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| fsutil::path_string(&fsutil::home_dir()))
}

fn list_from_value(value: Option<&Value>, fallback: &[&str]) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(|item| item.to_string())
            .collect(),
        Some(Value::String(text)) => fsutil::parse_list(Some(text), fallback),
        _ => fsutil::parse_list(None, fallback),
    }
}

// ---------------------------------------------------------------- info / roots

async fn api_info(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let roots = fsutil::list_roots(state.allowed_root.as_deref());
    let mut value = serde_json::to_value(&roots)?;
    if let Value::Object(map) = &mut value {
        map.insert("app".to_string(), json!("FileDock"));
        map.insert("version".to_string(), json!(state.version));
        map.insert("node".to_string(), json!("Tauri 2 · WebView2"));
        map.insert(
            "appRoot".to_string(),
            json!(fsutil::path_string(&state.app_root)),
        );
        map.insert(
            "demoRoot".to_string(),
            json!(fsutil::path_string(&state.demo_root)),
        );
    }
    Ok(Json(value))
}

async fn api_roots(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    Ok(Json(serde_json::to_value(fsutil::list_roots(
        state.allowed_root.as_deref(),
    ))?))
}

// ---------------------------------------------------------------- fs

async fn api_list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let dir = fsutil::resolve_path(path_arg(&q), state.allowed_root.as_deref())?;
    let listing = blocking(move || fsutil::list_dir(&dir)).await?;
    Ok(Json(serde_json::to_value(listing)?))
}

async fn api_stat(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let target = fsutil::resolve_path(path_arg(&q), state.allowed_root.as_deref())?;
    let meta = std::fs::metadata(&target)?;
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(Json(json!({
        "path": fsutil::path_string(&target),
        "name": name,
        "isDir": meta.is_dir(),
        "size": meta.len(),
        "mtime": fsutil::mtime_ms(&meta),
        "ctime": fsutil::ctime_ms(&meta),
    })))
}

async fn api_read(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let file = fsutil::resolve_path(path_arg(&q), state.allowed_root.as_deref())?;
    let data = blocking(move || fsutil::read_text_file(&file)).await?;
    Ok(Json(serde_json::to_value(data)?))
}

async fn api_files(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let root = fsutil::resolve_path(path_arg(&q), state.allowed_root.as_deref())?;
    let max = q
        .get("max")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(8000)
        .min(30000);
    let include = fsutil::parse_list(q.get("include").map(|v| v.as_str()), &["*"]);
    let exclude = fsutil::parse_list(
        q.get("exclude").map(|v| v.as_str()),
        fsutil::DEFAULT_EXCLUDES,
    );
    let root_clone = root.clone();
    let result = blocking(move || {
        let walk = fsutil::walk_tree(&root_clone, &include, &exclude, max);
        let mut files: Vec<Value> = walk
            .map
            .values()
            .filter(|entry| !entry.is_dir)
            .map(|entry| {
                json!({
                    "rel": entry.rel,
                    "name": entry.name,
                    "path": fsutil::path_string(&root_clone.join(entry.rel.split('/').collect::<PathBuf>())),
                    "size": entry.size,
                    "mtime": entry.mtime,
                })
            })
            .collect();
        files.sort_by(|a, b| {
            fsutil::natural_cmp(
                a.get("rel").and_then(|v| v.as_str()).unwrap_or(""),
                b.get("rel").and_then(|v| v.as_str()).unwrap_or(""),
            )
        });
        Ok((files, walk.truncated))
    })
    .await?;
    Ok(Json(json!({
        "root": fsutil::path_string(&root),
        "files": result.0,
        "truncated": result.1,
    })))
}

async fn api_write(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let raw_path = body.get("path").and_then(|value| value.as_str());
    let content = body
        .get("content")
        .and_then(|value| value.as_str())
        .ok_or_else(|| ApiError::bad_request("内容必须是字符串"))?
        .to_string();
    let encoding = body
        .get("encoding")
        .and_then(|value| value.as_str())
        .unwrap_or("utf8")
        .to_string();
    let eol = body
        .get("eol")
        .and_then(|value| value.as_str())
        .unwrap_or("LF")
        .to_string();
    let file = fsutil::resolve_path(raw_path, state.allowed_root.as_deref())?;
    let file_clone = file.clone();
    let result = blocking(move || fsutil::write_text_file(&file_clone, &content, &encoding, &eol)).await?;
    index::update_path(&state.index, &file, IndexAction::Add).await;
    Ok(Json(serde_json::to_value(result)?))
}

async fn api_mkdir(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let dir = fsutil::resolve_path(
        body.get("path").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let recursive = body
        .get("recursive")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let dir_clone = dir.clone();
    blocking(move || {
        if recursive {
            std::fs::create_dir_all(&dir_clone)?;
        } else {
            std::fs::create_dir(&dir_clone)?;
        }
        Ok(())
    })
    .await?;
    index::update_path(&state.index, &dir, IndexAction::Add).await;
    Ok(Json(json!({ "path": fsutil::path_string(&dir) })))
}

async fn api_rename(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let from = fsutil::resolve_path(
        body.get("from").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let to = fsutil::resolve_path(
        body.get("to").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    if fsutil::path_string(&from) == fsutil::path_string(&to) {
        return Ok(Json(json!({
            "from": fsutil::path_string(&from),
            "to": fsutil::path_string(&to),
        })));
    }
    if to.exists() {
        return Err(ApiError::new(409, format!("目标已存在：{}", fsutil::path_string(&to))));
    }
    let (from_clone, to_clone) = (from.clone(), to.clone());
    blocking(move || {
        std::fs::rename(&from_clone, &to_clone)?;
        Ok(())
    })
    .await?;
    index::update_path(&state.index, &from, IndexAction::Remove).await;
    index::update_path(&state.index, &to, IndexAction::Add).await;
    Ok(Json(json!({
        "from": fsutil::path_string(&from),
        "to": fsutil::path_string(&to),
    })))
}

async fn api_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let target = fsutil::resolve_path(
        body.get("path").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let target_clone = target.clone();
    blocking(move || {
        let meta = std::fs::metadata(&target_clone)?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&target_clone)?;
        } else {
            std::fs::remove_file(&target_clone)?;
        }
        Ok(())
    })
    .await?;
    index::update_path(&state.index, &target, IndexAction::Remove).await;
    Ok(Json(json!({ "deleted": fsutil::path_string(&target) })))
}

async fn api_copy(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let from = fsutil::resolve_path(
        body.get("from").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let to = fsutil::resolve_path(
        body.get("to").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    if fsutil::path_string(&from) == fsutil::path_string(&to) {
        return Err(ApiError::bad_request("源和目标相同"));
    }
    let (from_clone, to_clone) = (from.clone(), to.clone());
    blocking(move || {
        if let Some(parent) = to_clone.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&from_clone, &to_clone)?;
        Ok(())
    })
    .await?;
    index::update_path(&state.index, &to, IndexAction::Add).await;
    Ok(Json(json!({
        "from": fsutil::path_string(&from),
        "to": fsutil::path_string(&to),
    })))
}

async fn api_reveal(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let target = fsutil::resolve_path(
        body.get("path").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let meta = std::fs::metadata(&target)?;
    let target_string = fsutil::path_string(&target);
    #[cfg(windows)]
    {
        use std::process::Command;
        if meta.is_dir() {
            let _ = Command::new("explorer.exe").arg(&target_string).spawn();
        } else {
            let _ = Command::new("explorer.exe")
                .arg(format!("/select,{}", target_string))
                .spawn();
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        if meta.is_dir() {
            let _ = Command::new("open").arg(&target_string).spawn();
        } else {
            let _ = Command::new("open").arg("-R").arg(&target_string).spawn();
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::process::Command;
        let reveal = if meta.is_dir() {
            target_string.clone()
        } else {
            target
                .parent()
                .map(fsutil::path_string)
                .unwrap_or(target_string.clone())
        };
        let _ = Command::new("xdg-open").arg(reveal).spawn();
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------- index

async fn api_index_search(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let root = fsutil::resolve_path(
        Some(&root_arg(&q)),
        state.allowed_root.as_deref(),
    )?;
    let state_ref = index::ensure(&state.index, &root, true, false).await;
    let limit = q
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100)
        .clamp(1, 300);
    let dirs = q.get("dirs").map(|value| value != "0").unwrap_or(true);
    let query = q.get("q").cloned().unwrap_or_default();

    let (found, status) = {
        let st = state_ref.lock().await;
        (index::search_entries(&st, &query, limit, dirs), st.status_json())
    };

    let mut results = Vec::new();
    for hit in found.results {
        let mut item = json!({
            "path": hit.path,
            "rel": hit.rel,
            "name": hit.name,
            "isDir": hit.is_dir,
        });
        if !hit.is_dir {
            if let Ok(meta) = std::fs::metadata(&hit.path) {
                item["size"] = json!(meta.len());
                item["mtime"] = json!(fsutil::mtime_ms(&meta));
            }
        }
        results.push(item);
    }

    let mut value = serde_json::to_value(&status)?;
    if let Value::Object(map) = &mut value {
        map.insert("query".to_string(), json!(query));
        map.insert("results".to_string(), Value::Array(results));
        map.insert("matched".to_string(), json!(found.matched));
        map.insert("hasMore".to_string(), json!(found.has_more));
        map.insert("capped".to_string(), json!(found.capped));
    }
    Ok(Json(value))
}

async fn api_index_status(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let root = fsutil::resolve_path(
        Some(&root_arg(&q)),
        state.allowed_root.as_deref(),
    )?;
    let state_ref = index::ensure(&state.index, &root, false, false).await;
    let status = {
        let st = state_ref.lock().await;
        st.status_json()
    };
    Ok(Json(serde_json::to_value(status)?))
}

async fn api_index_build(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let root_text = body
        .get("root")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| fsutil::path_string(&fsutil::home_dir()));
    let root = fsutil::resolve_path(Some(&root_text), state.allowed_root.as_deref())?;
    let state_ref = index::ensure(&state.index, &root, false, false).await;
    index::start_build(state_ref.clone(), true).await;
    let status = {
        let st = state_ref.lock().await;
        st.status_json()
    };
    Ok((StatusCode::ACCEPTED, Json(serde_json::to_value(status)?)))
}

// ---------------------------------------------------------------- content search / replace

async fn api_search(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let root = fsutil::resolve_path(
        q.get("root").map(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let query = q.get("q").cloned().unwrap_or_default();
    let options = fsutil::SearchOptions {
        case_sensitive: q.get("caseSensitive").map(|v| v == "1").unwrap_or(false),
        regex: q.get("regex").map(|v| v == "1").unwrap_or(false),
        whole_word: q.get("wholeWord").map(|v| v == "1").unwrap_or(false),
        include: fsutil::parse_list(q.get("include").map(|v| v.as_str()), &["*"]),
        exclude: fsutil::parse_list(
            q.get("exclude").map(|v| v.as_str()),
            fsutil::DEFAULT_EXCLUDES,
        ),
        max_results: q.get("max").and_then(|value| value.parse::<usize>().ok()),
    };
    let result = blocking(move || fsutil::search_files(&root, &query, options)).await?;
    Ok(Json(serde_json::to_value(result)?))
}

async fn api_replace(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let root = fsutil::resolve_path(
        body.get("root").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let find = body
        .get("find")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let replace = body
        .get("replace")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let case_sensitive = body
        .get("caseSensitive")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let use_regex = body
        .get("regex")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let whole_word = body
        .get("wholeWord")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let include = list_from_value(body.get("include"), &["*"]);
    let exclude = list_from_value(body.get("exclude"), fsutil::DEFAULT_EXCLUDES);

    let result = blocking(move || {
        fsutil::replace_in_files(
            &root,
            &find,
            &replace,
            case_sensitive,
            use_regex,
            whole_word,
            include,
            exclude,
        )
    })
    .await?;
    Ok(Json(serde_json::to_value(result)?))
}

// ---------------------------------------------------------------- folder diff

async fn api_diff_dirs(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let left = fsutil::resolve_path(
        body.get("left").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let right = fsutil::resolve_path(
        body.get("right").and_then(|value| value.as_str()),
        state.allowed_root.as_deref(),
    )?;
    let mode = body
        .get("mode")
        .and_then(|value| value.as_str())
        .unwrap_or("content")
        .to_string();
    let include = list_from_value(body.get("include"), &["*"]);
    let exclude = list_from_value(body.get("exclude"), fsutil::DEFAULT_EXCLUDES);

    let result = blocking(move || fsutil::diff_dirs(&left, &right, &mode, include, exclude)).await?;
    Ok(Json(serde_json::to_value(result)?))
}

// ---------------------------------------------------------------- window bridge

fn main_window(state: &AppState) -> Option<tauri::WebviewWindow> {
    let app = state.app.lock().unwrap_or_else(|e| e.into_inner());
    app.as_ref().and_then(|app| app.get_webview_window("main"))
}

async fn api_minimize(State(state): State<Arc<AppState>>) -> Json<Value> {
    if let Some(window) = main_window(&state) {
        let _ = window.minimize();
    }
    Json(json!({ "ok": true }))
}

async fn api_toggle_maximize(State(state): State<Arc<AppState>>) -> Json<Value> {
    if let Some(window) = main_window(&state) {
        let _ = crate::window::toggle_maximize(&window);
    }
    Json(json!({ "ok": true }))
}

async fn api_start_drag(State(state): State<Arc<AppState>>) -> Json<Value> {
    if let Some(window) = main_window(&state) {
        let _ = window.start_dragging();
    }
    Json(json!({ "ok": true }))
}

async fn api_close(State(state): State<Arc<AppState>>) -> Json<Value> {
    if let Some(window) = main_window(&state) {
        let _ = window.close();
    }
    Json(json!({ "ok": true }))
}

async fn api_force_close(State(state): State<Arc<AppState>>) -> Json<Value> {
    if let Some(window) = main_window(&state) {
        crate::window::force_close(&window, &state);
    }
    Json(json!({ "ok": true }))
}

async fn api_desktop_state(State(state): State<Arc<AppState>>) -> Json<Value> {
    let maximized = main_window(&state)
        .and_then(|window| window.is_maximized().ok())
        .unwrap_or(false);
    Json(json!({ "maximized": maximized }))
}

// ---------------------------------------------------------------- static assets

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "map" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn static_assets(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let method = req.method();
    if method.as_str() != "GET" && method.as_str() != "HEAD" {
        return ApiError::new(405, "不支持的请求方法").into_response();
    }

    let decoded = percent_encoding::percent_decode_str(req.uri().path())
        .decode_utf8_lossy()
        .to_string();
    let mut name = decoded.trim_start_matches('/').to_string();
    if name.is_empty() {
        name = "index.html".to_string();
    }
    if name
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains('\\'))
    {
        return ApiError::new(403, "禁止访问").into_response();
    }

    let Some(asset) = PublicAssets::get(&name) else {
        return ApiError::new(404, "文件不存在").into_response();
    };

    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = mime_for(&ext);
    let cache = if name.starts_with("vendor/") && ext != "css" && ext != "js" {
        "public, max-age=3600"
    } else {
        "no-store"
    };

    let body_bytes: Vec<u8> = if name.ends_with("index.html") {
        let html = String::from_utf8_lossy(asset.data.as_ref()).to_string();
        let config = json!({
            "token": state.token,
            "desktop": true,
            "home": fsutil::path_string(&fsutil::home_dir()),
            "platform": if cfg!(windows) { "win32" } else { std::env::consts::OS },
            "sep": if cfg!(windows) { "\\" } else { "/" },
            "version": state.version,
            "restrict": state.allowed_root.as_ref().map(|path| fsutil::path_string(path)),
        });
        html.replace(
            "<!--APP_CONFIG-->",
            &format!("<script>window.__FILEDOCK_CONFIG__={};</script>", config),
        )
        .into_bytes()
    } else {
        asset.data.into_owned()
    };

    let length = body_bytes.len();
    let body = if method.as_str() == "HEAD" {
        Body::empty()
    } else {
        Body::from(body_bytes)
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(mime))
        .header(header::CACHE_CONTROL, HeaderValue::from_static(cache))
        .header("x-content-type-options", "nosniff")
        .header(header::CONTENT_LENGTH, length)
        .body(body)
        .unwrap_or_else(|_| ApiError::new(500, "响应生成失败").into_response())
}
