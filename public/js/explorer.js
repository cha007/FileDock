import { api, config } from './api.js';
import {
  h, icon, hydrateIcons, toast, promptDialog, confirmDialog,
  pickPath, showContextMenu, joinPath, dirName, baseName, formatBytes,
} from './ui.js';

const isWin = () => config.platform === 'win32';
const pkey = (p) => (isWin() ? String(p).toLowerCase() : String(p));

const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'kts', 'lua', 'pl', 'r', 'dart', 'groovy', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql']);
const WEB_EXT = new Set(['html', 'htm', 'css', 'scss', 'less', 'sass', 'vue', 'svelte', 'xml', 'svg']);
const DATA_EXT = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'lock']);
const DOC_EXT = new Set(['md', 'markdown', 'txt', 'log', 'rst', 'adoc']);
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'pdf', 'mp3', 'mp4', 'avi', 'mov', 'woff', 'woff2', 'ttf', 'otf']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz']);

function categoryOf(ext) {
  if (CODE_EXT.has(ext)) return 'code';
  if (WEB_EXT.has(ext)) return 'web';
  if (DATA_EXT.has(ext)) return 'data';
  if (DOC_EXT.has(ext)) return 'doc';
  if (MEDIA_EXT.has(ext)) return 'media';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  return 'plain';
}

function iconFor(ext) {
  if (['json', 'jsonc'].includes(ext)) return 'braces';
  if (['md', 'markdown', 'txt', 'log', 'rst'].includes(ext)) return 'file-text';
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'html', 'htm', 'css', 'scss', 'less', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'sql', 'sh', 'bash', 'ps1'].includes(ext)) return 'file-code';
  if (ARCHIVE_EXT.has(ext)) return 'download';
  return 'file';
}

function validName(name) {
  if (!name || !name.trim()) return '请输入名称';
  if (/[\\/:*?"<>|]/.test(name)) return '名称不能包含 \\ / : * ? " < > |';
  return null;
}

export class Explorer {
  constructor(options) {
    this.opts = options;
    this.treeEl = options.treeEl;
    this.emptyEl = options.emptyEl;
    this.rootNameEl = options.rootNameEl;
    this.rootPathEl = options.rootPathEl;
    this.rootBarEl = options.rootBarEl;
    this.root = '';
    this.expanded = new Set();
    this.cache = new Map();
    this.selected = null;
    this.loading = new Set();

    this.treeEl.addEventListener('click', (e) => this.onClick(e));
    this.treeEl.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.treeEl.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.treeEl.addEventListener('keydown', (e) => this.onKeyDown(e));
    if (this.rootBarEl) {
      this.rootBarEl.addEventListener('click', () => {
        if (this.opts.onChooseRoot) this.opts.onChooseRoot();
      });
    }
  }

  async setRoot(root) {
    this.root = root || '';
    this.expanded.clear();
    this.cache.clear();
    this.selected = null;
    this.loading.clear();
    if (!this.root) {
      this.render();
      return;
    }
    this.expanded.add(pkey(this.root));
    await this.loadDir(this.root);
    this.render();
  }

  async loadDir(dir, { silent = false } = {}) {
    const key = pkey(dir);
    this.loading.add(key);
    try {
      const data = await api.list(dir);
      this.cache.set(key, data.entries);
      return data.entries;
    } catch (err) {
      this.cache.set(key, []);
      if (!silent) toast(`无法读取文件夹：${err.message}`, 'error');
      return [];
    } finally {
      this.loading.delete(key);
    }
  }

  async refreshRoot() {
    if (!this.root) return;
    const rootKey = pkey(this.root);
    this.cache.delete(rootKey);
    await this.loadDir(this.root);
    this.render();
  }

  async refreshDir(dir) {
    const key = pkey(dir);
    const wasExpanded = this.expanded.has(key);
    this.cache.delete(key);
    if (wasExpanded) await this.loadDir(dir);
    this.render();
  }

  collapseAll() {
    this.expanded.clear();
    if (this.root) this.expanded.add(pkey(this.root));
    this.render();
  }

  selectedDir() {
    if (!this.selected) return this.root;
    const entry = this.findEntry(this.selected);
    if (entry && entry.isDir) return entry.path;
    return dirName(this.selected) || this.root;
  }

  findEntry(path) {
    const key = pkey(path);
    if (this.cache.has(key)) {
      // no entry for the dir itself; search parent's list
    }
    const parent = dirName(path);
    const list = this.cache.get(pkey(parent));
    if (list) return list.find((e) => pkey(e.path) === key) || null;
    return null;
  }

  ensureVisible(dir) {
    if (!this.root) return;
    const rootKey = pkey(this.root);
    const dirKey = pkey(dir);
    if (dirKey === rootKey) return;
    this.expanded.add(rootKey);
    const rel = dir.slice(this.root.length).replace(/^[\\/]+/, '');
    const parts = rel.split(/[\\/]/).filter(Boolean);
    let cur = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = joinPath(cur, parts[i]);
      this.expanded.add(pkey(cur));
    }
    if (dir !== this.root) this.expanded.add(dirKey);
  }

  async reveal(path) {
    if (!this.root || !this.isInsideRoot(path)) {
      if (this.opts.onRevealOutside) this.opts.onRevealOutside(path);
      return;
    }
    const dir = dirName(path);
    this.ensureVisible(dir);
    const self = this;
    const chain = [];
    let cur = dir;
    while (self.isInsideRoot(cur)) {
      chain.unshift(cur);
      if (pkey(cur) === pkey(self.root)) break;
      cur = dirName(cur);
    }
    for (const d of chain) {
      if (!self.cache.has(pkey(d))) await self.loadDir(d, { silent: true });
    }
    self.selected = path;
    self.render();
    const key = pkey(path);
    const row = [...self.treeEl.querySelectorAll('.tree-row')].find((el) => pkey(el.dataset.path) === key);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      row.classList.add('selected');
    }
  }

  isInsideRoot(path) {
    if (!this.root) return false;
    const a = pkey(this.root);
    const b = pkey(path);
    return b === a || b.startsWith(a.endsWith('\\') || a.endsWith('/') ? a : a + (config.sep || '/'));
  }

  render() {
    if (!this.root) {
      this.emptyEl.hidden = false;
      this.treeEl.hidden = true;
      if (this.rootNameEl) this.rootNameEl.textContent = '资源管理器';
      if (this.rootPathEl) this.rootPathEl.textContent = '未打开文件夹';
      return;
    }
    this.emptyEl.hidden = true;
    this.treeEl.hidden = false;
    if (this.rootNameEl) this.rootNameEl.textContent = baseName(this.root) || '资源管理器';
    if (this.rootPathEl) {
      this.rootPathEl.textContent = this.root;
      this.rootPathEl.title = this.root;
    }
    const rootKey = pkey(this.root);
    const entries = this.cache.get(rootKey);
    this.treeEl.replaceChildren();
    if (!entries) {
      this.treeEl.appendChild(h('div', { class: 'tree-loading' }, h('span', { class: 'spinner sm' }), '加载中…'));
      return;
    }
    if (!entries.length) {
      this.treeEl.appendChild(h('div', { class: 'panel-empty small' }, icon('folder'), h('p', { text: '空文件夹' })));
      return;
    }
    this.renderEntries(entries, 0);
  }

  renderEntries(entries, depth) {
    for (const entry of entries) {
      const key = pkey(entry.path);
      const isDir = entry.isDir;
      const expanded = isDir && this.expanded.has(key);
      const row = h('div', {
        class: `tree-row${isDir ? ' dir' : ''}${this.selected === entry.path ? ' selected' : ''}`,
        dataset: { path: entry.path, dir: isDir ? '1' : '0' },
        style: { '--depth': depth },
        title: entry.path,
        tabindex: '0',
        attrs: { role: 'treeitem' },
      },
        h('span', { class: `twisty${isDir ? '' : ' empty'}` }, isDir ? icon(expanded ? 'chevron-down' : 'chevron-right') : null),
        h('span', { class: `tree-icon ${isDir ? 'folder' : categoryOf(entry.ext)}` }, icon(isDir ? (expanded ? 'folder-open' : 'folder') : iconFor(entry.ext))),
        h('span', { class: 'tree-name', text: entry.name }),
        isDir ? null : h('span', { class: 'tree-size', text: entry.size >= 1024 ? formatBytes(entry.size) : '' })
      );
      this.treeEl.appendChild(row);
      if (isDir && expanded) {
        const kids = this.cache.get(key);
        if (!kids) {
          this.treeEl.appendChild(h('div', { class: 'tree-loading', style: { '--depth': depth + 1 } },
            h('span', { class: 'spinner sm' }), '加载中…'));
        } else if (!kids.length) {
          this.treeEl.appendChild(h('div', { class: 'tree-empty', style: { '--depth': depth + 1 } }, '空文件夹'));
        } else {
          this.renderEntries(kids, depth + 1);
        }
      }
    }
  }

  async toggleDir(path) {
    const key = pkey(path);
    if (this.expanded.has(key)) {
      this.expanded.delete(key);
      this.render();
      return;
    }
    this.expanded.add(key);
    const needsLoad = !this.cache.has(key);
    this.render();
    if (needsLoad) {
      await this.loadDir(path);
      this.render();
    }
  }

  async onClick(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const entry = this.findEntry(row.dataset.path);
    if (!entry) return;
    this.selected = entry.path;
    this.treeEl.querySelectorAll('.tree-row.selected').forEach((el) => el.classList.remove('selected'));
    row.classList.add('selected');
    row.focus({ preventScroll: true });
    if (entry.isDir) {
      await this.toggleDir(entry.path);
    }
  }

  async onDblClick(e) {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    if (row.dataset.dir === '1') return;
    if (this.opts.onOpenFile) this.opts.onOpenFile(row.dataset.path);
  }

  onKeyDown(e) {
    if (!this.selected) return;
    const entry = this.findEntry(this.selected);
    if (!entry) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (entry.isDir) this.toggleDir(entry.path);
      else if (this.opts.onOpenFile) this.opts.onOpenFile(entry.path);
    } else if (e.key === 'F2') {
      e.preventDefault();
      this.renameEntry(entry);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      this.deleteEntry(entry);
    } else if (e.key === 'ArrowRight' && entry.isDir && !this.expanded.has(pkey(entry.path))) {
      this.toggleDir(entry.path);
    } else if (e.key === 'ArrowLeft' && entry.isDir && this.expanded.has(pkey(entry.path))) {
      this.toggleDir(entry.path);
    }
  }

  onContextMenu(e) {
    e.preventDefault();
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const entry = this.findEntry(row.dataset.path);
    if (!entry) return;
    this.selected = entry.path;
    this.treeEl.querySelectorAll('.tree-row.selected').forEach((el) => el.classList.remove('selected'));
    row.classList.add('selected');

    const items = [];
    if (entry.isDir) {
      items.push({
        label: this.expanded.has(pkey(entry.path)) ? '折叠文件夹' : '展开文件夹',
        icon: this.expanded.has(pkey(entry.path)) ? 'chevron-down' : 'chevron-right',
        action: () => this.toggleDir(entry.path),
      });
      items.push({
        label: '设为工作目录',
        icon: 'folder-open',
        action: () => this.opts.onSetRoot && this.opts.onSetRoot(entry.path),
      });
      items.push({ separator: true });
      items.push({ label: '新建文件…', icon: 'file-plus', action: () => this.createFile(entry.path) });
      items.push({ label: '新建文件夹…', icon: 'folder-plus', action: () => this.createFolder(entry.path) });
    } else {
      items.push({ label: '打开', icon: 'file-text', action: () => this.opts.onOpenFile && this.opts.onOpenFile(entry.path) });
      items.push({
        label: '与另一个文件比较…',
        icon: 'git-compare',
        action: () => this.compareEntry(entry),
      });
    }
    items.push({ separator: true });
    items.push({ label: '重命名…', icon: 'pencil', action: () => this.renameEntry(entry) });
    items.push({ label: '删除', icon: 'trash-2', danger: true, action: () => this.deleteEntry(entry) });
    items.push({ separator: true });
    items.push({
      label: '复制路径',
      icon: 'copy',
      action: async () => {
        try {
          await navigator.clipboard.writeText(entry.path);
          toast('路径已复制', 'success', 1400);
        } catch {
          toast('复制失败，剪贴板不可用', 'error');
        }
      },
    });
    items.push({ label: '在资源管理器中显示', icon: 'external-link', action: () => api.reveal(entry.path).catch((err) => toast(err.message, 'error')) });
    items.push({ label: '刷新', icon: 'refresh-cw', action: () => this.refreshDir(entry.isDir ? entry.path : dirName(entry.path)) });
    showContextMenu(e.clientX, e.clientY, items);
  }

  async compareEntry(entry) {
    const other = await pickPath({
      mode: 'file',
      title: `选择要与「${entry.name}」比较的文件`,
      start: dirName(entry.path),
    });
    if (!other) return;
    if (pkey(other) === pkey(entry.path)) {
      toast('请选择另一个文件', 'warn');
      return;
    }
    if (this.opts.onCompare) this.opts.onCompare(entry.path, other);
  }

  async createFile(dir) {
    const target = dir || this.selectedDir();
    if (!target) { toast('请先打开文件夹', 'warn'); return; }
    const name = await promptDialog({
      title: '新建文件',
      label: `在 ${target} 中新建文件`,
      value: 'untitled.txt',
      placeholder: '文件名',
      confirmText: '创建',
      validate: validName,
    });
    if (!name) return;
    const full = joinPath(target, name.trim());
    try {
      await api.write(full, '', 'utf8', 'LF');
      await this.refreshAfterCreate(target, full);
      if (this.opts.onOpenFile) this.opts.onOpenFile(full);
      toast('文件已创建', 'success', 1400);
    } catch (err) {
      toast('创建失败：' + err.message, 'error');
    }
  }

  async createFolder(dir) {
    const target = dir || this.selectedDir();
    if (!target) { toast('请先打开文件夹', 'warn'); return; }
    const name = await promptDialog({
      title: '新建文件夹',
      label: `在 ${target} 中新建文件夹`,
      value: '新建文件夹',
      placeholder: '文件夹名',
      confirmText: '创建',
      validate: validName,
    });
    if (!name) return;
    const full = joinPath(target, name.trim());
    try {
      await api.mkdir(full);
      await this.refreshAfterCreate(target, full);
      toast('文件夹已创建', 'success', 1400);
    } catch (err) {
      toast('创建失败：' + err.message, 'error');
    }
  }

  async refreshAfterCreate(parent, newPath) {
    this.expanded.add(pkey(parent));
    if (!this.cache.has(pkey(parent))) await this.loadDir(parent);
    else await this.loadDir(parent, { silent: true });
    this.selected = newPath;
    this.render();
  }

  async renameEntry(entry) {
    const name = await promptDialog({
      title: '重命名',
      label: entry.isDir ? '文件夹名称' : '文件名称',
      value: entry.name,
      validate: validName,
    });
    if (!name || name.trim() === entry.name) return;
    const to = joinPath(dirName(entry.path), name.trim());
    try {
      await api.rename(entry.path, to);
      this.cleanupPath(entry.path);
      this.selected = to;
      await this.loadDir(dirName(entry.path), { silent: true });
      this.render();
      if (this.opts.onRenamed) this.opts.onRenamed(entry.path, to);
      toast('已重命名', 'success', 1400);
    } catch (err) {
      toast('重命名失败：' + err.message, 'error');
    }
  }

  async deleteEntry(entry) {
    const ok = await confirmDialog({
      title: entry.isDir ? '删除文件夹' : '删除文件',
      message: `确定要删除「${entry.name}」吗？`,
      detail: entry.isDir ? '文件夹中的所有内容都会被删除，且无法撤销。' : '此操作无法撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(entry.path);
      this.cleanupPath(entry.path);
      this.selected = null;
      await this.loadDir(dirName(entry.path), { silent: true });
      this.render();
      if (this.opts.onDeleted) this.opts.onDeleted(entry.path);
      toast('已删除', 'success', 1400);
    } catch (err) {
      toast('删除失败：' + err.message, 'error');
    }
  }

  cleanupPath(path) {
    const key = pkey(path);
    const sep = config.sep || '/';
    for (const k of [...this.expanded]) {
      if (k === key || k.startsWith(key + sep) || k.startsWith(key + '/')) this.expanded.delete(k);
    }
    for (const k of [...this.cache.keys()]) {
      if (k === key || k.startsWith(key + sep) || k.startsWith(key + '/')) this.cache.delete(k);
    }
    if (this.selected && (pkey(this.selected) === key || pkey(this.selected).startsWith(key + sep))) {
      this.selected = null;
    }
  }
}
