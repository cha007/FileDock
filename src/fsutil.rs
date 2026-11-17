use crate::error::{ApiError, ApiResult};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_EXCLUDES: &[&str] = &[
    "node_modules/**",
    ".git/**",
    ".svn/**",
    ".hg/**",
    "dist/**",
    "build/**",
    "out/**",
    ".next/**",
    ".nuxt/**",
    "__pycache__/**",
    ".idea/**",
    ".vscode/**",
    ".DS_Store",
    "Thumbs.db",
];

// ---------------------------------------------------------------- paths

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn local_app_data() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| home_dir().join("AppData").join("Local"))
}

pub fn app_data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
}

fn clean_path(path: &Path) -> PathBuf {
    let mut prefix: Option<std::ffi::OsString> = None;
    let mut rooted = false;
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(pre) => prefix = Some(pre.as_os_str().to_os_string()),
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => {
                if !parts.is_empty() {
                    parts.pop();
                }
            }
            Component::Normal(part) => parts.push(part.to_os_string()),
        }
    }
    let mut out = PathBuf::new();
    if let Some(pre) = prefix {
        out.push(pre);
    }
    if rooted {
        out.push(std::path::MAIN_SEPARATOR.to_string());
    }
    for part in parts {
        out.push(part);
    }
    out
}

pub fn resolve_path(raw: Option<&str>, allowed_root: Option<&Path>) -> ApiResult<PathBuf> {
    let raw = raw.unwrap_or("").trim();
    if raw.is_empty() {
        return Err(ApiError::bad_request("缺少路径参数"));
    }
    let mut s = raw.to_string();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s = s[1..s.len() - 1].to_string();
    }

    let home = home_dir();
    let mut path = if s == "~" {
        home.clone()
    } else if s.starts_with("~/") || s.starts_with("~\\") {
        home.join(&s[2..])
    } else {
        let bytes = s.as_bytes();
        if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            PathBuf::from(format!("{}\\", s))
        } else {
            PathBuf::from(&s)
        }
    };

    if path.is_relative() {
        if let Ok(cwd) = std::env::current_dir() {
            path = cwd.join(path);
        }
    }
    let abs = clean_path(&path);

    if let Some(root) = allowed_root {
        if !is_inside(root, &abs) {
            return Err(ApiError::new(403, "路径超出允许的根目录"));
        }
    }
    Ok(abs)
}

pub fn path_key(path: &Path) -> String {
    let cleaned = clean_path(path);
    let text = cleaned.to_string_lossy().to_string();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

pub fn is_inside(root: &Path, target: &Path) -> bool {
    let a = path_key(root);
    let b = path_key(target);
    if b == a {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let prefix = if a.ends_with(&sep) { a } else { a + &sep };
    b.starts_with(&prefix)
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    natord::compare(&a.to_lowercase(), &b.to_lowercase()).then_with(|| a.cmp(b))
}

pub fn parse_list(value: Option<&str>, fallback: &[&str]) -> Vec<String> {
    match value {
        None => fallback.iter().map(|s| s.to_string()).collect(),
        Some(v) if v.is_empty() => fallback.iter().map(|s| s.to_string()).collect(),
        Some(v) => v
            .split([',', '\n'])
            .map(|part| part.trim())
            .filter(|part| !part.is_empty())
            .map(|part| part.to_string())
            .collect(),
    }
}

pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn ctime_ms(meta: &fs::Metadata) -> f64 {
    meta.created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- glob

pub fn glob_regex(glob: &str) -> Option<Regex> {
    let mut s = glob.trim().replace('\\', "/");
    if s.is_empty() {
        return None;
    }
    if !s.contains('/') {
        s = format!("**/{}", s);
    }
    let chars: Vec<char> = s.chars().collect();
    let mut re = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if i + 1 < chars.len() && chars[i + 1] == '*' {
                i += 1;
                if i + 1 < chars.len() && chars[i + 1] == '/' {
                    i += 1;
                    re.push_str("(?:[^/]+/)*");
                } else {
                    re.push_str(".*");
                }
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else {
            re.push_str(&regex::escape(&c.to_string()));
        }
        i += 1;
    }
    RegexBuilder::new(&format!("^{}$", re))
        .case_insensitive(true)
        .build()
        .ok()
}

pub struct GlobSet {
    regexes: Vec<Regex>,
}

impl GlobSet {
    pub fn new(patterns: &[String]) -> Self {
        Self {
            regexes: patterns.iter().filter_map(|p| glob_regex(p)).collect(),
        }
    }

    pub fn is_match(&self, rel: &str, name: &str) -> bool {
        self.regexes
            .iter()
            .any(|re| re.is_match(rel) || re.is_match(name))
    }
}

// ---------------------------------------------------------------- read / write

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub name: String,
    pub content: String,
    pub encoding: String,
    pub eol: String,
    pub size: u64,
    pub mtime: f64,
    pub read_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub size: u64,
    pub mtime: f64,
    pub encoding: String,
    pub converted: bool,
}

pub fn detect_eol(text: &str) -> String {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut cr = 0usize;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                crlf += 1;
                i += 2;
                continue;
            }
            cr += 1;
        } else if bytes[i] == b'\n' {
            lf += 1;
        }
        i += 1;
    }
    if crlf > 0 && crlf >= lf && crlf >= cr {
        "CRLF".to_string()
    } else if lf > 0 && lf >= cr {
        "LF".to_string()
    } else if cr > 0 {
        "CR".to_string()
    } else {
        "LF".to_string()
    }
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn read_text_file(file: &Path) -> ApiResult<TextFile> {
    let meta = fs::metadata(file)?;
    if meta.is_dir() {
        return Err(ApiError::bad_request("这是一个文件夹"));
    }
    if meta.len() > 64 * 1024 * 1024 {
        return Err(ApiError::new(413, "文件超过 64MB，无法在编辑器中打开"));
    }
    let buf = fs::read(file)?;

    let mut encoding = "utf8".to_string();
    let content = if buf.len() >= 3 && buf[0] == 0xef && buf[1] == 0xbb && buf[2] == 0xbf {
        encoding = "utf8bom".to_string();
        String::from_utf8_lossy(&buf[3..]).to_string()
    } else if buf.len() >= 2 && buf[0] == 0xff && buf[1] == 0xfe {
        encoding = "utf16le".to_string();
        decode_utf16(&buf[2..], true)
    } else if buf.len() >= 2 && buf[0] == 0xfe && buf[1] == 0xff {
        encoding = "utf16be".to_string();
        decode_utf16(&buf[2..], false)
    } else {
        let head = &buf[..buf.len().min(8192)];
        if head.contains(&0) {
            return Err(ApiError::new(415, "这是二进制文件，无法以文本方式打开").with_code("BINARY"));
        }
        match std::str::from_utf8(&buf) {
            Ok(text) => text.to_string(),
            Err(_) => match encoding_rs::GBK.decode_without_bom_handling_and_without_replacement(&buf) {
                Some(text) => {
                    encoding = "gbk".to_string();
                    text.to_string()
                }
                None => String::from_utf8_lossy(&buf).to_string(),
            },
        }
    };

    let eol = detect_eol(&content);
    let content = normalize_newlines(&content);
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(TextFile {
        path: path_string(file),
        name,
        content,
        encoding,
        eol,
        size: meta.len(),
        mtime: mtime_ms(&meta),
        read_only: false,
    })
}

pub fn write_text_file(
    file: &Path,
    content: &str,
    encoding: &str,
    eol: &str,
) -> ApiResult<WriteResult> {
    let normalized = normalize_newlines(content);
    let text = match eol {
        "CRLF" => normalized.replace('\n', "\r\n"),
        "CR" => normalized.replace('\n', "\r"),
        _ => normalized,
    };

    let (buf, saved_encoding) = match encoding {
        "utf8bom" => {
            let mut bytes = vec![0xef, 0xbb, 0xbf];
            bytes.extend_from_slice(text.as_bytes());
            (bytes, "utf8bom")
        }
        "utf16le" => {
            let mut bytes = Vec::with_capacity(text.len() * 2);
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            (bytes, "utf16le")
        }
        "utf16be" => {
            let mut bytes = Vec::with_capacity(text.len() * 2);
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&unit.to_be_bytes());
            }
            (bytes, "utf16be")
        }
        "gbk" => (text.as_bytes().to_vec(), "utf8"),
        _ => (text.as_bytes().to_vec(), "utf8"),
    };

    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = fs::metadata(file) {
        if meta.is_dir() {
            return Err(ApiError::bad_request("目标是一个文件夹"));
        }
    }
    fs::write(file, &buf)?;
    let meta = fs::metadata(file)?;

    Ok(WriteResult {
        path: path_string(file),
        size: meta.len(),
        mtime: mtime_ms(&meta),
        encoding: saved_encoding.to_string(),
        converted: saved_encoding != encoding,
    })
}

// ---------------------------------------------------------------- directory listing

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: f64,
    pub ext: String,
}

#[derive(Serialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntryInfo>,
}

fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(idx) if idx > 0 => name[idx + 1..].to_lowercase(),
        _ => String::new(),
    }
}

pub fn list_dir(dir: &Path) -> ApiResult<DirListing> {
    let meta = fs::metadata(dir)?;
    if !meta.is_dir() {
        return Err(ApiError::bad_request("不是文件夹"));
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() {
            continue;
        }
        let full = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        out.push(DirEntryInfo {
            ext: extension_of(&name),
            name,
            path: path_string(&full),
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime: mtime_ms(&meta),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => natural_cmp(&a.name, &b.name),
    });
    let parent = dir.parent().filter(|p| *p != dir).map(path_string);
    Ok(DirListing {
        path: path_string(dir),
        parent,
        entries: out,
    })
}

#[derive(Serialize)]
pub struct Shortcut {
    pub key: &'static str,
    pub path: String,
}

#[derive(Serialize)]
pub struct Roots {
    pub roots: Vec<String>,
    pub home: String,
    pub platform: &'static str,
    pub sep: &'static str,
    pub shortcuts: Vec<Shortcut>,
    pub restricted: Option<String>,
}

pub fn list_roots(allowed_root: Option<&Path>) -> Roots {
    let mut roots = Vec::new();
    if cfg!(windows) {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                roots.push(drive);
            }
        }
    } else {
        roots.push("/".to_string());
    }
    let home = home_dir();
    let candidates = [
        ("home", home.clone()),
        ("desktop", home.join("Desktop")),
        ("documents", home.join("Documents")),
        ("downloads", home.join("Downloads")),
    ];
    let shortcuts = candidates
        .into_iter()
        .filter(|(_, path)| path.is_dir())
        .map(|(key, path)| Shortcut {
            key,
            path: path_string(&path),
        })
        .collect();
    Roots {
        roots,
        home: path_string(&home),
        platform: if cfg!(windows) { "win32" } else { std::env::consts::OS },
        sep: if cfg!(windows) { "\\" } else { "/" },
        shortcuts,
        restricted: allowed_root.map(path_string),
    }
}

// ---------------------------------------------------------------- recursive walk

pub struct WalkEntry {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: f64,
}

pub struct WalkResult {
    pub map: BTreeMap<String, WalkEntry>,
    pub truncated: bool,
}

struct WalkCtx<'a> {
    map: BTreeMap<String, WalkEntry>,
    includes: &'a GlobSet,
    excludes: &'a GlobSet,
    include_all: bool,
    max_entries: usize,
    count: usize,
    truncated: bool,
}

impl WalkCtx<'_> {
    fn recurse(&mut self, dir: &Path, rel: &str) {
        if self.truncated {
            return;
        }
        let Ok(read) = fs::read_dir(dir) else { return };
        let mut items: Vec<(String, PathBuf, bool)> = Vec::new();
        for entry in read {
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            if !file_type.is_dir() && !file_type.is_file() {
                continue;
            }
            items.push((
                entry.file_name().to_string_lossy().to_string(),
                entry.path(),
                file_type.is_dir(),
            ));
        }
        items.sort_by(|a, b| match (a.2, b.2) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => natural_cmp(&a.0, &b.0),
        });

        for (name, full, is_dir) in items {
            if self.truncated {
                return;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel, name)
            };
            if self.excludes.is_match(&child_rel, &name) {
                continue;
            }
            if is_dir {
                self.map.insert(
                    child_rel.clone(),
                    WalkEntry {
                        rel: child_rel.clone(),
                        name,
                        is_dir: true,
                        size: 0,
                        mtime: 0.0,
                    },
                );
                self.count += 1;
                if self.count >= self.max_entries {
                    self.truncated = true;
                    return;
                }
                self.recurse(&full, &child_rel);
            } else {
                if !self.include_all && !self.includes.is_match(&child_rel, &name) {
                    continue;
                }
                let Ok(meta) = fs::metadata(&full) else { continue };
                self.map.insert(
                    child_rel.clone(),
                    WalkEntry {
                        rel: child_rel.clone(),
                        name,
                        is_dir: false,
                        size: meta.len(),
                        mtime: mtime_ms(&meta),
                    },
                );
                self.count += 1;
                if self.count >= self.max_entries {
                    self.truncated = true;
                    return;
                }
            }
        }
    }
}

pub fn walk_tree(
    root: &Path,
    include: &[String],
    exclude: &[String],
    max_entries: usize,
) -> WalkResult {
    let excludes = GlobSet::new(exclude);
    let includes = GlobSet::new(include);
    let include_all = include.is_empty() || include.iter().any(|p| p.trim() == "*");
    let mut ctx = WalkCtx {
        map: BTreeMap::new(),
        includes: &includes,
        excludes: &excludes,
        include_all,
        max_entries: max_entries.max(1),
        count: 0,
        truncated: false,
    };
    ctx.recurse(root, "");
    WalkResult {
        map: ctx.map,
        truncated: ctx.truncated,
    }
}

// ---------------------------------------------------------------- hashing

pub fn hash_file(file: &Path) -> ApiResult<String> {
    let mut handle = fs::File::open(file)?;
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 65536];
    loop {
        let read = handle.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// ---------------------------------------------------------------- content search

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: usize,
    pub col: usize,
    pub length: usize,
    pub text: String,
}

#[derive(Serialize)]
pub struct SearchFileResult {
    pub path: String,
    pub rel: String,
    pub name: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub query: String,
    pub results: Vec<SearchFileResult>,
    pub total: usize,
    pub files: usize,
    pub truncated: bool,
}

pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub whole_word: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub max_results: Option<usize>,
}

fn build_regex(
    find: &str,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
) -> ApiResult<Regex> {
    let mut source = if use_regex {
        find.to_string()
    } else {
        regex::escape(find)
    };
    if whole_word {
        source = format!("\\b(?:{})\\b", source);
    }
    RegexBuilder::new(&source)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|err| ApiError::bad_request(format!("正则表达式无效：{}", err)))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn utf16_prefix_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn search_files(root: &Path, query: &str, options: SearchOptions) -> ApiResult<SearchResponse> {
    if query.is_empty() {
        return Err(ApiError::bad_request("请输入搜索内容"));
    }
    let re = build_regex(
        query,
        options.case_sensitive,
        options.regex,
        options.whole_word,
    )?;
    let max_results = match options.max_results {
        Some(value) if value > 0 => value.min(5000),
        _ => 500,
    };

    let walk = walk_tree(root, &options.include, &options.exclude, 20000);
    let mut results = Vec::new();
    let mut total = 0usize;
    let mut scanned = 0usize;
    let mut truncated = walk.truncated;

    for entry in walk.map.values() {
        if entry.is_dir || entry.size > 4 * 1024 * 1024 {
            continue;
        }
        if total >= max_results {
            truncated = true;
            break;
        }
        let full = root.join(entry.rel.split('/').collect::<PathBuf>());
        let Ok(data) = read_text_file(&full) else { continue };
        scanned += 1;

        let mut matches = Vec::new();
        'lines: for (index, line) in data.content.split('\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            for hit in re.find_iter(line).take(21) {
                let text = if line.chars().count() > 400 {
                    format!("{}…", line.chars().take(400).collect::<String>())
                } else {
                    line.to_string()
                };
                matches.push(SearchMatch {
                    line: index + 1,
                    col: utf16_prefix_len(&line[..hit.start()]) + 1,
                    length: utf16_len(hit.as_str()),
                    text,
                });
                total += 1;
                if total >= max_results {
                    truncated = true;
                    break 'lines;
                }
            }
        }
        if !matches.is_empty() {
            results.push(SearchFileResult {
                path: path_string(&full),
                rel: entry.rel.clone(),
                name: entry.name.clone(),
                matches,
            });
        }
    }

    Ok(SearchResponse {
        query: query.to_string(),
        results,
        total,
        files: scanned,
        truncated,
    })
}

// ---------------------------------------------------------------- replace

#[derive(Serialize)]
pub struct ReplaceChange {
    pub path: String,
    pub rel: String,
    pub count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResponse {
    pub changed: Vec<ReplaceChange>,
    pub changed_files: usize,
    pub replacements: usize,
}

fn expand_replacement(template: &str, caps: &regex::Captures) -> String {
    let mut out = String::new();
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit() {
            let digit = chars[i + 1] as usize - '0' as usize;
            if digit >= 1 {
                if let Some(group) = caps.get(digit) {
                    out.push_str(group.as_str());
                }
                i += 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn replace_in_files(
    root: &Path,
    find: &str,
    replace: &str,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    include: Vec<String>,
    exclude: Vec<String>,
) -> ApiResult<ReplaceResponse> {
    if find.is_empty() {
        return Err(ApiError::bad_request("请输入查找内容"));
    }
    let re = build_regex(find, case_sensitive, use_regex, whole_word)?;
    let walk = walk_tree(root, &include, &exclude, 20000);

    let mut changed = Vec::new();
    let mut changed_files = 0usize;
    let mut replacements = 0usize;

    for entry in walk.map.values() {
        if entry.is_dir || entry.size > 8 * 1024 * 1024 {
            continue;
        }
        if changed_files >= 500 {
            break;
        }
        let full = root.join(entry.rel.split('/').collect::<PathBuf>());
        let Ok(data) = read_text_file(&full) else { continue };
        if !re.is_match(&data.content) {
            continue;
        }

        let mut out = String::with_capacity(data.content.len());
        let mut last = 0usize;
        let mut count = 0usize;
        for caps in re.captures_iter(&data.content) {
            let Some(hit) = caps.get(0) else { continue };
            out.push_str(&data.content[last..hit.start()]);
            if use_regex {
                out.push_str(&expand_replacement(replace, &caps));
            } else {
                out.push_str(replace);
            }
            last = hit.end();
            count += 1;
        }
        out.push_str(&data.content[last..]);

        if count > 0 && out != data.content {
            write_text_file(&full, &out, &data.encoding, &data.eol)?;
            replacements += count;
            changed_files += 1;
            changed.push(ReplaceChange {
                path: path_string(&full),
                rel: entry.rel.clone(),
                count,
            });
        }
    }

    Ok(ReplaceResponse {
        changed,
        changed_files,
        replacements,
    })
}

// ---------------------------------------------------------------- folder diff

#[derive(Serialize)]
pub struct SideInfo {
    pub size: u64,
    pub mtime: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<SideInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<SideInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub same: usize,
    pub modified: usize,
    pub left_only: usize,
    pub right_only: usize,
    pub dirs: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    pub left: String,
    pub right: String,
    pub mode: String,
    pub entries: Vec<DiffEntry>,
    pub summary: DiffSummary,
    pub truncated: bool,
    pub max_entries: usize,
}

pub fn diff_dirs(
    left: &Path,
    right: &Path,
    mode: &str,
    include: Vec<String>,
    exclude: Vec<String>,
) -> ApiResult<DiffResponse> {
    if path_key(left) == path_key(right) {
        return Err(ApiError::bad_request("左右目录相同"));
    }
    let l_meta = fs::metadata(left)?;
    let r_meta = fs::metadata(right)?;
    if !l_meta.is_dir() || !r_meta.is_dir() {
        return Err(ApiError::bad_request("请选择两个文件夹"));
    }

    let max_entries = 20000;
    let l_walk = walk_tree(left, &include, &exclude, max_entries);
    let r_walk = walk_tree(right, &include, &exclude, max_entries);

    let mut rels: BTreeSet<String> = BTreeSet::new();
    rels.extend(l_walk.map.keys().cloned());
    rels.extend(r_walk.map.keys().cloned());
    let mut rels: Vec<String> = rels.into_iter().collect();
    rels.sort_by(|a, b| natural_cmp(a, b));

    let posix_name = |rel: &str| rel.rsplit('/').next().unwrap_or(rel).to_string();
    let mut entries = Vec::new();
    let mut summary = DiffSummary {
        same: 0,
        modified: 0,
        left_only: 0,
        right_only: 0,
        dirs: 0,
    };
    let fast = mode == "fast";

    for rel in rels {
        let l = l_walk.map.get(&rel);
        let r = r_walk.map.get(&rel);
        let is_dir = l.map(|e| e.is_dir).unwrap_or(false) || r.map(|e| e.is_dir).unwrap_or(false);
        if is_dir {
            summary.dirs += 1;
            let status = if l.is_some() && r.is_some() {
                "dir"
            } else if l.is_some() {
                "left-only"
            } else {
                "right-only"
            };
            entries.push(DiffEntry {
                rel: rel.clone(),
                name: posix_name(&rel),
                is_dir: true,
                status: status.to_string(),
                left: None,
                right: None,
            });
            continue;
        }

        if l.is_none() {
            summary.right_only += 1;
            entries.push(DiffEntry {
                rel: rel.clone(),
                name: r.map(|e| e.name.clone()).unwrap_or_else(|| posix_name(&rel)),
                is_dir: false,
                status: "right-only".to_string(),
                left: None,
                right: r.map(|e| SideInfo {
                    size: e.size,
                    mtime: e.mtime,
                }),
            });
            continue;
        }
        if r.is_none() {
            summary.left_only += 1;
            entries.push(DiffEntry {
                rel: rel.clone(),
                name: l.map(|e| e.name.clone()).unwrap_or_else(|| posix_name(&rel)),
                is_dir: false,
                status: "left-only".to_string(),
                left: l.map(|e| SideInfo {
                    size: e.size,
                    mtime: e.mtime,
                }),
                right: None,
            });
            continue;
        }

        let (l, r) = (l.unwrap(), r.unwrap());
        let mut status = "same";
        if l.size != r.size {
            status = "modified";
        } else if fast {
            if (l.mtime - r.mtime).abs() > 2000.0 {
                status = "modified";
            }
        } else if l.size > 32 * 1024 * 1024 {
            if (l.mtime - r.mtime).abs() > 2000.0 {
                status = "modified";
            }
        } else {
            let lh = hash_file(&left.join(rel.split('/').collect::<PathBuf>()))?;
            let rh = hash_file(&right.join(rel.split('/').collect::<PathBuf>()))?;
            if lh != rh {
                status = "modified";
            }
        }
        if status == "same" {
            summary.same += 1;
        } else {
            summary.modified += 1;
        }
        entries.push(DiffEntry {
            rel: rel.clone(),
            name: posix_name(&rel),
            is_dir: false,
            status: status.to_string(),
            left: Some(SideInfo {
                size: l.size,
                mtime: l.mtime,
            }),
            right: Some(SideInfo {
                size: r.size,
                mtime: r.mtime,
            }),
        });
    }

    Ok(DiffResponse {
        left: path_string(left),
        right: path_string(right),
        mode: if fast { "fast" } else { "content" }.to_string(),
        entries,
        summary,
        truncated: l_walk.truncated || r_walk.truncated,
        max_entries,
    })
}
