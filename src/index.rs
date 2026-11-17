use crate::fsutil::{self, home_dir, is_inside, natural_cmp, path_string};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use regex::Regex;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::sync::Mutex;

pub const INDEX_VERSION: u32 = 2;
pub const INDEX_TTL: u64 = 10 * 60 * 1000;

const INDEX_EXCLUDED_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "__pycache__",
    ".cache",
    ".npm",
    ".yarn",
    ".pnpm-store",
    "$recycle.bin",
    "system volume information",
    "winsxs",
    "$winreagent",
];

#[derive(Clone)]
pub struct IndexEntry {
    pub p: String,
    pub r: String,
    pub n: String,
    pub name: String,
    pub d: bool,
}

pub struct IndexState {
    pub root: PathBuf,
    pub entries: Vec<IndexEntry>,
    pub status: String,
    pub indexed: usize,
    pub truncated: bool,
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: u64,
    pub cached: bool,
    pub gen: u64,
    pub loaded: bool,
}

impl IndexState {
    fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            entries: Vec::new(),
            status: "empty".to_string(),
            indexed: 0,
            truncated: false,
            error: None,
            started_at: 0,
            finished_at: 0,
            cached: false,
            gen: 0,
            loaded: false,
        }
    }

    pub fn status_json(&self) -> IndexStatus {
        IndexStatus {
            root: path_string(&self.root),
            status: self.status.clone(),
            indexed: self.indexed,
            entries: self.entries.len(),
            building: self.status == "building",
            ready: self.status == "ready",
            truncated: self.truncated,
            error: self.error.clone(),
            started_at: self.started_at,
            finished_at: self.finished_at,
            cached: self.cached,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub root: String,
    pub status: String,
    pub indexed: usize,
    pub entries: usize,
    pub building: bool,
    pub ready: bool,
    pub truncated: bool,
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: u64,
    pub cached: bool,
}

#[derive(Default)]
pub struct IndexManager {
    states: StdMutex<HashMap<String, Arc<Mutex<IndexState>>>>,
}

impl IndexManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn state_for(&self, root: &Path) -> Arc<Mutex<IndexState>> {
        let key = index_root_key(root);
        let mut states = self.states.lock().unwrap_or_else(|e| e.into_inner());
        states
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(IndexState::new(root))))
            .clone()
    }
}

pub fn index_root_key(root: &Path) -> String {
    if cfg!(windows) {
        path_string(root).to_lowercase()
    } else {
        path_string(root)
    }
}

pub fn index_max_entries() -> usize {
    static MAX: OnceLock<usize> = OnceLock::new();
    *MAX.get_or_init(|| {
        let raw = std::env::var("FILEDOCK_INDEX_MAX")
            .or_else(|_| std::env::var("TWINPAD_INDEX_MAX"))
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(500_000);
        raw.max(10_000)
    })
}

pub fn index_dir() -> PathBuf {
    static MIGRATED: AtomicBool = AtomicBool::new(false);
    let base = fsutil::local_app_data();
    let dir = if cfg!(windows) {
        base.join("FileDock").join("index")
    } else {
        home_dir().join(".cache").join("filedock-index")
    };

    if !MIGRATED.swap(true, Ordering::SeqCst) {
        let legacy = if cfg!(windows) {
            base.join("TwinPad").join("index")
        } else {
            home_dir().join(".cache").join("twinpad-index")
        };
        if legacy != dir && !dir.exists() && legacy.exists() {
            let _ = fs::rename(&legacy, &dir);
        }
    }
    dir
}

fn cache_file(root: &Path) -> PathBuf {
    let mut hasher = Sha1::new();
    hasher.update(index_root_key(root).as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    index_dir().join(format!("{}.json.gz", &hash[..20]))
}

// ---------------------------------------------------------------- cache

struct CacheData {
    entries: Vec<IndexEntry>,
    truncated: bool,
    finished_at: u64,
}

fn load_cache_blocking(root: &Path) -> Option<CacheData> {
    let raw = fs::read(cache_file(root)).ok()?;
    let mut decoder = GzDecoder::new(&raw[..]);
    let mut text = String::new();
    decoder.read_to_string(&mut text).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;

    if value.get("version")?.as_u64()? != INDEX_VERSION as u64 {
        return None;
    }
    if index_root_key(Path::new(value.get("root")?.as_str()?)) != index_root_key(root) {
        return None;
    }
    if value.get("maxEntries")?.as_u64()? as usize != index_max_entries() {
        return None;
    }

    let mut entries = Vec::new();
    for row in value.get("entries")?.as_array()? {
        let Some(row) = row.as_array() else { continue };
        let Some(rel) = row.first().and_then(|v| v.as_str()) else {
            continue;
        };
        let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
        let full = root.join(rel.split('/').collect::<PathBuf>());
        entries.push(IndexEntry {
            p: path_string(&full),
            r: rel.to_string(),
            n: name.to_lowercase(),
            name,
            d: row.get(1).and_then(|v| v.as_u64()).unwrap_or(0) != 0,
        });
    }

    Some(CacheData {
        entries,
        truncated: value
            .get("truncated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        finished_at: value
            .get("finishedAt")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

async fn save_cache(state: &Arc<Mutex<IndexState>>) {
    let payload = {
        let st = state.lock().await;
        if st.status != "ready" {
            return;
        }
        #[derive(Serialize)]
        struct CacheOut {
            version: u32,
            root: String,
            #[serde(rename = "maxEntries")]
            max_entries: usize,
            #[serde(rename = "finishedAt")]
            finished_at: u64,
            truncated: bool,
            entries: Vec<(String, u8)>,
        }
        CacheOut {
            version: INDEX_VERSION,
            root: path_string(&st.root),
            max_entries: index_max_entries(),
            finished_at: st.finished_at,
            truncated: st.truncated,
            entries: st
                .entries
                .iter()
                .map(|e| (e.r.clone(), if e.d { 1 } else { 0 }))
                .collect(),
        }
    };
    let root = payload.root.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let Ok(json) = serde_json::to_vec(&payload) else {
            return;
        };
        let dir = index_dir();
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        let Ok(file) = fs::File::create(cache_file(Path::new(&root))) else {
            return;
        };
        let mut encoder = GzEncoder::new(file, Compression::default());
        let _ = encoder.write_all(&json);
        let _ = encoder.finish();
    })
    .await;
}

// ---------------------------------------------------------------- build

fn read_dir_items(dir: &Path) -> Vec<(String, PathBuf, bool)> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for entry in read.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let is_dir = file_type.is_dir();
        if !is_dir && !file_type.is_file() {
            continue;
        }
        items.push((
            entry.file_name().to_string_lossy().to_string(),
            entry.path(),
            is_dir,
        ));
    }
    items
}

fn is_excluded_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    INDEX_EXCLUDED_NAMES.iter().any(|item| *item == lower)
}

async fn cancelled(state: &Arc<Mutex<IndexState>>, gen: u64) -> bool {
    let st = state.lock().await;
    st.gen != gen
}

async fn set_progress(state: &Arc<Mutex<IndexState>>, gen: u64, count: usize) -> bool {
    let mut st = state.lock().await;
    if st.gen != gen {
        return false;
    }
    st.indexed = count;
    true
}

pub async fn start_build(state: Arc<Mutex<IndexState>>, force: bool) {
    let (gen, root) = {
        let mut st = state.lock().await;
        if st.status == "building" && !force {
            return;
        }
        st.gen += 1;
        st.status = "building".to_string();
        st.error = None;
        st.indexed = 0;
        st.truncated = false;
        st.started_at = fsutil::now_ms();
        st.cached = false;
        (st.gen, st.root.clone())
    };
    tokio::spawn(async move {
        build_loop(state, root, gen).await;
    });
}

async fn build_loop(state: Arc<Mutex<IndexState>>, root: PathBuf, gen: u64) {
    let max = index_max_entries();
    let mut collected: Vec<IndexEntry> = Vec::new();
    let mut queue: VecDeque<(PathBuf, String)> = VecDeque::new();
    queue.push_back((root.clone(), String::new()));
    let mut truncated = false;

    'outer: while let Some((dir, rel)) = queue.pop_front() {
        if cancelled(&state, gen).await {
            return;
        }
        let items = match tokio::task::spawn_blocking(move || read_dir_items(&dir)).await {
            Ok(items) => items,
            Err(_) => continue,
        };

        for (name, full, is_dir) in items {
            if is_excluded_name(&name) {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel, name)
            };
            let entry = IndexEntry {
                p: path_string(&full),
                r: child_rel.clone(),
                n: name.to_lowercase(),
                name,
                d: is_dir,
            };
            if is_dir {
                queue.push_back((full, child_rel));
            }
            collected.push(entry);

            if collected.len() % 2048 == 0 {
                if !set_progress(&state, gen, collected.len()).await {
                    return;
                }
                tokio::task::yield_now().await;
            }
            if collected.len() >= max {
                truncated = true;
                break 'outer;
            }
        }
        if !set_progress(&state, gen, collected.len()).await {
            return;
        }
    }

    let indexed = collected.len();
    {
        let mut st = state.lock().await;
        if st.gen != gen {
            return;
        }
        st.entries = collected;
        st.indexed = indexed;
        st.status = "ready".to_string();
        st.finished_at = fsutil::now_ms();
        st.truncated = truncated;
        st.cached = false;
        let secs = (st.finished_at.saturating_sub(st.started_at)) as f64 / 1000.0;
        println!(
            "[index] {} — {} 项，用时 {:.1}s{}",
            path_string(&st.root),
            indexed,
            secs,
            if truncated { "（已达上限）" } else { "" }
        );
    }
    save_cache(&state).await;
}

// ---------------------------------------------------------------- ensure

pub async fn ensure(
    manager: &IndexManager,
    root: &Path,
    start: bool,
    force: bool,
) -> Arc<Mutex<IndexState>> {
    let state = manager.state_for(root);

    let needs_load = {
        let st = state.lock().await;
        !st.loaded
    };
    if needs_load {
        let root_clone = root.to_path_buf();
        let loaded = tokio::task::spawn_blocking(move || load_cache_blocking(&root_clone))
            .await
            .ok()
            .flatten();
        let mut st = state.lock().await;
        if !st.loaded {
            st.loaded = true;
            if let Some(cache) = loaded {
                st.entries = cache.entries;
                st.indexed = st.entries.len();
                st.truncated = cache.truncated;
                st.finished_at = cache.finished_at;
                st.status = "ready".to_string();
                st.cached = true;
            }
        }
    }

    if !start {
        return state;
    }

    let should_start = {
        let st = state.lock().await;
        if st.status == "building" {
            false
        } else {
            force
                || st.entries.is_empty()
                || st.status == "error"
                || (st.status == "ready"
                    && fsutil::now_ms().saturating_sub(st.finished_at) > INDEX_TTL)
        }
    };
    if should_start {
        start_build(state.clone(), force).await;
    }
    state
}

// ---------------------------------------------------------------- search

struct Term {
    term: String,
    regex: Option<Regex>,
}

pub struct IndexHit {
    pub path: String,
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
}

pub struct IndexFound {
    pub results: Vec<IndexHit>,
    pub matched: usize,
    pub has_more: bool,
    pub capped: bool,
}

pub fn search_entries(st: &IndexState, query: &str, limit: usize, dirs: bool) -> IndexFound {
    let q = query.trim().to_lowercase().replace('\\', "/");
    if q.is_empty() {
        return IndexFound {
            results: Vec::new(),
            matched: 0,
            has_more: false,
            capped: false,
        };
    }
    let terms: Vec<Term> = q
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| Term {
            term: term.to_string(),
            regex: if term.contains('*') || term.contains('?') {
                fsutil::glob_regex(term)
            } else {
                None
            },
        })
        .collect();
    if terms.is_empty() {
        return IndexFound {
            results: Vec::new(),
            matched: 0,
            has_more: false,
            capped: false,
        };
    }

    let max_name_hits = 4000;
    let max_path_hits = 2500;
    let mut name_hits: Vec<(&IndexEntry, f64)> = Vec::new();
    let mut path_hits: Vec<(&IndexEntry, f64)> = Vec::new();

    for entry in &st.entries {
        if !dirs && entry.d {
            continue;
        }

        let mut name_score = 0.0f64;
        let mut path_score = 0.0f64;
        let mut all_in_name = true;
        let mut all_matched = true;

        for term in &terms {
            let hit_name = match &term.regex {
                Some(re) => re.is_match(&entry.name),
                None => entry.n.contains(&term.term),
            };
            let hit_path = hit_name
                || match &term.regex {
                    Some(re) => re.is_match(&entry.r),
                    None => entry.r.contains(&term.term),
                };

            if !hit_path {
                all_matched = false;
                break;
            }
            if !hit_name {
                all_in_name = false;
            }

            if hit_name {
                let mut score = if entry.n == term.term {
                    1600.0
                } else if entry.n.starts_with(&term.term) {
                    1100.0
                } else {
                    700.0
                };
                if let Some(at) = entry.n.find(&term.term) {
                    if at > 0 {
                        score -= (at as f64 * 3.0).min(60.0);
                    }
                }
                name_score += score;
                path_score += score;
            } else {
                all_in_name = false;
                path_score += 280.0;
                if entry.r.starts_with(&term.term) {
                    path_score += 80.0;
                }
            }
        }

        if !all_matched {
            continue;
        }

        let bonus = (80.0 - entry.r.len() as f64 / 3.0).max(0.0);
        path_score += bonus;
        if entry.d {
            path_score -= 20.0;
        }

        if all_in_name {
            if name_hits.len() < max_name_hits {
                name_hits.push((
                    entry,
                    name_score + bonus - if entry.d { 20.0 } else { 0.0 },
                ));
            }
        } else if path_hits.len() < max_path_hits {
            path_hits.push((entry, path_score));
        }
    }

    let by_score = |a: &(&IndexEntry, f64), b: &(&IndexEntry, f64)| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.r.len().cmp(&b.0.r.len()))
            .then_with(|| natural_cmp(&a.0.r, &b.0.r))
    };
    name_hits.sort_by(by_score);
    path_hits.sort_by(by_score);

    let matched = name_hits.len() + path_hits.len();
    let combined: Vec<&IndexEntry> = name_hits
        .iter()
        .chain(path_hits.iter())
        .map(|(entry, _)| *entry)
        .collect();
    let results: Vec<IndexHit> = combined
        .iter()
        .take(limit)
        .map(|entry| IndexHit {
            path: entry.p.clone(),
            rel: entry.r.clone(),
            name: entry.name.clone(),
            is_dir: entry.d,
        })
        .collect();

    let saturated = name_hits.len() >= max_name_hits || path_hits.len() >= max_path_hits;
    IndexFound {
        has_more: saturated || combined.len() > results.len(),
        matched: if saturated {
            matched.max(limit)
        } else {
            matched
        },
        results,
        capped: saturated,
    }
}

// ---------------------------------------------------------------- incremental updates

pub enum IndexAction {
    Add,
    Remove,
}

fn relative_slash(root: &Path, full: &Path) -> Option<String> {
    let root_s = path_string(root);
    let full_s = path_string(full);
    let (root_key, full_key) = if cfg!(windows) {
        (root_s.to_lowercase(), full_s.to_lowercase())
    } else {
        (root_s.clone(), full_s.clone())
    };
    if !full_key.starts_with(&root_key) {
        return None;
    }
    let rest = &full_s[root_s.len()..];
    let rest = rest.trim_start_matches(['\\', '/']);
    if rest.is_empty() {
        return None;
    }
    Some(rest.replace('\\', "/"))
}

fn key_inside(target: &str, prefix: &str) -> bool {
    if cfg!(windows) {
        target.to_lowercase().starts_with(&prefix.to_lowercase())
    } else {
        target.starts_with(prefix)
    }
}

pub async fn update_path(manager: &IndexManager, full: &Path, action: IndexAction) {
    let states: Vec<Arc<Mutex<IndexState>>> = {
        let states = manager.states.lock().unwrap_or_else(|e| e.into_inner());
        states.values().cloned().collect()
    };

    let full_s = path_string(full);
    for state in states {
        let mut st = state.lock().await;
        if st.status == "empty" || st.entries.is_empty() {
            continue;
        }
        if !is_inside(&st.root, full) {
            continue;
        }
        match action {
            IndexAction::Add => {
                let Ok(meta) = fs::metadata(full) else { continue };
                let Some(rel) = relative_slash(&st.root, full) else {
                    continue;
                };
                let name = full
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let entry = IndexEntry {
                    p: full_s.clone(),
                    r: rel,
                    n: name.to_lowercase(),
                    name,
                    d: meta.is_dir(),
                };
                if let Some(index) = st.entries.iter().position(|e| e.p == full_s) {
                    st.entries[index] = entry;
                } else {
                    st.entries.push(entry);
                }
                st.indexed = st.entries.len();
            }
            IndexAction::Remove => {
                let sep = if cfg!(windows) { "\\" } else { "/" };
                let prefix = if full_s.ends_with(sep) {
                    full_s.clone()
                } else {
                    format!("{}{}", full_s, sep)
                };
                st.entries
                    .retain(|e| e.p != full_s && !key_inside(&e.p, &prefix));
                st.indexed = st.entries.len();
            }
        }
    }
}
