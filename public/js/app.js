import { api, config } from './api.js';
import { FileDockEditor, languageFor, duplicateLines, deleteLines } from './editor.js';
import { previewKind, renderPreview } from './preview.js';
import { CompareView, DEFAULT_COMPARE_OPTIONS, DEFAULT_FOLDER_STATE } from './compare.js';
import { Explorer } from './explorer.js';
import {
  h, icon, hydrateIcons, toast, openModal, confirmDialog, promptDialog, pickPath,
  saveChangesDialog, baseName, dirName, joinPath, debounce, fuzzyMatch, escapeHtml,
  showContextMenu, clear, formatBytes,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const isWin = config.platform === 'win32';
const pkey = (p) => (isWin ? String(p || '').toLowerCase() : String(p || ''));
const samePath = (a, b) => !!a && !!b && pkey(a) === pkey(b);
const insidePath = (child, parent) => {
  if (!child || !parent) return false;
  const c = pkey(child);
  const p = pkey(parent);
  if (c === p) return true;
  const sep = config.sep || '/';
  return c.startsWith(p.endsWith('\\') || p.endsWith('/') ? p : p + sep);
};

const SETTINGS_KEY = 'filedock.settings.v1';
const SESSION_KEY = 'filedock.session.v1';
const RECENT_KEY = 'filedock.recent.v1';

// The app shipped once as TwinPad. Carry the old keys over so settings, recent
// files and the restored session survive the rename.
function migrateLegacyStorage() {
  const legacy = [
    ['twinpad.settings.v1', SETTINGS_KEY],
    ['twinpad.session.v1', SESSION_KEY],
    ['twinpad.recent.v1', RECENT_KEY],
  ];
  for (const [from, to] of legacy) {
    try {
      const value = localStorage.getItem(from);
      if (value && !localStorage.getItem(to)) localStorage.setItem(to, value);
    } catch { /* storage unavailable: defaults are fine */ }
  }
}

migrateLegacyStorage();

const DEFAULT_SETTINGS = {
  theme: 'dark',
  fontSize: 14,
  tabSize: 4,
  spaces: true,
  wrap: false,
  autosave: false,
  showTrailing: false,
  restore: true,
  sidebarWidth: 276,
  sidebarVisible: true,
  search: { caseSensitive: false, wholeWord: false, regex: false },
  compare: { ...DEFAULT_COMPARE_OPTIONS },
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val && typeof val === 'object' ? val : fallback;
  } catch {
    return fallback;
  }
}

function loadSettings() {
  const saved = loadJson(SETTINGS_KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    search: { ...DEFAULT_SETTINGS.search, ...(saved.search || {}) },
    compare: { ...DEFAULT_SETTINGS.compare, ...(saved.compare || {}) },
  };
}

let settings = loadSettings();

const state = {
  info: null,
  home: '',
  appRoot: '',
  demoRoot: '',
  root: '',
  tabs: [],
  activeId: null,
  activePane: 'welcome',
  sidebar: 'explorer',
  ready: false,
  untitledSeq: 1,
  lastSearch: null,
  recent: {
    files: [],
    roots: [],
    compares: [],
  },
};

const tabEls = new Map();
const autoSaveTimers = new Map();
const searchCollapsed = new Set();
let suppressDocEvents = false;
let editor = null;
let explorer = null;
let compareView = null;
let tabSeq = 0;
let wizardSeq = 1;
let openMenuEl = null;

const dom = {};

// ------------------------------------------------------------------ init

async function init() {
  cacheDom();
  hydrateIcons();
  applyTheme();
  loadRecents();
  initEditor();
  initCompare();
  initExplorer();
  initMenus();
  initSidebar();
  initGlobalClicks();
  initDragAndDrop();
  initSearchPanel();
  initStatusbar();
  initWelcome();
  initGlobalShortcuts();
  initResizer();
  initDesktop();
  applySettings();

  try {
    state.info = await api.info();
    state.home = state.info.home || '';
    state.appRoot = state.info.appRoot || '';
    state.demoRoot = state.info.demoRoot || '';
  } catch (err) {
    toast('无法连接本地服务：' + err.message, 'error', 6000);
  }

  await restoreSession();
  applySettings();
  state.ready = true;
  if (!state.tabs.length) showWelcome();
  updateUi();
  persistSession();
}

function cacheDom() {
  dom.tabstrip = $('tabstrip');
  dom.content = $('content');
  dom.welcome = $('welcome');
  dom.editorPane = $('editorPane');
  dom.comparePane = $('comparePane');
  dom.sidebar = $('sidebar');
  dom.resizer = $('sidebarResizer');
  dom.menubar = $('menubar');
  dom.breadcrumb = $('breadcrumb');
  dom.statusPath = $('statusPath');
  dom.statCursor = $('statCursor');
  dom.statSel = $('statSel');
  dom.statIndent = $('statIndent');
  dom.statEncoding = $('statEncoding');
  dom.statEol = $('statEol');
  dom.statLang = $('statLang');
  dom.statSize = $('statSize');
  dom.statDirty = $('statDirty');
  dom.explorerTree = $('explorerTree');
  dom.explorerEmpty = $('explorerEmpty');
  dom.rootName = $('exRootName');
  dom.rootPath = $('exRootPath');
  dom.rootBar = $('exRootBar');
  dom.searchInput = $('searchInput');
  dom.searchResults = $('searchResults');
  dom.searchSummary = $('searchSummary');
}

// ------------------------------------------------------------------ theme & settings

function resolvedTheme() {
  if (settings.theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return settings.theme;
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  const btn = $('btnTheme');
  if (btn) {
    const name = settings.theme === 'dark' ? 'sun' : settings.theme === 'light' ? 'moon' : 'monitor';
    btn.innerHTML = icon(name).outerHTML;
    btn.title = settings.theme === 'dark' ? '切换到浅色主题' : settings.theme === 'light' ? '切换到深色主题' : '跟随系统主题';
  }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme();
});

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* storage full */ }
}

function applySettings() {
  document.documentElement.style.setProperty('--editor-font-size', settings.fontSize + 'px');
  if (dom.sidebar) {
    dom.sidebar.style.width = settings.sidebarWidth + 'px';
    dom.sidebar.hidden = !settings.sidebarVisible;
  }
  if (dom.resizer) dom.resizer.hidden = !settings.sidebarVisible;
  const sideBtn = $('btnSidebar');
  if (sideBtn) sideBtn.classList.toggle('active', settings.sidebarVisible);
  if (editor) {
    editor.setOption('lineWrapping', !!settings.wrap);
    editor.setOption('showTrailingSpace', !!settings.showTrailing);
    editor.setOption('indentUnit', settings.tabSize);
    editor.setOption('tabSize', settings.tabSize);
    editor.refresh();
  }
  applyTheme();
}

function cycleTheme() {
  settings.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
  saveSettings();
  applyTheme();
  toast(settings.theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'info', 1400);
}

function changeFont(delta) {
  settings.fontSize = Math.max(10, Math.min(28, settings.fontSize + delta));
  saveSettings();
  applySettings();
}

// ------------------------------------------------------------------ recents & session

function loadRecents() {
  const data = loadJson(RECENT_KEY, {});
  state.recent = {
    files: Array.isArray(data.files) ? data.files.filter((x) => typeof x === 'string') : [],
    roots: Array.isArray(data.roots) ? data.roots.filter((x) => typeof x === 'string') : [],
    compares: Array.isArray(data.compares) ? data.compares.filter((x) => x && x.mode && x.left && x.right) : [],
  };
}

function saveRecents() {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
  } catch { /* ignore */ }
}

function addRecentFile(path) {
  if (!path) return;
  state.recent.files = [path, ...state.recent.files.filter((p) => !samePath(p, path))].slice(0, 15);
  saveRecents();
  if (!dom.welcome.hidden) renderWelcome();
}

function addRecentRoot(path) {
  if (!path) return;
  state.recent.roots = [path, ...state.recent.roots.filter((p) => !samePath(p, path))].slice(0, 10);
  saveRecents();
  if (!dom.welcome.hidden) renderWelcome();
}

function addRecentCompare(compare) {
  const entry = { mode: compare.mode, left: compare.left, right: compare.right, ts: Date.now() };
  state.recent.compares = [
    entry,
    ...state.recent.compares.filter((c) => c.mode !== entry.mode || !samePath(c.left, entry.left) || !samePath(c.right, entry.right)),
  ].slice(0, 12);
  saveRecents();
  renderRecentCompares();
}

const persistSession = debounce(() => {
  if (!state.ready) return;
  saveActiveView();
  const activeIndex = Math.max(0, state.tabs.findIndex((t) => t.id === state.activeId));
  const data = {
    root: state.root,
    sidebar: state.sidebar,
    activeIndex,
    tabs: state.tabs.slice(0, 16).map((tab) => {
      if (tab.kind === 'editor') {
        if (tab.path) {
          return {
            kind: 'editor', path: tab.path, cursor: tab.cursor, scroll: tab.scroll,
            encoding: tab.encoding, eol: tab.eol,
          };
        }
        const content = tab.doc.getValue();
        return {
          kind: 'editor', untitled: true, name: tab.name,
          content: content.length <= 200000 ? content : '',
        };
      }
      return {
        kind: 'compare',
        compare: {
          mode: tab.compare.mode, left: tab.compare.left, right: tab.compare.right,
          include: tab.compare.include, exclude: tab.compare.exclude,
          options: tab.compare.options,
        },
      };
    }),
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch { /* ignore */ }
}, 450);

async function restoreSession() {
  let session = null;
  if (settings.restore) {
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
  }

  let root = (session && typeof session.root === 'string') ? session.root : '';
  if (!root || !state.home) root = state.home;
  if (root) {
    try {
      await api.list(root);
      state.root = root;
    } catch {
      state.root = state.home;
    }
  }
  if (state.root) await explorer.setRoot(state.root);

  if (session && session.sidebar) switchSidebar(session.sidebar, { silent: true });

  let missing = 0;
  if (session && Array.isArray(session.tabs)) {
    for (const item of session.tabs.slice(0, 16)) {
      if (!item || typeof item !== 'object') continue;
      if (item.kind === 'editor' && item.path) {
        try {
          const data = await api.read(item.path);
          addEditorTab(item.path, data, {
            activate: false,
            cursor: item.cursor || null,
            scroll: item.scroll || null,
          });
          if (item.encoding && item.encoding !== data.encoding) { /* keep detected */ }
        } catch {
          missing++;
        }
      } else if (item.kind === 'editor' && item.untitled) {
        addUntitledTab(item.name || '未命名.txt', item.content || '', { activate: false, dirty: !!item.content });
      } else if (item.kind === 'compare' && item.compare) {
        addCompareTab(item.compare, { activate: false, persist: false });
      }
    }
  }

  if (state.tabs.length) {
    let idx = session && Number.isInteger(session.activeIndex) ? session.activeIndex : 0;
    idx = Math.max(0, Math.min(idx, state.tabs.length - 1));
    activateTab(state.tabs[idx].id);
  }
  if (missing) toast(`有 ${missing} 个文件无法恢复（可能已被移动或删除）`, 'warn', 4200);
}

// ------------------------------------------------------------------ editor tabs

function initEditor() {
  editor = new FileDockEditor({
    textarea: $('editor'),
    onChange: null,
    onCursor: (cm) => updateCursor(cm),
    onFocus: null,
  });
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function activeEditorTab() {
  const tab = activeTab();
  return tab && tab.kind === 'editor' ? tab : null;
}

function activeCompareTab() {
  const tab = activeTab();
  return tab && tab.kind === 'compare' ? tab : null;
}

function isDirty(tab) {
  if (!tab || tab.kind !== 'editor') return false;
  return !!tab.metaDirty || !tab.doc.isClean(tab.cleanGen);
}

function nextTabId() {
  tabSeq++;
  return 'tab-' + tabSeq;
}

function nextUntitledName() {
  let n = state.untitledSeq;
  let name = `未命名-${n}.txt`;
  while (state.tabs.some((t) => t.kind === 'editor' && !t.path && t.name === name)) {
    n++;
    state.untitledSeq = n;
    name = `未命名-${n}.txt`;
  }
  state.untitledSeq = n + 1;
  return name;
}

function addEditorTab(path, data, { activate = true, cursor = null, scroll = null } = {}) {
  const { doc, lang } = editor.createDoc(data.content, path);
  const tab = {
    id: nextTabId(),
    kind: 'editor',
    path,
    name: baseName(path),
    doc,
    lang,
    encoding: data.encoding || 'utf8',
    eol: data.eol || 'LF',
    cleanGen: doc.changeGeneration(),
    metaDirty: false,
    size: data.size || 0,
    mtime: data.mtime || 0,
    tabSize: settings.tabSize,
    indentWithTabs: !settings.spaces,
    cursor: cursor || { line: 0, ch: 0 },
    scroll: scroll || { left: 0, top: 0 },
  };
  if (cursor) doc.setCursor(cursor);
  doc.on('change', () => onDocChange(tab));
  state.tabs.push(tab);
  if (activate) activateTab(tab.id);
  else renderTabs();
  return tab;
}

function addUntitledTab(name, content = '', { activate = true, dirty = false } = {}) {
  const tabName = name || nextUntitledName();
  // The name still drives syntax highlighting (e.g. a dropped .md file).
  const { doc, lang } = editor.createDoc(content, tabName);
  const tab = {
    id: nextTabId(),
    kind: 'editor',
    path: null,
    name: tabName,
    doc,
    lang,
    encoding: 'utf8',
    eol: 'LF',
    cleanGen: doc.changeGeneration(),
    metaDirty: !!dirty,
    size: 0,
    mtime: 0,
    tabSize: settings.tabSize,
    indentWithTabs: !settings.spaces,
    cursor: { line: 0, ch: 0 },
    scroll: { left: 0, top: 0 },
  };
  doc.on('change', () => onDocChange(tab));
  state.tabs.push(tab);
  if (activate) activateTab(tab.id);
  else renderTabs();
  return tab;
}

function onDocChange(tab) {
  if (suppressDocEvents) return;
  updateTabVisual(tab);
  if (tab.id === state.activeId) {
    updateStatus();
    updateWindowTitle();
    if (tab.preview) schedulePreview(tab);
  }
  if (settings.autosave && tab.path) scheduleAutoSave(tab);
  persistSession();
}

function markMetaDirty(tab) {
  tab.metaDirty = true;
  updateTabVisual(tab);
  updateStatus();
  persistSession();
}

function scheduleAutoSave(tab) {
  if (!settings.autosave || !tab.path) return;
  clearTimeout(autoSaveTimers.get(tab.id));
  autoSaveTimers.set(tab.id, setTimeout(() => {
    autoSaveTimers.delete(tab.id);
    if (isDirty(tab)) saveTab(tab, { quiet: true });
  }, 1400));
}

function updateTabVisual(tab) {
  const el = tabEls.get(tab.id);
  if (el) el.classList.toggle('dirty', isDirty(tab));
  if (tab.id === state.activeId) {
    dom.statDirty.hidden = !isDirty(tab);
    updateWindowTitle();
  }
}

function newFile() {
  const name = nextUntitledName();
  addUntitledTab(name, '');
}

async function openFile(path, { line = 0, ch = 1, length = 0, reveal = true } = {}) {
  if (!path) return null;
  const existing = state.tabs.find((t) => t.kind === 'editor' && t.path && samePath(t.path, path));
  if (existing) {
    activateTab(existing.id);
    if (line) focusPosition(existing, line, ch, length);
    return existing;
  }
  try {
    const data = await api.read(path);
    if (data.size > 8 * 1024 * 1024) {
      const ok = await confirmDialog({
        title: '打开较大的文件',
        message: `该文件约 ${formatBytes(data.size)}，打开可能会占用较多内存。`,
        confirmText: '仍然打开',
      });
      if (!ok) return null;
    }
    const tab = addEditorTab(path, data, { activate: true });
    addRecentFile(path);
    if (state.root && reveal) explorer.reveal(path).catch(() => {});
    if (line) focusPosition(tab, line, ch, length);
    return tab;
  } catch (err) {
    if (err.code === 'BINARY') toast('这是二进制文件，无法以文本方式打开', 'warn', 3000);
    else toast(`打开失败：${err.message}`, 'error', 4000);
    return null;
  }
}

function focusPosition(tab, line, ch, length = 0) {
  if (!tab || tab.kind !== 'editor') return;
  if (tab.id !== state.activeId) activateTab(tab.id);
  const doc = tab.doc;
  const target = { line: Math.max(0, line - 1), ch: Math.max(0, (ch || 1) - 1) };
  doc.setCursor(target);
  if (length > 0) {
    doc.setSelection(target, { line: target.line, ch: target.ch + length });
  }
  editor.cm.scrollIntoView({ line: target.line, ch: target.ch }, 120);
  editor.focus();
}

function activateTab(id, { focus = true } = {}) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  const pane = tab.kind === 'editor' ? 'editor' : 'compare';
  if (state.activeId === id && state.activePane === pane) {
    if (pane === 'editor' && focus) editor.focus();
    return;
  }
  saveActiveView();
  state.activeId = id;
  if (tab.kind === 'editor') {
    showPane('editor');
    editor.activate(tab);
    applyPreview(tab);
    if (focus) setTimeout(() => editor.focus(), 10);
    updateCursor(editor.cm);
  } else {
    showPane('compare');
    applyPreview(null);
    compareView.show(tab);
  }
  renderTabs();
  updateBreadcrumb();
  updateStatus();
  updateToolbarState();
  updateWindowTitle();
  persistSession();
}

function saveActiveView() {
  if (!state.activeId || state.activePane !== 'editor') return;
  const tab = state.tabs.find((t) => t.id === state.activeId);
  if (tab && tab.kind === 'editor') editor.saveView(tab);
}

function showPane(which) {
  state.activePane = which;
  dom.welcome.hidden = which !== 'welcome';
  dom.editorPane.hidden = which !== 'editor';
  dom.comparePane.hidden = which !== 'compare';
  if (which === 'editor') requestAnimationFrame(() => editor.refresh());
}

function showWelcome() {
  state.activeId = null;
  showPane('welcome');
  renderTabs();
  updateBreadcrumb();
  updateStatus();
  updateToolbarState();
  updateWindowTitle();
  renderWelcome();
}

async function saveTab(tab, { saveAs = false, quiet = false } = {}) {
  if (!tab || tab.kind !== 'editor') return false;
  let path = tab.path;
  if (!path || saveAs) {
    const fallbackDir = state.root || state.home || '';
    const suggested = path || (fallbackDir ? joinPath(fallbackDir, tab.name) : tab.name);
    const value = await promptDialog({
      title: saveAs ? '另存为' : '保存文件',
      label: '保存路径',
      value: suggested,
      placeholder: '输入完整文件路径',
      confirmText: '保存',
      validate: (v) => (!v.trim() ? '请输入保存路径' : null),
    });
    if (!value) return false;
    path = value.trim();
    if (path === tab.path) path = tab.path;
  }

  if (path !== tab.path) {
    try {
      const st = await api.stat(path);
      if (st.isDir) {
        toast('目标路径是一个文件夹，请指定文件名', 'warn');
        return false;
      }
      if (!samePath(path, tab.path)) {
        const ok = await confirmDialog({
          title: '覆盖文件',
          message: `「${path}」已经存在，要覆盖它吗？`,
          confirmText: '覆盖',
          danger: true,
        });
        if (!ok) return false;
      }
    } catch { /* file does not exist */ }
  }

  const content = tab.doc.getValue();
  try {
    const res = await api.write(path, content, tab.encoding, tab.eol);
    tab.path = res.path;
    tab.name = baseName(res.path);
    tab.encoding = res.encoding;
    tab.size = res.size;
    tab.mtime = res.mtime;
    tab.metaDirty = false;
    tab.cleanGen = tab.doc.changeGeneration();
    const lang = languageFor(tab.path);
    if (lang.label !== tab.lang.label) {
      tab.lang = lang;
      if (tab.id === state.activeId) {
        editor.setOption('mode', lang.cmMode);
        applyPreview(tab);
      }
    }
    if (res.converted) toast('源文件为 GBK 编码，已转换为 UTF-8 保存', 'warn', 4600);
    if (!quiet) toast(`已保存 ${tab.name}`, 'success', 1600);
    addRecentFile(tab.path);
    if (state.root && insidePath(tab.path, state.root)) explorer.refreshDir(dirName(tab.path));
    updateTabVisual(tab);
    renderTabs();
    updateBreadcrumb();
    updateStatus();
    updateWindowTitle();
    persistSession();
    return true;
  } catch (err) {
    toast(`保存失败：${err.message}`, 'error', 4500);
    return false;
  }
}

async function saveActive() {
  const tab = activeEditorTab();
  if (!tab) {
    toast('请先打开一个文件', 'info', 1600);
    return false;
  }
  return saveTab(tab);
}

async function saveAll() {
  const targets = state.tabs.filter((t) => t.kind === 'editor' && (isDirty(t) || !t.path));
  if (!targets.length) {
    toast('没有需要保存的文件', 'info', 1600);
    return;
  }
  for (const tab of targets) {
    const ok = await saveTab(tab);
    if (!ok) break;
  }
}

async function closeTab(id, { force = false } = {}) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (!force) {
    if (tab.kind === 'editor' && isDirty(tab)) {
      const choice = await saveChangesDialog(tab.name);
      if (!choice || choice === 'cancel') return false;
      if (choice === 'save') {
        const ok = await saveTab(tab);
        if (!ok) return false;
      }
    } else if (tab.kind === 'compare' && tab.compare.mode === 'files') {
      // no unsaved state in compare views
    }
  }

  const wasActive = state.activeId === id;
  if (wasActive) saveActiveView();
  const idx = state.tabs.indexOf(tab);
  state.tabs.splice(idx, 1);
  tabEls.delete(id);
  clearTimeout(autoSaveTimers.get(id));
  autoSaveTimers.delete(id);
  if (tab.kind === 'compare') compareView.dispose(tab);
  else tab.doc.cm = null;

  if (wasActive) {
    state.activeId = null;
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    if (next) activateTab(next.id);
    else showWelcome();
  } else {
    renderTabs();
  }
  updateToolbarState();
  persistSession();
  return true;
}

async function closeOthers(id) {
  const targets = state.tabs.filter((t) => t.id !== id);
  for (const tab of targets) {
    const ok = await closeTab(tab.id);
    if (!ok) break;
  }
}

async function closeToRight(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const targets = state.tabs.slice(idx + 1);
  for (const tab of targets) {
    const ok = await closeTab(tab.id);
    if (!ok) break;
  }
}

async function closeAll() {
  for (const tab of [...state.tabs]) {
    const ok = await closeTab(tab.id);
    if (!ok) break;
  }
}

async function reloadFile(tab) {
  if (!tab || tab.kind !== 'editor' || !tab.path) return;
  if (isDirty(tab)) {
    const ok = await confirmDialog({
      title: '重新加载文件',
      message: '当前文件有未保存的更改，重新加载会丢弃这些更改。',
      confirmText: '重新加载',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const data = await api.read(tab.path);
    suppressDocEvents = true;
    tab.doc.setValue(data.content);
    suppressDocEvents = false;
    tab.encoding = data.encoding;
    tab.eol = data.eol;
    tab.size = data.size;
    tab.mtime = data.mtime;
    tab.metaDirty = false;
    tab.cleanGen = tab.doc.changeGeneration();
    tab.lang = languageFor(tab.path);
    if (tab.id === state.activeId) {
      editor.setOption('mode', tab.lang.cmMode);
      editor.refresh();
      setTimeout(() => editor.cm.scrollTo(tab.scroll?.left || 0, tab.scroll?.top || 0), 0);
    }
    renderTabs();
    updateStatus();
    updateBreadcrumb();
    toast('文件已重新加载', 'success', 1600);
  } catch (err) {
    toast('重新加载失败：' + err.message, 'error');
  }
}

// ------------------------------------------------------------------ compare

function initCompare() {
  compareView = new CompareView({
    host: dom.comparePane,
    onOpenFile: (path) => openFile(path),
    onOpenDiff: (left, right) => openCompareFiles(left, right),
    onChanged: (tab) => {
      if (tab.id === state.activeId) updateStatus();
      persistSession();
    },
  });
}

function addCompareTab(compare, { activate = true, persist = true } = {}) {
  const tab = {
    id: nextTabId(),
    kind: 'compare',
    name: `${baseName(compare.left)} ↔ ${baseName(compare.right)}`,
    compare: {
      mode: compare.mode === 'folders' ? 'folders' : 'files',
      left: compare.left,
      right: compare.right,
      include: compare.include || '',
      exclude: compare.exclude || '',
      options: { ...settings.compare, ...(compare.options || {}) },
    },
    folderState: { ...DEFAULT_FOLDER_STATE },
    el: null,
    refs: null,
  };
  state.tabs.push(tab);
  if (activate) activateTab(tab.id);
  else renderTabs();
  if (persist) addRecentCompare(tab.compare);
  return tab;
}

async function openCompareFiles(left = null, right = null) {
  const tab = activeTab();
  const start = tab && tab.kind === 'editor' && tab.path ? dirName(tab.path) : (state.root || state.home);
  if (!left) {
    left = await pickPath({ mode: 'file', title: '选择左侧文件', start });
    if (!left) return;
  }
  if (!right) {
    right = await pickPath({ mode: 'file', title: '选择右侧文件', start: dirName(left) });
    if (!right) return;
  }
  if (samePath(left, right)) {
    toast('请选择两个不同的文件', 'warn');
    return;
  }
  addCompareTab({ mode: 'files', left, right });
}

async function openCompareFolders(left = null, right = null) {
  if (!left) {
    left = await pickPath({ mode: 'dir', title: '选择左侧文件夹', start: state.root || state.home });
    if (!left) return;
  }
  if (!right) {
    right = await pickPath({ mode: 'dir', title: '选择右侧文件夹', start: state.root || state.home });
    if (!right) return;
  }
  if (samePath(left, right)) {
    toast('请选择两个不同的文件夹', 'warn');
    return;
  }
  addCompareTab({ mode: 'folders', left, right });
}

function openDemo() {
  const root = state.demoRoot || (state.appRoot ? joinPath(state.appRoot, 'demo') : '');
  if (!root) {
    toast('示例路径不可用', 'warn');
    return;
  }
  openCompareFolders(joinPath(root, 'left'), joinPath(root, 'right'));
}

function toggleCompareOption(key) {
  const tab = activeCompareTab();
  const opts = tab ? tab.compare.options : settings.compare;
  if (key === 'ignoreWhitespace') {
    opts.ignoreWhitespace = opts.ignoreWhitespace === 'none' ? 'all' : opts.ignoreWhitespace === 'all' ? 'trailing' : 'none';
  } else {
    opts[key] = !opts[key];
  }
  if (tab) {
    if (tab.compare.mode === 'files' && tab.diff) {
      compareView.computeFileDiff(tab);
      compareView.renderFiles(tab);
    }
    updateStatus();
  } else {
    saveSettings();
  }
  persistSession();
}

function compareOptionChecked(key) {
  const tab = activeCompareTab();
  const opts = tab ? tab.compare.options : settings.compare;
  return !!opts[key];
}

function getDiffCount(tab) {
  if (!tab) return 0;
  if (tab.compare.mode === 'files') return tab.diff ? tab.diff.hunks.length : 0;
  if (tab.folderData) return tab.folderData.summary.modified + tab.folderData.summary.leftOnly + tab.folderData.summary.rightOnly;
  return 0;
}

// ------------------------------------------------------------------ explorer

function initExplorer() {
  explorer = new Explorer({
    treeEl: dom.explorerTree,
    emptyEl: dom.explorerEmpty,
    rootNameEl: dom.rootName,
    rootPathEl: dom.rootPath,
    rootBarEl: dom.rootBar,
    onOpenFile: (path) => openFile(path),
    onCompare: (a, b) => openCompareFiles(a, b),
    onChooseRoot: () => chooseFolder(),
    onSetRoot: (dir) => setRoot(dir),
    onRevealOutside: (path) => {
      setRoot(dirName(path)).then(() => explorer.reveal(path));
    },
    onRenamed: async (from, to) => handleRenamed(from, to),
    onDeleted: async (path) => handleDeleted(path),
  });

  $('exNewFile').addEventListener('click', () => explorer.createFile());
  $('exNewFolder').addEventListener('click', () => explorer.createFolder());
  $('exRefresh').addEventListener('click', () => explorer.refreshRoot());
  $('exCollapse').addEventListener('click', () => explorer.collapseAll());
}

async function chooseFolder() {
  const start = state.root || state.home || '';
  const dir = await pickPath({ mode: 'dir', title: '打开文件夹', start });
  if (dir) await setRoot(dir);
}

async function setRoot(dir, { silent = false } = {}) {
  if (!dir) return;
  state.root = dir;
  await explorer.setRoot(dir);
  addRecentRoot(dir);
  persistSession();
  if (!silent) toast(`已打开文件夹：${baseName(dir)}`, 'success', 1600);
  if (dom.welcome && !dom.welcome.hidden) renderWelcome();
}

async function handleRenamed(from, to) {
  const mapPath = (p) => {
    if (!p) return p;
    if (samePath(p, from)) return to;
    if (insidePath(p, from)) return to + p.slice(from.length);
    return p;
  };
  for (const tab of state.tabs) {
    if (tab.kind === 'editor' && tab.path) {
      const next = mapPath(tab.path);
      if (next !== tab.path) {
        tab.path = next;
        tab.name = baseName(next);
        tab.lang = languageFor(next);
        if (tab.id === state.activeId) editor.setOption('mode', tab.lang.cmMode);
      }
    } else if (tab.kind === 'compare') {
      tab.compare.left = mapPath(tab.compare.left);
      tab.compare.right = mapPath(tab.compare.right);
      tab.name = `${baseName(tab.compare.left)} ↔ ${baseName(tab.compare.right)}`;
    }
  }
  state.recent.files = state.recent.files.map(mapPath);
  state.recent.compares = state.recent.compares.map((c) => ({ ...c, left: mapPath(c.left), right: mapPath(c.right) }));
  saveRecents();
  if (insidePath(state.root, from)) await setRoot(to, { silent: true });
  renderTabs();
  renderWelcome();
  renderRecentCompares();
  updateBreadcrumb();
  updateWindowTitle();
  persistSession();
}

async function handleDeleted(path) {
  for (const tab of [...state.tabs]) {
    const hit = tab.kind === 'editor'
      ? insidePath(tab.path, path)
      : insidePath(tab.compare.left, path) || insidePath(tab.compare.right, path);
    if (hit) await closeTab(tab.id, { force: true });
  }
  if (insidePath(state.root, path) && pkey(state.root) !== pkey(path)) {
    await setRoot(dirName(path), { silent: true });
  }
  renderWelcome();
  persistSession();
}

// ------------------------------------------------------------------ tabs UI

function renderTabs() {
  const strip = dom.tabstrip;
  strip.replaceChildren();
  tabEls.clear();
  if (!state.tabs.length) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;

  for (const tab of state.tabs) {
    const isActive = tab.id === state.activeId;
    const dirty = isDirty(tab);
    const isCompare = tab.kind === 'compare';
    const iconName = isCompare
      ? (tab.compare.mode === 'folders' ? 'folder-tree' : 'git-compare')
      : iconForTab(tab.path, tab.name);
    const el = h('div', {
      class: `tab${isActive ? ' active' : ''}${dirty ? ' dirty' : ''}${isCompare ? ' compare-tab' : ''}`,
      dataset: { id: tab.id },
      title: isCompare ? `${tab.compare.left}\n↔ ${tab.compare.right}` : (tab.path || tab.name),
      onClick: () => activateTab(tab.id),
      onMousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } },
      onContextmenu: (e) => showTabMenu(e, tab),
    },
      h('span', { class: 'tab-icon' }, icon(iconName)),
      h('span', { class: 'tab-name', text: tab.name }),
      h('span', { class: 'tab-dot', title: '未保存' }),
      h('button', {
        class: 'tab-close',
        title: '关闭 (Ctrl+W)',
        onClick: (e) => { e.stopPropagation(); closeTab(tab.id); },
      }, icon('x'))
    );
    tabEls.set(tab.id, el);
    strip.appendChild(el);
  }

  const addBtn = h('button', { class: 'tab-add', title: '新建文件 (Ctrl+N)', onClick: () => newFile() }, icon('plus'));
  strip.appendChild(addBtn);

  const activeEl = tabEls.get(state.activeId);
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function iconForTab(path, name) {
  const lower = (path || name || '').toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  if (['json', 'jsonc'].includes(ext)) return 'braces';
  if (['md', 'txt', 'log', 'markdown'].includes(ext)) return 'file-text';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'css', 'html', 'xml', 'sql', 'sh', 'ps1'].includes(ext)) return 'file-code';
  return 'file';
}

function showTabMenu(e, tab) {
  e.preventDefault();
  activateTab(tab.id);
  const items = [
    { label: '关闭', icon: 'x', action: () => closeTab(tab.id) },
    { label: '关闭其他', action: () => closeOthers(tab.id) },
    { label: '关闭右侧标签', action: () => closeToRight(tab.id) },
    { separator: true },
  ];
  if (tab.kind === 'editor') {
    items.push({ label: '保存', icon: 'save', action: () => saveTab(tab) });
    items.push({ label: '另存为…', action: () => saveTab(tab, { saveAs: true }) });
    items.push({ label: '重新加载', icon: 'refresh-cw', action: () => reloadFile(tab) });
    if (tab.path) {
      items.push({ separator: true });
      items.push({ label: '复制路径', icon: 'copy', action: () => copyText(tab.path) });
      items.push({ label: '在资源管理器中显示', icon: 'folder-open', action: () => api.reveal(tab.path).catch((err) => toast(err.message, 'error')) });
    }
  } else {
    items.push({ label: '重新比较', icon: 'refresh-cw', action: () => compareView.reload(tab) });
    items.push({ label: '交换左右', icon: 'arrow-left-right', action: () => compareView.swap(tab) });
  }
  showContextMenu(e.clientX, e.clientY, items);
}

// ------------------------------------------------------------------ breadcrumb & status

function updateBreadcrumb() {
  const el = dom.breadcrumb;
  clear(el);
  const tab = activeTab();
  if (!tab) {
    el.appendChild(h('span', { class: 'crumb-muted', text: '未打开文件' }));
    return;
  }
  if (tab.kind === 'editor') {
    if (tab.path) {
      el.appendChild(h('span', { class: 'crumb-icon' }, icon(iconForTab(tab.path, tab.name))));
      el.appendChild(h('span', { class: 'crumb-dir', title: tab.path, text: dirName(tab.path) }));
      el.appendChild(h('span', { class: 'crumb-sep', text: '›' }));
      el.appendChild(h('span', { class: 'crumb-file', text: baseName(tab.path) }));
    } else {
      el.appendChild(h('span', { class: 'crumb-icon' }, icon('file')));
      el.appendChild(h('span', { class: 'crumb-file', text: tab.name }));
      el.appendChild(h('span', { class: 'crumb-badge', text: '未保存' }));
    }
  } else {
    el.appendChild(h('span', { class: 'crumb-icon' }, icon(tab.compare.mode === 'files' ? 'git-compare' : 'folder-tree')));
    el.appendChild(h('span', { class: 'crumb-dir', title: tab.compare.left, text: dirName(tab.compare.left) }));
    el.appendChild(h('span', { class: 'crumb-file', text: baseName(tab.compare.left) }));
    el.appendChild(h('span', { class: 'crumb-sep', text: '↔' }));
    el.appendChild(h('span', { class: 'crumb-file', text: baseName(tab.compare.right) }));
  }
}

function updateCursor(cm) {
  const tab = activeEditorTab();
  if (!tab) return;
  const pos = cm.getCursor();
  dom.statCursor.textContent = `行 ${pos.line + 1}，列 ${pos.ch + 1}`;
  const sel = cm.getSelection();
  if (sel) {
    dom.statSel.hidden = false;
    const lines = cm.getSelection().split('\n').length;
    dom.statSel.textContent = lines > 1 ? `已选择 ${lines} 行，${sel.length} 字符` : `已选择 ${sel.length} 字符`;
  } else {
    dom.statSel.hidden = true;
  }
}

const ENCODING_LABELS = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  gbk: 'GBK',
};

function updateStatus() {
  const tab = activeTab();
  const toggle = (el, show) => { if (el) el.hidden = !show; };
  if (!tab) {
    dom.statusPath.textContent = '就绪';
    dom.statusPath.title = '';
    toggle(dom.statCursor, false);
    toggle(dom.statSel, false);
    toggle(dom.statIndent, false);
    toggle(dom.statEncoding, false);
    toggle(dom.statEol, false);
    toggle(dom.statLang, false);
    toggle(dom.statSize, false);
    dom.statDirty.hidden = true;
    return;
  }
  dom.statDirty.hidden = true;

  if (tab.kind === 'editor') {
    toggle(dom.statCursor, true);
    toggle(dom.statSel, true);
    toggle(dom.statIndent, true);
    toggle(dom.statEncoding, true);
    toggle(dom.statEol, true);
    toggle(dom.statLang, true);
    toggle(dom.statSize, true);
    dom.statusPath.textContent = tab.path || tab.name;
    dom.statusPath.title = tab.path || '尚未保存';
    const pos = tab.doc.getCursor();
    dom.statCursor.textContent = `行 ${pos.line + 1}，列 ${pos.ch + 1}`;
    const sel = tab.doc.getSelection();
    dom.statSel.hidden = !sel;
    if (sel) dom.statSel.textContent = `已选择 ${sel.length} 字符`;
    dom.statIndent.textContent = `${tab.indentWithTabs ? '制表符' : '空格'}: ${tab.tabSize}`;
    dom.statEncoding.textContent = ENCODING_LABELS[tab.encoding] || tab.encoding;
    dom.statEol.textContent = tab.eol;
    dom.statLang.textContent = tab.lang.label;
    dom.statSize.textContent = `${tab.doc.lineCount().toLocaleString()} 行`;
    dom.statSize.title = '当前行数';
    dom.statDirty.hidden = !isDirty(tab);
  } else {
    toggle(dom.statCursor, false);
    toggle(dom.statSel, false);
    toggle(dom.statIndent, false);
    toggle(dom.statEncoding, false);
    toggle(dom.statEol, false);
    toggle(dom.statLang, true);
    toggle(dom.statSize, true);
    dom.statLang.textContent = tab.compare.mode === 'files' ? '文件对比' : '文件夹对比';
    const left = baseName(tab.compare.left);
    const right = baseName(tab.compare.right);
    dom.statusPath.textContent = `${tab.compare.left}  ↔  ${tab.compare.right}`;
    dom.statusPath.title = dom.statusPath.textContent;
    if (tab.compare.mode === 'files') {
      dom.statSize.textContent = tab.diff ? `${tab.diff.hunks.length} 处差异` : (tab.files ? '计算中…' : '读取中…');
    } else if (tab.folderData) {
      const s = tab.folderData.summary;
      dom.statSize.textContent = `修改 ${s.modified} · 仅左 ${s.leftOnly} · 仅右 ${s.rightOnly}`;
    } else {
      dom.statSize.textContent = '比对中…';
    }
    void left; void right;
  }
}

function updateToolbarState() {
  const saveBtn = document.querySelector('[data-cmd="save"]');
  if (saveBtn) saveBtn.disabled = !activeEditorTab();
  const findBtn = document.querySelector('[data-cmd="find"]');
  const replaceBtn = document.querySelector('[data-cmd="replace"]');
  if (findBtn) findBtn.disabled = !activeEditorTab();
  if (replaceBtn) replaceBtn.disabled = !activeEditorTab();
}

function updateWindowTitle() {
  const tab = activeTab();
  if (!tab) { document.title = 'FileDock — 编辑器 + 文件对比'; return; }
  const mark = tab.kind === 'editor' && isDirty(tab) ? ' •' : '';
  document.title = `${tab.name}${mark} — FileDock`;
}

function updateUi() {
  renderTabs();
  updateBreadcrumb();
  updateStatus();
  updateToolbarState();
  updateWindowTitle();
  applyPreview(activeEditorTab());
}

// ------------------------------------------------------------------ markdown / json preview

let previewTimer = null;

function previewMode(tab) {
  return tab && tab.kind === 'editor' && tab.lang ? previewKind(tab.lang.key) : null;
}

function togglePreview() {
  const tab = activeEditorTab();
  if (!tab) return;
  const kind = previewMode(tab);
  if (!kind) {
    toast('预览仅支持 Markdown 与 JSON 文件', 'info', 2600);
    return;
  }
  tab.preview = !tab.preview;
  applyPreview(tab);
  if (tab.preview) toast(`已开启 ${kind === 'markdown' ? 'Markdown' : 'JSON'} 预览`, 'info', 1400);
}

function schedulePreview(tab) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (tab.id === state.activeId && tab.preview) applyPreview(tab);
  }, 180);
}

function applyPreview(tab) {
  const host = $('previewHost');
  const supported = !!previewMode(tab);
  const active = !!supported && !!tab.preview;

  if (dom.editorPane) dom.editorPane.classList.toggle('preview', active);
  if (host) {
    host.hidden = !active;
    if (active) {
      host.innerHTML = renderPreview(previewMode(tab), tab.doc.getValue());
      host.scrollTop = 0;
    } else {
      host.replaceChildren();
    }
  }

  const btn = $('btnPreview');
  if (btn) {
    btn.disabled = !supported;
    btn.classList.toggle('active', active);
    btn.title = supported
      ? `${active ? '关闭' : '打开'} ${tab.lang.label} 预览 (Ctrl+Shift+V)`
      : '预览仅支持 Markdown 与 JSON';
  }
  if (active) requestAnimationFrame(() => editor.refresh());
}

// ------------------------------------------------------------------ status interactions

function initDesktop() {
  const bridge = window.filedock;
  if (!bridge || !bridge.desktop) return;

  document.body.classList.add('desktop');

  const maxBtn = h('button', {
    class: 'win-btn',
    title: '最大化',
    'aria-label': '最大化',
    onClick: () => bridge.toggleMaximize(),
  }, icon('square'));

  const controls = h('div', { class: 'win-controls' },
    h('button', {
      class: 'win-btn', title: '最小化', 'aria-label': '最小化',
      onClick: () => bridge.minimize(),
    }, icon('minus')),
    maxBtn,
    h('button', {
      class: 'win-btn win-close', title: '关闭', 'aria-label': '关闭',
      onClick: () => bridge.close(),
    }, icon('x'))
  );

  const right = document.querySelector('.titlebar-right');
  if (right) right.appendChild(controls);

  bridge.onMaximized((maximized) => {
    document.body.classList.toggle('maximized', maximized);
    maxBtn.replaceChildren(icon(maximized ? 'copy' : 'square'));
    maxBtn.title = maximized ? '还原' : '最大化';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  });

  if (typeof bridge.onCloseRequested === 'function') {
    bridge.onCloseRequested(async () => {
      if (state.tabs.some((t) => t.kind === 'editor' && isDirty(t))) {
        const ok = await confirmDialog({
          title: '未保存的更改',
          message: '有未保存的修改',
          detail: '现在退出会丢失这些修改。',
          confirmText: '放弃更改并退出',
          cancelText: '取消',
          danger: true,
        });
        if (!ok) return;
      }
      window.__filedockAllowUnload = true;
      persistSession.flush();
      if (typeof bridge.forceClose === 'function') bridge.forceClose();
      else bridge.close();
    });
  }

  const titlebar = document.getElementById('titlebar');
  if (titlebar && typeof bridge.startDrag === 'function') {
    const ignore = (target) => !!target.closest('button, a, input, select, textarea, #menubar, .win-controls');
    let dragStart = null;
    titlebar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || ignore(e.target)) return;
      dragStart = { x: e.clientX, y: e.clientY };
    });
    titlebar.addEventListener('pointermove', (e) => {
      if (!dragStart) return;
      if (Math.abs(e.clientX - dragStart.x) + Math.abs(e.clientY - dragStart.y) > 3) {
        dragStart = null;
        bridge.startDrag();
      }
    });
    const stopDrag = () => { dragStart = null; };
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('blur', stopDrag);
    titlebar.addEventListener('dblclick', (e) => {
      if (ignore(e.target)) return;
      bridge.toggleMaximize();
    });
  }
}

function initStatusbar() {
  dom.statusPath.addEventListener('click', () => {
    const tab = activeTab();
    if (tab && tab.path) copyText(tab.path);
  });
  dom.statEncoding.addEventListener('click', (e) => {
    const tab = activeEditorTab();
    if (!tab) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const items = Object.entries(ENCODING_LABELS).map(([value, label]) => ({
      label: (tab.encoding === value ? '✓ ' : '') + label + (value === 'gbk' ? '（保存为 UTF-8）' : ''),
      action: () => {
        tab.encoding = value;
        markMetaDirty(tab);
        updateStatus();
        toast(`编码已设置为 ${label}，保存后生效`, 'info', 2000);
      },
    }));
    showContextMenu(rect.left, rect.bottom + 4, items);
  });
  dom.statEol.addEventListener('click', (e) => {
    const tab = activeEditorTab();
    if (!tab) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const items = ['LF', 'CRLF', 'CR'].map((value) => ({
      label: (tab.eol === value ? '✓ ' : '') + ({ LF: 'LF（Unix）', CRLF: 'CRLF（Windows）', CR: 'CR（旧版 Mac）' })[value],
      action: () => {
        tab.eol = value;
        markMetaDirty(tab);
        updateStatus();
        toast(`换行符已设置为 ${value}，保存后生效`, 'info', 2000);
      },
    }));
    showContextMenu(rect.left, rect.bottom + 4, items);
  });
  dom.statIndent.addEventListener('click', (e) => {
    const tab = activeEditorTab();
    if (!tab) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const items = [];
    for (const n of [2, 4, 8]) {
      items.push({
        label: `${tab.tabSize === n && !tab.indentWithTabs ? '✓ ' : ''}空格: ${n}`,
        action: () => setIndent(tab, n, false),
      });
    }
    items.push({ separator: true });
    for (const n of [2, 4, 8]) {
      items.push({
        label: `${tab.tabSize === n && tab.indentWithTabs ? '✓ ' : ''}制表符: ${n}`,
        action: () => setIndent(tab, n, true),
      });
    }
    showContextMenu(rect.left, rect.bottom + 4, items);
  });
}

function setIndent(tab, size, useTabs) {
  tab.tabSize = size;
  tab.indentWithTabs = useTabs;
  if (tab.id === state.activeId) {
    editor.setOption('indentUnit', size);
    editor.setOption('tabSize', size);
    editor.setOption('indentWithTabs', useTabs);
  }
  updateStatus();
}

// ------------------------------------------------------------------ sidebar & welcome

function initSidebar() {
  document.querySelectorAll('.side-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchSidebar(btn.dataset.side));
  });
  $('clearRecentCompares').addEventListener('click', () => {
    state.recent.compares = [];
    saveRecents();
    renderRecentCompares();
  });
  $('btnSidebar').addEventListener('click', () => {
    settings.sidebarVisible = !settings.sidebarVisible;
    saveSettings();
    applySettings();
    persistSession();
  });
  $('btnTheme').addEventListener('click', cycleTheme);
  $('btnSettings').addEventListener('click', openSettings);
  renderRecentCompares();
}

function switchSidebar(name, { silent = false } = {}) {
  if (!['explorer', 'search', 'compare'].includes(name)) return;
  state.sidebar = name;
  document.querySelectorAll('.side-tab').forEach((b) => b.classList.toggle('active', b.dataset.side === name));
  document.querySelectorAll('.side-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  if (!silent) persistSession();
}

function renderWelcome() {
  const filesEl = $('welcomeRecentFiles');
  const rootsEl = $('welcomeRecentRoots');
  if (!filesEl || !rootsEl) return;
  filesEl.replaceChildren();
  rootsEl.replaceChildren();

  const files = state.recent.files.slice(0, 8);
  if (!files.length) {
    filesEl.appendChild(h('div', { class: 'recent-empty', text: '还没有打开过文件' }));
  }
  for (const path of files) {
    filesEl.appendChild(h('button', {
      class: 'recent-item',
      title: path,
      onClick: () => openFile(path),
    },
      icon(iconForTab(path, baseName(path))),
      h('span', { class: 'recent-item-text' },
        h('b', { text: baseName(path) }),
        h('small', { text: dirName(path) })
      )
    ));
  }

  const roots = state.recent.roots.slice(0, 6);
  if (!roots.length) {
    rootsEl.appendChild(h('div', { class: 'recent-empty', text: '还没有打开过文件夹' }));
  }
  for (const path of roots) {
    rootsEl.appendChild(h('button', {
      class: 'recent-item compact',
      title: path,
      onClick: () => setRoot(path),
    },
      icon('folder'),
      h('span', { class: 'recent-item-text' },
        h('b', { text: baseName(path) }),
        h('small', { text: path })
      )
    ));
  }
}

function renderRecentCompares() {
  const el = $('recentCompares');
  if (!el) return;
  el.replaceChildren();
  const items = state.recent.compares.slice(0, 8);
  if (!items.length) {
    el.appendChild(h('div', { class: 'recent-empty', text: '还没有比较记录' }));
    return;
  }
  for (const item of items) {
    el.appendChild(h('button', {
      class: 'recent-compare',
      title: `${item.left}\n↔ ${item.right}`,
      onClick: () => {
        addCompareTab(item);
      },
    },
      h('span', { class: `rc-icon ${item.mode}` }, icon(item.mode === 'folders' ? 'folder-tree' : 'git-compare')),
      h('span', { class: 'rc-text' },
        h('b', { text: `${baseName(item.left)} ↔ ${baseName(item.right)}` }),
        h('small', { text: `${item.left} ↔ ${item.right}` })
      )
    ));
  }
}

function initWelcome() {
  renderWelcome();
}

// ------------------------------------------------------------------ menus

const MENUS = [
  {
    label: '文件',
    items: () => [
      { label: '新建文件', key: 'Ctrl+N', cmd: 'newFile', icon: 'file-plus' },
      { label: '打开文件…', key: 'Ctrl+O', cmd: 'openFile', icon: 'file-text' },
      { label: '打开文件夹…', key: 'Ctrl+Shift+O', cmd: 'openFolder', icon: 'folder-open' },
      { separator: true },
      { label: '保存', key: 'Ctrl+S', cmd: 'save', icon: 'save', enabled: () => !!activeEditorTab() },
      { label: '另存为…', key: 'Ctrl+Shift+S', cmd: 'saveAs', enabled: () => !!activeEditorTab() },
      { label: '全部保存', cmd: 'saveAll' },
      { separator: true },
      { label: '重新加载文件', cmd: 'reloadFile', icon: 'refresh-cw', enabled: () => !!activeEditorTab() },
      { label: '关闭标签', key: 'Ctrl+W', cmd: 'closeTab', enabled: () => !!activeTab() },
      { label: '关闭全部标签', cmd: 'closeAll', enabled: () => !!state.tabs.length },
      { separator: true },
      { label: '在资源管理器中显示', cmd: 'revealFile', icon: 'external-link', enabled: () => !!(activeTab() && (activeTab().path || activeTab().compare)) },
      { separator: true },
      { label: '设置…', key: 'Ctrl+,', cmd: 'settings', icon: 'settings' },
    ],
  },
  {
    label: '编辑',
    items: () => [
      { label: '撤销', key: 'Ctrl+Z', cmd: 'undo', icon: 'rotate-ccw', enabled: () => !!activeEditorTab() },
      { label: '重做', key: 'Ctrl+Y', cmd: 'redo', icon: 'rotate-cw', enabled: () => !!activeEditorTab() },
      { separator: true },
      { label: '剪切', key: 'Ctrl+X', cmd: 'cut', icon: 'scissors', enabled: () => !!activeEditorTab() },
      { label: '复制', key: 'Ctrl+C', cmd: 'copy', icon: 'copy', enabled: () => !!activeEditorTab() },
      { label: '粘贴', key: 'Ctrl+V', cmd: 'paste', icon: 'clipboard', enabled: () => !!activeEditorTab() },
      { label: '全选', key: 'Ctrl+A', cmd: 'selectAll', enabled: () => !!activeEditorTab() },
      { separator: true },
      { label: '查找…', key: 'Ctrl+F', cmd: 'find', icon: 'search', enabled: () => !!activeEditorTab() },
      { label: '替换…', key: 'Ctrl+H', cmd: 'replace', icon: 'replace', enabled: () => !!activeEditorTab() },
      { label: '转到行…', key: 'Ctrl+G', cmd: 'gotoLine', enabled: () => !!activeEditorTab() },
      { separator: true },
      { label: '复制当前行', key: 'Ctrl+D', cmd: 'duplicateLine', enabled: () => !!activeEditorTab() },
      { label: '删除当前行', key: 'Ctrl+Shift+K', cmd: 'deleteLine', enabled: () => !!activeEditorTab() },
      { label: '注释 / 取消注释', key: 'Ctrl+/', cmd: 'toggleComment', enabled: () => !!activeEditorTab() },
      { separator: true },
      { label: '格式化 JSON', cmd: 'formatJson', enabled: () => !!activeEditorTab() },
      { label: '预览 Markdown / JSON', key: 'Ctrl+Shift+V', cmd: 'togglePreview', icon: 'eye', enabled: () => !!activeEditorTab() },
      { label: '转换为大写', cmd: 'uppercase', enabled: () => !!activeEditorTab() },
      { label: '转换为小写', cmd: 'lowercase', enabled: () => !!activeEditorTab() },
    ],
  },
  {
    label: '搜索',
    items: () => [
      { label: '在文件中查找…', key: 'Ctrl+Shift+F', cmd: 'focusSearch', icon: 'search' },
      { label: '快速查找文件…', key: 'Ctrl+P', cmd: 'quickOpen', icon: 'file-search' },
      { label: '命令面板…', key: 'Ctrl+Shift+P', cmd: 'commandPalette', icon: 'command' },
      { separator: true },
      { label: '下一个差异', key: 'Alt+↓', cmd: 'nextDiff', enabled: () => !!activeCompareTab() },
      { label: '上一个差异', key: 'Alt+↑', cmd: 'prevDiff', enabled: () => !!activeCompareTab() },
      { separator: true },
      { label: '在当前文件查找', key: 'Ctrl+F', cmd: 'find', enabled: () => !!activeEditorTab() },
      { label: '在当前文件替换', key: 'Ctrl+H', cmd: 'replace', enabled: () => !!activeEditorTab() },
    ],
  },
  {
    label: '视图',
    items: () => [
      { label: '显示 / 隐藏侧边栏', key: 'Ctrl+B', cmd: 'toggleSidebar', icon: 'panel-left' },
      { separator: true },
      { label: settings.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', cmd: 'toggleTheme', icon: settings.theme === 'dark' ? 'sun' : 'moon' },
      { label: '增大字号', key: 'Ctrl+=', cmd: 'fontPlus' },
      { label: '减小字号', key: 'Ctrl+-', cmd: 'fontMinus' },
      { label: '重置字号', cmd: 'fontReset' },
      { separator: true },
      { label: '自动换行', cmd: 'toggleWrap', icon: 'wrap-text', checked: () => !!settings.wrap },
      { label: '显示空白字符', cmd: 'toggleTrailing', icon: 'dot', checked: () => !!settings.showTrailing },
      { label: '预览 Markdown / JSON', key: 'Ctrl+Shift+V', cmd: 'togglePreview', icon: 'eye', checked: () => !!activeEditorTab()?.preview },
      { separator: true },
      { label: '设置…', key: 'Ctrl+,', cmd: 'settings', icon: 'settings' },
    ],
  },
  {
    label: '比较',
    items: () => [
      { label: '比较文件…', key: 'Ctrl+Alt+C', cmd: 'compareFiles', icon: 'git-compare' },
      { label: '比较文件夹…', key: 'Ctrl+Alt+D', cmd: 'compareFolders', icon: 'folder-tree' },
      { separator: true },
      { label: '下一个差异', key: 'Alt+↓', cmd: 'nextDiff', enabled: () => !!activeCompareTab() },
      { label: '上一个差异', key: 'Alt+↑', cmd: 'prevDiff', enabled: () => !!activeCompareTab() },
      { label: '交换左右', cmd: 'swapSides', icon: 'arrow-left-right', enabled: () => !!activeCompareTab() },
      { label: '切换并排 / 行内', cmd: 'toggleCompareView', icon: 'columns-2', enabled: () => !!activeCompareTab() },
      { label: '重新比较', cmd: 'reloadCompare', icon: 'refresh-cw', enabled: () => !!activeCompareTab() },
      { separator: true },
      { label: '忽略大小写', cmd: 'toggleIgnoreCase', checked: () => compareOptionChecked('ignoreCase') },
      { label: '忽略空白', cmd: 'toggleIgnoreWhitespace', checked: () => compareOptionChecked('ignoreWhitespace') !== 'none', enabled: () => !!activeCompareTab() },
      { label: '忽略空行', cmd: 'toggleIgnoreBlankLines', checked: () => compareOptionChecked('ignoreBlankLines') },
    ],
  },
  {
    label: '帮助',
    items: () => [
      { label: '键盘快捷键', key: 'F1', cmd: 'shortcuts', icon: 'keyboard' },
      { label: '关于 FileDock', cmd: 'about', icon: 'info' },
      { separator: true },
      { label: '打开示例对比', cmd: 'openDemo', icon: 'sparkles' },
    ],
  },
];

function initMenus() {
  dom.menubar.replaceChildren();
  MENUS.forEach((menu) => {
    const wrap = h('div', { class: 'menu' });
    const btn = h('button', { class: 'menu-btn', text: menu.label });
    const dropdown = h('div', { class: 'menu-dropdown' });
    wrap.append(btn, dropdown);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenuEl === wrap) closeMenus();
      else openMenu(menu, wrap, dropdown);
    });
    btn.addEventListener('mouseenter', () => {
      if (openMenuEl && openMenuEl !== wrap) openMenu(menu, wrap, dropdown);
    });
    dom.menubar.appendChild(wrap);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu')) closeMenus();
  });
}

function openMenu(menu, wrap, dropdown) {
  closeMenus();
  dropdown.replaceChildren();
  for (const item of menu.items()) {
    if (!item) continue;
    if (item.separator) {
      dropdown.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    const checked = item.checked ? !!item.checked() : false;
    const enabled = item.enabled ? !!item.enabled() : true;
    const row = h('button', {
      class: `menu-item${checked ? ' checked' : ''}${enabled ? '' : ' disabled'}`,
      disabled: !enabled,
      onClick: () => {
        closeMenus();
        if (!enabled) return;
        if (item.action) item.action();
        else if (item.cmd) runCommand(item.cmd);
      },
    },
      h('span', { class: 'menu-check' }, checked ? icon('check') : null),
      h('span', { class: 'menu-icon' }, item.icon ? icon(item.icon) : null),
      h('span', { class: 'menu-label', text: item.label }),
      item.key ? h('span', { class: 'menu-key', text: item.key }) : null
    );
    dropdown.appendChild(row);
  }
  wrap.classList.add('open');
  openMenuEl = wrap;
}

function closeMenus() {
  if (openMenuEl) openMenuEl.classList.remove('open');
  openMenuEl = null;
}

// ------------------------------------------------------------------ commands

const COMMANDS = [
  { id: 'newFile', label: '新建文件', key: 'Ctrl+N', icon: 'file-plus' },
  { id: 'openFile', label: '打开文件…', key: 'Ctrl+O', icon: 'file-text' },
  { id: 'openFolder', label: '打开文件夹…', key: 'Ctrl+Shift+O', icon: 'folder-open' },
  { id: 'save', label: '保存当前文件', key: 'Ctrl+S', icon: 'save' },
  { id: 'saveAs', label: '另存为…', key: 'Ctrl+Shift+S', icon: 'save' },
  { id: 'saveAll', label: '全部保存', icon: 'save' },
  { id: 'closeTab', label: '关闭当前标签', key: 'Ctrl+W', icon: 'x' },
  { id: 'reloadFile', label: '重新加载当前文件', icon: 'refresh-cw' },
  { id: 'find', label: '在当前文件查找', key: 'Ctrl+F', icon: 'search' },
  { id: 'replace', label: '在当前文件替换', key: 'Ctrl+H', icon: 'replace' },
  { id: 'gotoLine', label: '转到行…', key: 'Ctrl+G', icon: 'arrow-down' },
  { id: 'focusSearch', label: '在文件夹中搜索', key: 'Ctrl+Shift+F', icon: 'folder-search' },
  { id: 'quickOpen', label: '快速查找文件（Everything 式）', key: 'Ctrl+P', icon: 'file-search' },
  { id: 'compareFiles', label: '比较两个文件…', key: 'Ctrl+Alt+C', icon: 'git-compare' },
  { id: 'compareFolders', label: '比较两个文件夹…', key: 'Ctrl+Alt+D', icon: 'folder-tree' },
  { id: 'nextDiff', label: '跳到下一个差异', key: 'Alt+↓', icon: 'arrow-down' },
  { id: 'prevDiff', label: '跳到上一个差异', key: 'Alt+↑', icon: 'arrow-up' },
  { id: 'toggleSidebar', label: '显示 / 隐藏侧边栏', key: 'Ctrl+B', icon: 'panel-left' },
  { id: 'toggleWrap', label: '切换自动换行', icon: 'wrap-text' },
  { id: 'toggleTheme', label: '切换深色 / 浅色主题', icon: 'sun' },
  { id: 'formatJson', label: '格式化 JSON', icon: 'braces' },
  { id: 'togglePreview', label: '预览 Markdown / JSON', icon: 'eye' },
  { id: 'uppercase', label: '转换为大写', icon: 'case-upper' },
  { id: 'lowercase', label: '转换为小写', icon: 'case-lower' },
  { id: 'duplicateLine', label: '复制当前行', key: 'Ctrl+D', icon: 'copy' },
  { id: 'deleteLine', label: '删除当前行', key: 'Ctrl+Shift+K', icon: 'trash-2' },
  { id: 'settings', label: '打开设置', key: 'Ctrl+,', icon: 'settings' },
  { id: 'shortcuts', label: '键盘快捷键', key: 'F1', icon: 'keyboard' },
  { id: 'openDemo', label: '打开示例对比', icon: 'sparkles' },
  { id: 'about', label: '关于 FileDock', icon: 'info' },
];

const ACTIONS = {
  newFile: () => newFile(),
  openFile: () => chooseAndOpenFile(),
  openFolder: () => chooseFolder(),
  save: () => saveActive(),
  saveAs: () => { const t = activeEditorTab(); if (t) saveTab(t, { saveAs: true }); },
  saveAll: () => saveAll(),
  closeTab: () => { const t = activeTab(); if (t) closeTab(t.id); },
  closeAll: () => closeAll(),
  reloadFile: () => { const t = activeEditorTab(); if (t) reloadFile(t); },
  undo: () => execEditor('undo'),
  redo: () => execEditor('redo'),
  cut: () => cutSelection(),
  copy: () => copySelection(),
  paste: () => pasteClipboard(),
  selectAll: () => execEditor('selectAll'),
  find: () => openFind(false),
  replace: () => openFind(true),
  gotoLine: () => execEditor('jumpToLine'),
  duplicateLine: () => { if (activeEditorTab()) duplicateLines(editor.cm); },
  deleteLine: () => { if (activeEditorTab()) deleteLines(editor.cm); },
  toggleComment: () => execEditor('toggleComment'),
  formatJson: () => formatJson(),
  togglePreview: () => togglePreview(),
  uppercase: () => changeCase('upper'),
  lowercase: () => changeCase('lower'),
  focusSearch: () => { switchSidebar('search'); setTimeout(() => dom.searchInput.focus(), 60); },
  quickOpen: () => openQuickOpen(),
  commandPalette: () => openCommandPalette(),
  compareFiles: () => openCompareFiles(),
  compareFolders: () => openCompareFolders(),
  nextDiff: () => { const t = activeCompareTab(); if (t) compareView.navigateDiff(t, 1); },
  prevDiff: () => { const t = activeCompareTab(); if (t) compareView.navigateDiff(t, -1); },
  swapSides: () => { const t = activeCompareTab(); if (t) compareView.swap(t); },
  toggleCompareView: () => { const t = activeCompareTab(); if (t && t.compare.mode === 'files') compareView.toggleView(t); },
  reloadCompare: () => { const t = activeCompareTab(); if (t) compareView.reload(t); },
  toggleIgnoreCase: () => toggleCompareOption('ignoreCase'),
  toggleIgnoreWhitespace: () => toggleCompareOption('ignoreWhitespace'),
  toggleIgnoreBlankLines: () => toggleCompareOption('ignoreBlankLines'),
  toggleSidebar: () => {
    settings.sidebarVisible = !settings.sidebarVisible;
    saveSettings();
    applySettings();
    persistSession();
  },
  toggleWrap: () => {
    settings.wrap = !settings.wrap;
    saveSettings();
    applySettings();
    toast(settings.wrap ? '已开启自动换行' : '已关闭自动换行', 'info', 1400);
    persistSession();
  },
  toggleTrailing: () => {
    settings.showTrailing = !settings.showTrailing;
    saveSettings();
    applySettings();
    toast(settings.showTrailing ? '已显示空白字符' : '已隐藏空白字符', 'info', 1400);
  },
  toggleTheme: () => cycleTheme(),
  fontPlus: () => changeFont(1),
  fontMinus: () => changeFont(-1),
  fontReset: () => { settings.fontSize = DEFAULT_SETTINGS.fontSize; saveSettings(); applySettings(); },
  settings: () => openSettings(),
  shortcuts: () => openShortcuts(),
  about: () => openAbout(),
  openDemo: () => openDemo(),
  revealFile: () => {
    const tab = activeTab();
    const path = tab && (tab.path || tab.compare?.left);
    if (path) api.reveal(path).catch((err) => toast(err.message, 'error'));
  },
};

function runCommand(id) {
  const fn = ACTIONS[id];
  if (fn) {
    try { fn(); } catch (err) { toast(err.message, 'error'); console.error(err); }
  }
}

async function chooseAndOpenFile() {
  const tab = activeTab();
  const start = tab && tab.kind === 'editor' && tab.path ? dirName(tab.path) : (state.root || state.home);
  const path = await pickPath({ mode: 'file', title: '打开文件', start });
  if (path) openFile(path);
}

function execEditor(cmd) {
  if (!activeEditorTab()) {
    toast('请先打开一个文件', 'info', 1500);
    return;
  }
  editor.focus();
  editor.cm.execCommand(cmd);
}

function openFind(replace) {
  if (!activeEditorTab()) {
    toast('请先打开一个文件', 'info', 1500);
    return;
  }
  editor.focus();
  editor.cm.execCommand(replace ? 'replace' : 'find');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success', 1400);
  } catch {
    toast('复制失败，剪贴板不可用', 'error');
  }
}

async function copySelection() {
  if (!activeEditorTab()) return;
  const sel = editor.cm.getSelection();
  if (!sel) { toast('没有选中的内容', 'info', 1400); return; }
  copyText(sel);
}

async function cutSelection() {
  if (!activeEditorTab()) return;
  const sel = editor.cm.getSelection();
  if (!sel) { toast('没有选中的内容', 'info', 1400); return; }
  await copyText(sel);
  editor.cm.replaceSelection('');
}

async function pasteClipboard() {
  if (!activeEditorTab()) return;
  editor.focus();
  try {
    const text = await navigator.clipboard.readText();
    editor.cm.replaceSelection(text);
  } catch {
    toast('无法读取剪贴板，请使用 Ctrl+V', 'warn', 2200);
  }
}

function formatJson() {
  if (!activeEditorTab()) return;
  const cm = editor.cm;
  const sel = cm.getSelection();
  const text = sel || cm.getValue();
  try {
    const parsed = JSON.parse(text);
    const pretty = JSON.stringify(parsed, null, 2);
    if (sel) cm.replaceSelection(pretty);
    else cm.setValue(pretty);
    toast('JSON 已格式化', 'success', 1500);
  } catch (err) {
    toast('JSON 解析失败：' + err.message, 'error', 3800);
  }
}

function changeCase(mode) {
  if (!activeEditorTab()) return;
  const cm = editor.cm;
  const sel = cm.getSelection();
  const text = sel || cm.getValue();
  const next = mode === 'upper' ? text.toUpperCase() : text.toLowerCase();
  if (sel) cm.replaceSelection(next);
  else cm.setValue(next);
}

// ------------------------------------------------------------------ file finder (Everything style)

function finderScopes() {
  const list = [];
  const add = (p, label) => {
    if (!p) return;
    if (list.some((x) => samePath(x.path, p))) return;
    list.push({ path: p, label });
  };
  const names = { home: '主目录', desktop: '桌面', documents: '文档', downloads: '下载' };

  if (state.root) add(state.root, '当前文件夹');
  if (state.home) add(state.home, '主目录');
  for (const s of (state.info && state.info.shortcuts) || []) add(s.path, names[s.key] || s.key);
  for (const root of (state.info && state.info.roots) || []) add(root, '磁盘 ' + root.replace(/[\\/]+$/, ''));
  return list;
}

function finderScopeName(scope) {
  if (samePath(scope, state.root)) return '当前文件夹';
  if (samePath(scope, state.home)) return '主目录';
  const names = { home: '主目录', desktop: '桌面', documents: '文档', downloads: '下载' };
  const hit = ((state.info && state.info.shortcuts) || []).find((s) => samePath(s.path, scope));
  if (hit) return names[hit.key] || hit.key;
  if (/^[a-zA-Z]:[\\/]?$/.test(scope)) return '磁盘 ' + scope.slice(0, 2);
  return baseName(scope) || scope;
}

function markQueryMatches(text, query) {
  const lower = String(text).toLowerCase();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((t) => t && !/[*?]/.test(t));
  if (!terms.length) return escapeHtml(text);
  const idx = new Set();
  for (const term of terms) {
    let from = 0;
    let at = lower.indexOf(term, from);
    while (at >= 0) {
      for (let i = 0; i < term.length; i++) idx.add(at + i);
      from = at + term.length;
      at = lower.indexOf(term, from);
    }
  }
  return highlightIndices(text, [...idx]);
}

function openQuickOpen() {
  const scopes = finderScopes();
  if (!scopes.length) {
    toast('请先打开一个文件夹，或检查本地服务是否可用', 'warn');
    return;
  }

  let scope = scopes[0].path;
  let files = [];
  let matched = 0;
  let hasMore = false;
  let capped = false;
  let indexed = 0;
  let building = false;
  let truncated = false;
  let error = '';
  let loading = true;
  let searching = false;
  let sel = 0;
  let seq = 0;
  let closed = false;
  let poll = null;

  const input = h('input', {
    class: 'palette-input',
    placeholder: '输入文件名或路径，支持 * 和 ? …',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const scopeSel = h('select', { class: 'select sm finder-scope', title: '搜索范围' },
    scopes.map((s) => h('option', { value: s.path, selected: samePath(s.path, scope), title: s.path }, s.label))
  );
  const statusEl = h('div', { class: 'finder-status' });
  const results = h('div', { class: 'palette-results tall finder-results' });
  const hint = h('div', { class: 'palette-hint' });
  const reindexBtn = h('button', {
    class: 'link-btn finder-refresh',
    title: '重新扫描此范围并建立索引 (F5)',
    onClick: () => rebuildIndex(),
  }, icon('refresh-cw'), '刷新索引');
  const body = h('div', { class: 'finder' },
    h('div', { class: 'finder-bar' },
      h('div', { class: 'palette-search' }, icon('search'), input, h('kbd', {}, 'Esc')),
      scopeSel
    ),
    statusEl,
    results,
    h('div', { class: 'finder-foot' }, hint, reindexBtn)
  );
  const modal = openModal({
    title: '快速查找文件',
    width: '780px',
    body,
    onClose: () => {
      closed = true;
      seq++;
      clearTimeout(poll);
    },
  });

  const query = () => input.value.trim();

  function recentItems() {
    const scopeLen = scope.replace(/[\\/]+$/, '').length;
    return state.recent.files
      .filter((p) => insidePath(p, scope))
      .slice(0, 40)
      .map((p) => ({
        path: p,
        name: baseName(p),
        rel: p.slice(scopeLen).replace(/^[\\/]+/, ''),
      }));
  }

  function renderStatus() {
    let detail;
    if (error) detail = '索引失败：' + error;
    else if (loading && !indexed) detail = '正在准备索引…';
    else if (building) detail = `正在索引… ${indexed.toLocaleString()} 项（结果会持续补充）`;
    else if (indexed) detail = `已索引 ${indexed.toLocaleString()} 项`;
    else detail = '尚未建立索引';
    if (truncated) detail += ' · 已达上限';
    statusEl.replaceChildren(
      h('span', { class: 'finder-scope-path', title: scope, text: scope }),
      h('span', { class: 'dot-sep', text: '·' }),
      h('span', { class: building ? 'finder-building' : '', text: detail })
    );
  }

  function render() {
    const q = query();
    const items = q ? files : recentItems();
    sel = items.length ? Math.min(Math.max(sel, 0), items.length - 1) : 0;
    results.replaceChildren();

    if (!items.length) {
      let message;
      if (q) message = searching ? '正在搜索…' : building ? '正在索引，暂时没有匹配结果…' : '没有匹配的文件';
      else message = '输入文件名开始搜索；支持 * 和 ? 通配符';
      results.appendChild(h('div', { class: 'palette-empty' }, message));
    }

    items.forEach((item, i) => {
      const dir = item.rel && item.rel.includes('/')
        ? item.rel.slice(0, item.rel.lastIndexOf('/'))
        : (item.rel || dirName(item.path));
      const row = h('button', {
        class: `palette-row finder-row${i === sel ? ' selected' : ''}`,
        title: item.path,
        onClick: () => openItem(item),
      },
        h('span', { class: 'palette-icon' },
          icon(item.isDir ? 'folder' : iconForTab(item.path, item.name))
        ),
        h('span', { class: 'finder-main' },
          h('span', { class: 'finder-name', html: q ? markQueryMatches(item.name, q) : escapeHtml(item.name) }),
          h('span', { class: 'finder-path', text: dir || ' ' })
        ),
        h('span', { class: 'palette-key', text: item.isDir ? '文件夹' : formatBytes(item.size) })
      );
      results.appendChild(row);
    });

    hint.textContent = q
      ? (searching && !items.length
        ? '正在搜索… · Esc 关闭'
        : `${matched.toLocaleString()}${capped ? '+' : ''} 个匹配${hasMore ? '（显示前 ' + items.length + ' 个）' : ''} · ↑↓ 选择 · Enter 打开 · Shift+Enter 定位`)
      : `最近打开的文件 · 输入关键词搜索 ${finderScopeName(scope)}`;

    const selected = results.querySelector('.palette-row.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  function schedulePoll() {
    clearTimeout(poll);
    if (closed || !building) return;
    poll = setTimeout(() => refresh(), 1000);
  }

  async function refresh() {
    const my = ++seq;
    const q = query();
    if (q && !files.length) {
      searching = true;
      render();
    }
    try {
      const data = await api.indexSearch({ root: scope, q, limit: 150, dirs: 1 });
      if (closed || my !== seq) return;
      loading = false;
      searching = false;
      files = q ? data.results || [] : [];
      matched = data.matched || files.length;
      hasMore = !!data.hasMore;
      capped = !!data.capped;
      indexed = data.indexed || 0;
      building = !!data.building;
      truncated = !!data.truncated;
      error = data.error || '';
      renderStatus();
      render();
      schedulePoll();
    } catch (err) {
      if (closed || my !== seq) return;
      loading = false;
      searching = false;
      error = err.message;
      building = false;
      renderStatus();
      render();
    }
  }

  async function rebuildIndex() {
    try {
      await api.indexBuild(scope);
      toast('正在重新扫描并建立索引…', 'info', 1800);
      building = true;
      error = '';
      renderStatus();
      refresh();
    } catch (err) {
      toast('索引失败：' + err.message, 'error');
    }
  }

  function openItem(item) {
    modal.close();
    if (item.isDir) {
      setRoot(item.path);
      switchSidebar('explorer');
    } else {
      openFile(item.path);
    }
  }

  function revealItem(item) {
    if (!item) return;
    api.reveal(item.path).then(() => modal.close()).catch((err) => toast(err.message, 'error'));
  }

  function currentItems() {
    return query() ? files : recentItems();
  }

  const searchSoon = debounce(() => { refresh(); }, 140);

  input.addEventListener('input', () => {
    sel = 0;
    render();
    searchSoon();
  });

  input.addEventListener('keydown', (e) => {
    const items = currentItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = Math.min(items.length - 1, sel + 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[sel];
      if (item) {
        if (e.shiftKey) revealItem(item);
        else openItem(item);
        return;
      }
      const q = query();
      if (q && /^([a-zA-Z]:[\\/]|~[\\/]|\/)/.test(q)) {
        modal.close();
        openFile(q);
      }
    } else if (e.key === 'F5') {
      e.preventDefault();
      rebuildIndex();
    }
  });

  scopeSel.addEventListener('change', () => {
    scope = scopeSel.value;
    files = [];
    matched = 0;
    hasMore = false;
    capped = false;
    indexed = 0;
    building = false;
    truncated = false;
    error = '';
    loading = true;
    searching = false;
    sel = 0;
    renderStatus();
    render();
    refresh();
    input.focus();
  });

  renderStatus();
  render();
  refresh();
  setTimeout(() => input.focus(), 50);
}

function highlightIndices(text, idx) {
  const set = new Set(idx);
  let out = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit && !open) { out += '<mark>'; open = true; }
    if (!hit && open) { out += '</mark>'; open = false; }
    out += escapeHtml(text[i]);
  }
  if (open) out += '</mark>';
  return out;
}

function openCommandPalette() {
  const input = h('input', {
    class: 'palette-input',
    placeholder: '输入命令名称…',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const results = h('div', { class: 'palette-results tall' });
  const hint = h('div', { class: 'palette-hint', text: '↑↓ 选择 · Enter 执行 · Esc 关闭' });
  const body = h('div', { class: 'palette' },
    h('div', { class: 'palette-search' }, icon('command'), input, h('kbd', {}, 'Esc')),
    results,
    hint
  );
  const modal = openModal({ title: '命令面板', width: '680px', body });
  let filtered = [];
  let sel = 0;

  function compute() {
    const q = input.value.trim();
    if (!q) { filtered = COMMANDS.slice(); return; }
    const scored = [];
    for (const cmd of COMMANDS) {
      const m = fuzzyMatch(cmd.label, q);
      if (m) scored.push({ ...cmd, score: m.score, idx: m.idx });
    }
    scored.sort((a, b) => b.score - a.score);
    filtered = scored;
  }

  function render() {
    compute();
    sel = Math.min(sel, Math.max(0, filtered.length - 1));
    results.replaceChildren();
    if (!filtered.length) results.appendChild(h('div', { class: 'palette-empty', text: '没有匹配的命令' }));
    filtered.forEach((cmd, i) => {
      results.appendChild(h('button', {
        class: `palette-row${i === sel ? ' selected' : ''}`,
        onClick: () => { modal.close(); runCommand(cmd.id); },
      },
        h('span', { class: 'palette-icon' }, icon(cmd.icon || 'command')),
        h('span', { class: 'palette-main', html: input.value.trim() ? highlightIndices(cmd.label, cmd.idx || []) : escapeHtml(cmd.label) }),
        cmd.key ? h('span', { class: 'palette-key', text: cmd.key }) : null
      ));
    });
    const selected = results.querySelector('.palette-row.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[sel];
      if (cmd) { modal.close(); runCommand(cmd.id); }
    }
  });
  render();
  setTimeout(() => input.focus(), 60);
}

// ------------------------------------------------------------------ search panel

function initSearchPanel() {
  const input = dom.searchInput;
  const caseBtn = $('searchCase');
  const wordBtn = $('searchWord');
  const regexBtn = $('searchRegex');
  const replaceToggle = $('searchReplaceToggle');
  const replaceRow = $('replaceRow');
  const replaceInput = $('searchReplace');
  const replaceBtn = $('replaceAllBtn');
  const btn = $('searchBtn');

  const updateToggles = () => {
    caseBtn.classList.toggle('active', !!settings.search.caseSensitive);
    wordBtn.classList.toggle('active', !!settings.search.wholeWord);
    regexBtn.classList.toggle('active', !!settings.search.regex);
  };
  updateToggles();

  const toggle = (key) => {
    settings.search[key] = !settings.search[key];
    saveSettings();
    updateToggles();
  };
  caseBtn.addEventListener('click', () => toggle('caseSensitive'));
  wordBtn.addEventListener('click', () => toggle('wholeWord'));
  regexBtn.addEventListener('click', () => toggle('regex'));

  replaceToggle.addEventListener('change', () => {
    replaceRow.hidden = !replaceToggle.checked;
    if (replaceToggle.checked) setTimeout(() => replaceInput.focus(), 30);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
  });
  btn.addEventListener('click', () => runSearch());
  replaceBtn.addEventListener('click', () => replaceAll());
  $('searchClear').addEventListener('click', () => {
    state.lastSearch = null;
    dom.searchResults.replaceChildren();
    dom.searchSummary.textContent = '';
  });
}

function searchParams() {
  return {
    root: state.root,
    q: dom.searchInput.value.trim(),
    caseSensitive: settings.search.caseSensitive ? '1' : '',
    wholeWord: settings.search.wholeWord ? '1' : '',
    regex: settings.search.regex ? '1' : '',
    include: $('searchInclude').value.trim(),
    exclude: $('searchExclude').value.trim(),
    max: 500,
  };
}

async function runSearch() {
  const params = searchParams();
  if (!params.q) { toast('请输入搜索内容', 'warn'); return; }
  if (!params.root) { toast('请先打开一个文件夹', 'warn'); return; }
  const btn = $('searchBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm"></span>搜索中…';
  dom.searchSummary.textContent = '正在搜索…';
  dom.searchResults.replaceChildren();
  searchCollapsed.clear();
  try {
    const data = await api.search(params);
    state.lastSearch = { data, params };
    renderSearchResults(data, params);
  } catch (err) {
    dom.searchSummary.textContent = '搜索失败：' + err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('search').outerHTML}搜索`;
  }
}

function highlightOccurrences(text, params) {
  if (!params.q) return escapeHtml(text);
  let src = params.regex ? params.q : params.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (params.wholeWord) src = `\\b(?:${src})\\b`;
  let re;
  try { re = new RegExp(src, params.caseSensitive ? 'g' : 'gi'); } catch { return escapeHtml(text); }
  let out = '';
  let last = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 50) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += escapeHtml(text.slice(last, m.index));
    out += '<mark>' + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

function renderSearchResults(data, params) {
  const summary = [];
  summary.push(`在 ${data.results.length} 个文件中找到 ${data.total.toLocaleString()} 处匹配`);
  if (data.truncated) summary.push('（结果已截断）');
  dom.searchSummary.textContent = summary.join(' ');
  dom.searchResults.replaceChildren();
  if (!data.results.length) {
    dom.searchResults.appendChild(h('div', { class: 'panel-empty small' }, icon('search'), h('p', { text: '没有找到匹配内容' })));
    return;
  }
  for (const file of data.results) {
    const collapsed = searchCollapsed.has(file.path);
    const group = h('div', { class: 'search-file' });
    const header = h('button', {
      class: 'search-file-head',
      onClick: () => {
        if (searchCollapsed.has(file.path)) searchCollapsed.delete(file.path);
        else searchCollapsed.add(file.path);
        renderSearchResults(data, params);
      },
    },
      icon(collapsed ? 'chevron-right' : 'chevron-down'),
      h('span', { class: 'sf-name', text: file.name }),
      h('span', { class: 'sf-count', text: String(file.matches.length) }),
      h('span', { class: 'sf-dir', title: file.path, text: file.rel !== file.name ? file.rel.slice(0, -file.name.length) : '' })
    );
    group.appendChild(header);
    if (!collapsed) {
      const list = h('div', { class: 'search-matches' });
      for (const m of file.matches.slice(0, 60)) {
        list.appendChild(h('button', {
          class: 'search-match',
          title: `${file.path}:${m.line}`,
          onClick: () => openFile(file.path, { line: m.line, ch: m.col, length: m.length }),
        },
          h('span', { class: 'sm-line', text: String(m.line) }),
          h('span', { class: 'sm-text', html: highlightOccurrences(m.text, params) })
        ));
      }
      if (file.matches.length > 60) {
        list.appendChild(h('div', { class: 'sm-more', text: `还有 ${file.matches.length - 60} 处…` }));
      }
      group.appendChild(list);
    }
    dom.searchResults.appendChild(group);
  }
}

async function replaceAll() {
  const params = searchParams();
  if (!params.q) { toast('请输入查找内容', 'warn'); return; }
  if (!params.root) { toast('请先打开一个文件夹', 'warn'); return; }
  const replacement = $('searchReplace').value;
  const total = state.lastSearch && state.lastSearch.data.total;
  const ok = await confirmDialog({
    title: '全部替换',
    message: `将在「${state.root}」中把匹配内容替换为「${replacement}」。`,
    detail: total ? `当前搜索结果约 ${total} 处，替换会直接写入文件且无法撤销。` : '替换会直接写入文件且无法撤销。',
    confirmText: '全部替换',
    danger: true,
  });
  if (!ok) return;
  const btn = $('replaceAllBtn');
  btn.disabled = true;
  btn.textContent = '替换中…';
  try {
    const res = await api.replace({
      root: params.root,
      find: params.q,
      replace: replacement,
      caseSensitive: !!params.caseSensitive,
      regex: !!params.regex,
      wholeWord: !!params.wholeWord,
      include: params.include,
      exclude: params.exclude,
    });
    toast(`已在 ${res.changedFiles} 个文件中替换 ${res.replacements} 处`, 'success', 3600);
    const changed = new Set(res.changed.map((c) => pkey(c.path)));
    for (const tab of state.tabs) {
      if (tab.kind === 'editor' && tab.path && changed.has(pkey(tab.path))) {
        if (!isDirty(tab)) await reloadFileQuiet(tab);
        else toast(`「${tab.name}」有未保存更改，未自动刷新`, 'warn', 3600);
      }
    }
    if (state.root) explorer.refreshRoot();
    await runSearch();
  } catch (err) {
    toast('替换失败：' + err.message, 'error', 4200);
  } finally {
    btn.disabled = false;
    btn.textContent = '全部替换';
  }
}

async function reloadFileQuiet(tab) {
  try {
    const data = await api.read(tab.path);
    suppressDocEvents = true;
    tab.doc.setValue(data.content);
    suppressDocEvents = false;
    tab.encoding = data.encoding;
    tab.eol = data.eol;
    tab.size = data.size;
    tab.mtime = data.mtime;
    tab.metaDirty = false;
    tab.cleanGen = tab.doc.changeGeneration();
    if (tab.id === state.activeId) updateStatus();
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ settings dialog

function openSettings() {
  const themeSeg = h('div', { class: 'segmented wide' });
  const renderTheme = () => {
    themeSeg.replaceChildren(...[
      ['dark', '深色', 'moon'],
      ['light', '浅色', 'sun'],
      ['system', '跟随系统', 'monitor'],
    ].map(([value, label, ic]) => h('button', {
      class: settings.theme === value ? 'active' : '',
      onClick: () => {
        settings.theme = value;
        saveSettings();
        applyTheme();
        renderTheme();
      },
    }, icon(ic), label)));
  };
  renderTheme();

  const fontSel = h('select', { class: 'select' },
    ...[11, 12, 13, 14, 15, 16, 18, 20, 22].map((n) =>
      h('option', { value: String(n), selected: settings.fontSize === n }, `${n} px`))
  );
  fontSel.addEventListener('change', () => {
    settings.fontSize = Number(fontSel.value);
    saveSettings();
    applySettings();
  });

  const tabSel = h('select', { class: 'select' },
    ...[2, 4, 8].map((n) => h('option', { value: String(n), selected: settings.tabSize === n }, `${n} 个空格`))
  );
  tabSel.addEventListener('change', () => {
    settings.tabSize = Number(tabSel.value);
    const tab = activeEditorTab();
    if (tab) { tab.tabSize = settings.tabSize; }
    saveSettings();
    applySettings();
    updateStatus();
  });

  const spacesCb = h('input', { type: 'checkbox', checked: settings.spaces });
  spacesCb.addEventListener('change', () => {
    settings.spaces = spacesCb.checked;
    const tab = activeEditorTab();
    if (tab) tab.indentWithTabs = !settings.spaces;
    saveSettings();
    applySettings();
    updateStatus();
  });
  const wrapCb = h('input', { type: 'checkbox', checked: settings.wrap });
  wrapCb.addEventListener('change', () => { settings.wrap = wrapCb.checked; saveSettings(); applySettings(); });
  const autosaveCb = h('input', { type: 'checkbox', checked: settings.autosave });
  autosaveCb.addEventListener('change', () => { settings.autosave = autosaveCb.checked; saveSettings(); });
  const trailingCb = h('input', { type: 'checkbox', checked: settings.showTrailing });
  trailingCb.addEventListener('change', () => { settings.showTrailing = trailingCb.checked; saveSettings(); applySettings(); });
  const restoreCb = h('input', { type: 'checkbox', checked: settings.restore });
  restoreCb.addEventListener('change', () => { settings.restore = restoreCb.checked; saveSettings(); });

  const ignoreCaseCb = h('input', { type: 'checkbox', checked: settings.compare.ignoreCase });
  ignoreCaseCb.addEventListener('change', () => { settings.compare.ignoreCase = ignoreCaseCb.checked; saveSettings(); });
  const ignoreBlankCb = h('input', { type: 'checkbox', checked: settings.compare.ignoreBlankLines });
  ignoreBlankCb.addEventListener('change', () => { settings.compare.ignoreBlankLines = ignoreBlankCb.checked; saveSettings(); });
  const wsSel = h('select', { class: 'select' },
    h('option', { value: 'none', selected: settings.compare.ignoreWhitespace === 'none' }, '不忽略'),
    h('option', { value: 'trailing', selected: settings.compare.ignoreWhitespace === 'trailing' }, '忽略行尾空白'),
    h('option', { value: 'all', selected: settings.compare.ignoreWhitespace === 'all' }, '忽略所有空白')
  );
  wsSel.addEventListener('change', () => { settings.compare.ignoreWhitespace = wsSel.value; saveSettings(); });
  const cmpWrapCb = h('input', { type: 'checkbox', checked: settings.compare.wrap !== false });
  cmpWrapCb.addEventListener('change', () => { settings.compare.wrap = cmpWrapCb.checked; saveSettings(); });

  const row = (label, control, hint) => h('div', { class: 'setting-row' },
    h('div', { class: 'setting-label' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null),
    h('div', { class: 'setting-control' }, control)
  );

  const body = h('div', { class: 'settings' },
    h('section', { class: 'settings-section' },
      h('h3', {}, icon('sun'), '外观'),
      row('主题', themeSeg),
      row('编辑器字号', fontSel),
      row('自动换行', wrapCb, '长行在编辑器中折行显示'),
      row('显示空白字符', trailingCb, '高亮行尾空格与制表符')
    ),
    h('section', { class: 'settings-section' },
      h('h3', {}, icon('indent'), '编辑器'),
      row('制表符宽度', tabSel),
      row('使用空格缩进', spacesCb),
      row('自动保存', autosaveCb, '停止输入约 1.4 秒后自动保存已有文件'),
      row('恢复上次会话', restoreCb, '下次启动时重新打开标签页')
    ),
    h('section', { class: 'settings-section' },
      h('h3', {}, icon('git-compare'), '比较默认选项'),
      row('忽略大小写', ignoreCaseCb),
      row('忽略空白', wsSel),
      row('忽略空行', ignoreBlankCb),
      row('默认自动换行', cmpWrapCb, '对比视图中的长行自动折行')
    )
  );

  const modal = openModal({
    title: '设置',
    width: '640px',
    body,
    footer: [
      h('button', {
        class: 'btn',
        onClick: async () => {
          const ok = await confirmDialog({
            title: '重置设置',
            message: '确定要把所有设置恢复为默认值吗？',
            confirmText: '重置',
            danger: true,
          });
          if (!ok) return;
          settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
          saveSettings();
          applySettings();
          modal.close();
          openSettings();
          toast('设置已重置', 'success', 1600);
        },
      }, '重置设置'),
      h('button', { class: 'btn primary', onClick: () => modal.close() }, '完成'),
    ],
  });
}

function openShortcuts() {
  const rows = [
    ['新建 / 打开文件', 'Ctrl + N / Ctrl + O'],
    ['打开文件夹', 'Ctrl + Shift + O'],
    ['保存 / 另存为', 'Ctrl + S / Ctrl + Shift + S'],
    ['关闭标签', 'Ctrl + W'],
    ['快速查找文件', 'Ctrl + P'],
    ['命令面板', 'Ctrl + Shift + P'],
    ['在当前文件查找', 'Ctrl + F'],
    ['在当前文件替换', 'Ctrl + H'],
    ['在文件夹中搜索', 'Ctrl + Shift + F'],
    ['转到行', 'Ctrl + G'],
    ['跳转差异', 'Alt + ↓ / Alt + ↑'],
    ['比较文件 / 文件夹', 'Ctrl + Alt + C / Ctrl + Alt + D'],
    ['复制 / 删除当前行', 'Ctrl + D / Ctrl + Shift + K'],
    ['注释 / 取消注释', 'Ctrl + /'],
    ['显示 / 隐藏侧边栏', 'Ctrl + B'],
    ['预览 Markdown / JSON', 'Ctrl + Shift + V'],
    ['标签页切换', 'Ctrl + Tab / Ctrl + Shift + Tab'],
    ['设置', 'Ctrl + ,'],
    ['本帮助', 'F1'],
  ];
  const table = h('div', { class: 'shortcut-table' },
    rows.map(([label, key]) => h('div', { class: 'shortcut-row' },
      h('span', { text: label }),
      h('kbd', { text: key })
    ))
  );
  openModal({ title: '键盘快捷键', width: '560px', body: table });
}

function openAbout() {
  const info = state.info || {};
  const body = h('div', { class: 'about' },
    h('div', { class: 'about-logo' },
      h('svg', { viewBox: '0 0 64 64', width: 76, height: 76, attrs: { 'aria-hidden': 'true' }, html: `
        <path d="M17 8h19l14 14v34a5 5 0 0 1-5 5H17a5 5 0 0 1-5-5V13a5 5 0 0 1 5-5z" fill="var(--accent)" opacity=".95"/>
        <path d="M36 8l14 14H36z" fill="#08131d" opacity=".34"/>
        <path d="M22 30h20M22 38h20M22 46h12" stroke="#08131d" stroke-width="3.4" stroke-linecap="round" opacity=".88"/>
      ` })
    ),
    h('h2', { text: 'FileDock' }),
    h('p', { class: 'about-sub', text: '本地编辑器与文件对比工具 · 参考 Notepad++ 与 Beyond Compare' }),
    h('div', { class: 'about-grid' },
      h('div', {}, h('span', {}, '版本'), h('b', {}, info.version || '1.0.0')),
      h('div', {}, h('span', {}, '运行时'), h('b', {}, info.node || 'Tauri')),
      h('div', {}, h('span', {}, '主目录'), h('b', { title: info.home || '' }, info.home || '—')),
      h('div', {}, h('span', {}, '应用目录'), h('b', { title: info.appRoot || '' }, info.appRoot || '—'))
    ),
    h('ul', { class: 'about-features' },
      h('li', {}, '多标签编辑器 · 语法高亮 · 查找替换 · 编码与换行符转换'),
      h('li', {}, '文件并排 / 行内对比 · 行级与词级差异高亮'),
      h('li', {}, '文件夹递归比较 · 快速过滤 · 单文件与批量同步'),
      h('li', {}, 'Everything 式快速查找 · 后台文件名索引 · 跨磁盘搜索'),
      h('li', {}, '本地运行，零依赖，不上传任何文件')
    ),
    h('p', { class: 'about-foot', text: '提示：按 Ctrl+Shift+P 打开命令面板，按 F1 查看快捷键。' })
  );
  openModal({ title: '关于 FileDock', width: '600px', body });
}

// ------------------------------------------------------------------ toolbar & global events

function initGlobalClicks() {
  document.addEventListener('click', (e) => {
    const cmdEl = e.target.closest('[data-cmd]');
    if (cmdEl && !cmdEl.disabled) {
      e.preventDefault();
      closeMenus();
      runCommand(cmdEl.dataset.cmd);
      return;
    }
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      e.preventDefault();
      const action = actionEl.dataset.action;
      if (action === 'compare-files') openCompareFiles();
      else if (action === 'compare-folders') openCompareFolders();
      else if (action === 'file-search') openQuickOpen();
      else if (action === 'open-demo') openDemo();
      return;
    }
  });

  dom.tabstrip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      dom.tabstrip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}

// ------------------------------------------------------------------ drag & drop

function droppedPath(file) {
  const bridge = window.filedock;
  try {
    if (bridge && typeof bridge.getPathForFile === 'function') {
      const value = bridge.getPathForFile(file);
      if (value) return value;
    }
  } catch { /* fall back to File.path (webkit) */ }
  return file.path || '';
}

const TEXT_DROP_RE = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|log|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|ts|jsx|tsx|py|go|rs|java|c|h|cpp|hpp|cs|php|rb|sh|bat|cmd|ps1|sql|diff|patch)$/i;

async function openDroppedItems(files) {
  let openedFiles = 0;
  let openedFolders = 0;
  let skipped = 0;
  let needsDesktop = false;

  for (const file of files.slice(0, 16)) {
    const path = droppedPath(file);
    if (!path) {
      // No absolute path available; still allow plain text content to open.
      if (file.size <= 2 * 1024 * 1024 && TEXT_DROP_RE.test(file.name || '')) {
        try {
          const text = await file.text();
          addUntitledTab(file.name, text, { dirty: true });
          openedFiles++;
        } catch {
          skipped++;
        }
      } else {
        needsDesktop = true;
        skipped++;
      }
      continue;
    }
    try {
      const st = await api.stat(path);
      if (st.isDir) {
        await setRoot(path);
        openedFolders++;
      } else {
        const tab = await openFile(path);
        if (tab) openedFiles++;
        else skipped++;
      }
    } catch {
      skipped++;
    }
  }

  if (openedFiles || openedFolders) {
    const parts = [];
    if (openedFiles) parts.push(`${openedFiles} 个文件`);
    if (openedFolders) parts.push(`${openedFolders} 个文件夹`);
    toast(`已打开 ${parts.join('、')}`, 'success', 1800);
  } else if (needsDesktop) {
    toast('无法获取拖入项的完整路径，请改用「打开文件 / 文件夹」按钮', 'warn', 4200);
  } else if (skipped) {
    toast('拖入的内容无法打开', 'warn', 2600);
  }
}

async function openDroppedPaths(paths) {
  let openedFiles = 0;
  let openedFolders = 0;
  let skipped = 0;

  for (const path of (paths || []).slice(0, 16)) {
    if (!path) continue;
    try {
      const st = await api.stat(path);
      if (st.isDir) {
        await setRoot(path);
        openedFolders++;
      } else {
        const tab = await openFile(path);
        if (tab) openedFiles++;
        else skipped++;
      }
    } catch {
      skipped++;
    }
  }

  if (openedFiles || openedFolders) {
    const parts = [];
    if (openedFiles) parts.push(`${openedFiles} 个文件`);
    if (openedFolders) parts.push(`${openedFolders} 个文件夹`);
    toast(`已打开 ${parts.join('、')}`, 'success', 1800);
  } else if (skipped) {
    toast('拖入的内容无法打开', 'warn', 2600);
  }
}

function initDragAndDrop() {
  const overlay = h('div', { class: 'drop-overlay', id: 'dropOverlay' },
    h('div', { class: 'drop-card' },
      h('div', { class: 'drop-icon' }, icon('folder-open')),
      h('strong', {}, '松开以打开'),
      h('span', {}, '文件会在编辑器中打开，文件夹会载入资源管理器')
    )
  );
  document.body.appendChild(overlay);

  const bridge = window.filedock;
  if (bridge && typeof bridge.onFileDrop === 'function') {
    bridge.onFileDrop((paths) => {
      overlay.classList.remove('active');
      openDroppedPaths(paths);
    });
    bridge.onDragState((active) => {
      overlay.classList.toggle('active', !!active);
    });
  }

  let depth = 0;
  const hasFiles = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.from(types).includes('Files');
  };
  const hide = () => {
    depth = 0;
    overlay.classList.remove('active');
  };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add('active');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.remove('active');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    hide();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) await openDroppedItems(files);
  }, true);
}

function initResizer() {
  let dragging = false;
  dom.resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    const startX = e.clientX;
    const startW = dom.sidebar.getBoundingClientRect().width;
    dom.resizer.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const width = Math.max(196, Math.min(560, startW + ev.clientX - startX));
      settings.sidebarWidth = Math.round(width);
      dom.sidebar.style.width = settings.sidebarWidth + 'px';
    };
    const up = () => {
      dragging = false;
      dom.resizer.removeEventListener('pointermove', move);
      dom.resizer.removeEventListener('pointerup', up);
      saveSettings();
      editor.refresh();
    };
    dom.resizer.addEventListener('pointermove', move);
    dom.resizer.addEventListener('pointerup', up);
    void dragging;
  });
}

function initGlobalShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenus();
      document.querySelectorAll('.popover').forEach((p) => p.remove());
      return;
    }
    if (document.querySelector('.modal-overlay')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const pane = state.activePane;

    if (e.key === 'F1') { e.preventDefault(); openShortcuts(); return; }

    if (mod) {
      if (key === 's') { e.preventDefault(); if (e.shiftKey) { const t = activeEditorTab(); if (t) saveTab(t, { saveAs: true }); } else saveActive(); return; }
      if (key === 'n') { e.preventDefault(); newFile(); return; }
      if (key === 'o' && e.shiftKey) { e.preventDefault(); chooseFolder(); return; }
      if (key === 'o') { e.preventDefault(); chooseAndOpenFile(); return; }
      if (key === 'p' && e.shiftKey) { e.preventDefault(); openCommandPalette(); return; }
      if (key === 'p') { e.preventDefault(); openQuickOpen(); return; }
      if (key === 'w') { e.preventDefault(); const t = activeTab(); if (t) closeTab(t.id); return; }
      if (key === 'b') { e.preventDefault(); runCommand('toggleSidebar'); return; }
      if (key === 'v' && e.shiftKey) { e.preventDefault(); togglePreview(); return; }
      if (key === 'e' && e.shiftKey) { e.preventDefault(); switchSidebar('explorer'); return; }
      if (key === 'f' && e.shiftKey) { e.preventDefault(); switchSidebar('search'); dom.searchInput.focus(); return; }
      if (key === ',') { e.preventDefault(); openSettings(); return; }
      if (key === 'tab') {
        e.preventDefault();
        if (!state.tabs.length) return;
        const idx = state.tabs.findIndex((t) => t.id === state.activeId);
        const dir = e.shiftKey ? -1 : 1;
        const next = state.tabs[(idx + dir + state.tabs.length) % state.tabs.length];
        activateTab(next.id);
        return;
      }
      if (e.altKey && key === 'c') { e.preventDefault(); openCompareFiles(); return; }
      if (e.altKey && key === 'd') { e.preventDefault(); openCompareFolders(); return; }
      if (key === '=' || key === '+') { e.preventDefault(); changeFont(1); return; }
      if (key === '-') { e.preventDefault(); changeFont(-1); return; }
      return;
    }

    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      if (pane === 'editor') return; // CodeMirror moves lines
      if (pane === 'compare') {
        e.preventDefault();
        const tab = activeCompareTab();
        if (tab) compareView.navigateDiff(tab, e.key === 'ArrowDown' ? 1 : -1);
      }
    }
  }, true);

  window.addEventListener('beforeunload', (e) => {
    persistSession.flush();
    if (window.__filedockAllowUnload) return;
    if (state.tabs.some((t) => t.kind === 'editor' && isDirty(t))) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('resize', debounce(() => {
    if (editor) editor.refresh();
  }, 120));
}

// ------------------------------------------------------------------ start

window.__filedockUnsaved = () => state.tabs.some((t) => t.kind === 'editor' && isDirty(t));

init();
