import { iconSVG } from './icons.js';
import { api, config } from './api.js';

// ------------------------------------------------------------------ DOM

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'html') el.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, v);
          else el.style[prop] = v;
        }
      }
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'attrs') {
        for (const [a, v] of Object.entries(value)) {
          if (v !== undefined && v !== null && v !== false) el.setAttribute(a, v);
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value') {
        el.value = value;
      } else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') {
        el[key] = !!value;
      } else {
        el.setAttribute(key, value);
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function ico(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon-wrap' + (cls ? ' ' + cls : '');
  span.innerHTML = iconSVG(name);
  return span.firstChild ? span : span;
}

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon-wrap';
  span.innerHTML = iconSVG(name, cls);
  return span.firstChild || span;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = iconSVG(el.dataset.icon, el.dataset.iconClass || '');
  });
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ------------------------------------------------------------------ format

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function baseName(p) {
  if (!p) return '';
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

export function dirName(p) {
  if (!p) return '';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx <= 0) return p;
  return p.slice(0, idx);
}

export function joinPath(dir, name) {
  const sep = config.sep || '/';
  if (!dir) return name;
  if (/[\\/]$/.test(dir)) return dir + name;
  return dir + sep + name;
}

export function splitPath(p) {
  const sep = config.sep || '/';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  const segs = [];
  let base = '';
  if (/^[A-Za-z]:$/.test(parts[0] || '')) {
    base = parts.shift() + sep;
    segs.push({ name: base.slice(0, 2), path: base });
  } else if (String(p).startsWith('/')) {
    base = '/';
    segs.push({ name: '/', path: '/' });
  }
  for (const part of parts) {
    base = base.endsWith(sep) ? base + part : base + sep + part;
    segs.push({ name: part, path: base });
  }
  return segs;
}

export function debounce(fn, wait = 200) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

export function fuzzyMatch(text, query) {
  if (!query) return { score: 0, idx: [] };
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let prev = -2;
  let score = 0;
  const idx = [];
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      idx.push(i);
      if (i === prev + 1) score += 3;
      else score += 0.5;
      if (i === 0) score += 2;
      const before = lower[i - 1];
      if (before === '/' || before === '\\' || before === '_' || before === '-' || before === '.') score += 2;
      prev = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score -= text.length * 0.012;
  return { score, idx };
}

export function highlightMatch(text, idx) {
  if (!idx || !idx.length) return escapeHtml(text);
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

export function truncateMiddle(str, max = 60) {
  if (!str || str.length <= max) return str;
  const half = Math.floor((max - 1) / 2);
  return str.slice(0, half) + '…' + str.slice(str.length - half);
}

// ------------------------------------------------------------------ toasts

export function toast(message, type = 'info', timeout = 3200) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const iconName = type === 'success' ? 'circle-check' : type === 'error' ? 'circle-x' : type === 'warn' ? 'circle-alert' : 'info';
  const el = h('div', { class: `toast ${type}` },
    icon(iconName),
    h('div', { class: 'toast-text', text: message })
  );
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const timer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  }, timeout);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('click', () => {
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  });
}

// ------------------------------------------------------------------ modal

const modalStack = [];

export function openModal(options = {}) {
  const root = document.getElementById('modals');
  const overlay = h('div', { class: 'modal-overlay' });
  const modal = h('div', { class: 'modal', style: options.width ? { width: options.width } : null });
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
  modal.setAttribute('aria-labelledby', titleId);

  const previousFocus = document.activeElement;
  let closed = false;

  const close = (result) => {
    if (closed) return;
    closed = true;
    const idx = modalStack.indexOf(rec);
    if (idx >= 0) modalStack.splice(idx, 1);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 160);
    if (previousFocus && previousFocus.focus) {
      try { previousFocus.focus(); } catch { /* ignore */ }
    }
    if (options.onClose) options.onClose(result);
  };

  const head = h('div', { class: 'modal-head' },
    h('h2', { id: titleId }, options.title || ''),
    h('button', { class: 'icon-btn small', title: '关闭 (Esc)', 'aria-label': '关闭', onClick: () => close() }, icon('x'))
  );
  const body = h('div', { class: 'modal-body' });
  if (options.body instanceof Node) body.appendChild(options.body);
  else if (typeof options.body === 'string') body.innerHTML = options.body;
  else if (Array.isArray(options.body)) appendChildren(body, options.body);

  const foot = h('div', { class: 'modal-foot' });
  if (options.footer) {
    for (const item of [].concat(options.footer)) {
      if (item) foot.appendChild(item);
    }
    if (!foot.children.length) foot.remove();
  }

  modal.appendChild(head);
  modal.appendChild(body);
  if (foot.children.length) modal.appendChild(foot);
  overlay.appendChild(modal);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && options.closeOnBackdrop !== false) close();
  });
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  const rec = { close, overlay, modal, body, foot, options };
  modalStack.push(rec);

  setTimeout(() => {
    const focusTarget = modal.querySelector('[autofocus]') || modal.querySelector('input, textarea, select') || modal.querySelector('.btn.primary');
    if (focusTarget) {
      try { focusTarget.focus(); } catch { /* ignore */ }
      if (focusTarget.select && focusTarget.tagName === 'INPUT' && focusTarget.type === 'text') focusTarget.select();
    }
  }, 30);

  return rec;
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ctxMenu) { hideContextMenu(); e.stopPropagation(); return; }
  const top = modalStack[modalStack.length - 1];
  if (top) {
    e.preventDefault();
    e.stopPropagation();
    top.close();
  }
}, true);

export function confirmDialog({
  title = '确认操作',
  message = '',
  detail = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const body = h('div', { class: 'dialog-body' },
      h('p', { class: 'dialog-message' }, message),
      detail ? h('p', { class: 'dialog-detail' }, detail) : null
    );
    let modal;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(value);
    };
    modal = openModal({
      title,
      width: '480px',
      body,
      onClose: () => finish(false),
      footer: [
        h('button', { class: 'btn', onClick: () => finish(false) }, cancelText),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => finish(true) }, confirmText),
      ],
    });
  });
}

export function promptDialog({
  title = '输入',
  label = '',
  value = '',
  placeholder = '',
  confirmText = '确定',
  cancelText = '取消',
  validate = null,
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'text-input', value, placeholder, spellcheck: 'false' });
    const error = h('div', { class: 'field-error' });
    const body = h('div', { class: 'dialog-body' },
      label ? h('label', { class: 'field-label' }, label) : null,
      input,
      error
    );
    let modal;
    const finish = (val) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(val);
    };
    const submit = () => {
      const v = input.value;
      if (validate) {
        const msg = validate(v);
        if (msg) {
          error.textContent = msg;
          input.classList.add('invalid');
          input.focus();
          return;
        }
      }
      finish(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => {
      error.textContent = '';
      input.classList.remove('invalid');
    });
    modal = openModal({
      title,
      width: '480px',
      body,
      onClose: () => finish(null),
      footer: [
        h('button', { class: 'btn', onClick: () => finish(null) }, cancelText),
        h('button', { class: 'btn primary', onClick: submit }, confirmText),
      ],
    });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

export function choiceDialog({
  title = '未保存的更改',
  message = '',
  options = [],
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    let modal;
    const finish = (val) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(val);
    };
    modal = openModal({
      title,
      width: '500px',
      body: h('div', { class: 'dialog-body' }, h('p', { class: 'dialog-message' }, message)),
      onClose: () => finish(null),
      footer: options.map((opt) =>
        h('button', {
          class: `btn ${opt.kind === 'primary' ? 'primary' : opt.kind === 'danger' ? 'danger' : ''}`,
          onClick: () => finish(opt.value),
        }, opt.label)
      ),
    });
  });
}

export function saveChangesDialog(fileName) {
  return choiceDialog({
    title: '未保存的更改',
    message: `「${fileName}」有未保存的更改。要先保存吗？`,
    options: [
      { label: '取消', value: 'cancel' },
      { label: '不保存', value: 'discard', kind: 'danger' },
      { label: '保存', value: 'save', kind: 'primary' },
    ],
  });
}

// ------------------------------------------------------------------ context menu

let ctxMenu = null;

export function hideContextMenu() {
  if (!ctxMenu) return;
  ctxMenu.remove();
  ctxMenu = null;
}

export function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = h('div', { class: 'context-menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.appendChild(h('div', { class: 'ctx-sep' }));
      continue;
    }
    const entry = h('button', {
      class: `ctx-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`,
      disabled: item.disabled,
      onClick: () => {
        hideContextMenu();
        if (!item.disabled && item.action) item.action();
      },
    },
      h('span', { class: 'ctx-icon' }, item.icon ? icon(item.icon) : null),
      h('span', { class: 'ctx-label', text: item.label }),
      item.shortcut ? h('span', { class: 'ctx-key', text: item.shortcut }) : null
    );
    menu.appendChild(entry);
  }
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(6, left) + 'px';
  menu.style.top = Math.max(6, top) + 'px';
  ctxMenu = menu;
  setTimeout(() => {
    const off = (e) => {
      if (!menu.contains(e.target)) {
        hideContextMenu();
        document.removeEventListener('mousedown', off, true);
      }
    };
    document.addEventListener('mousedown', off, true);
  }, 0);
}

// ------------------------------------------------------------------ path picker

export async function pickPath({ mode = 'file', title = '选择文件', start = '' } = {}) {
  let roots;
  try {
    roots = await api.roots();
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }

  let current = start || roots.home || (roots.roots && roots.roots[0]) || '/';
  let selected = null;
  let entries = [];
  let filterText = '';
  let modal = null;
  let closedByUser = false;

  const crumb = h('div', { class: 'picker-crumb' });
  const listEl = h('div', { class: 'picker-list' });
  const pathInput = h('input', {
    class: 'picker-input',
    value: current,
    spellcheck: 'false',
    placeholder: '输入路径后回车',
  });
  const filterInput = h('input', {
    class: 'picker-filter',
    placeholder: '按名称筛选…',
    spellcheck: 'false',
  });
  const rootsRow = h('div', { class: 'picker-roots' });
  const statusEl = h('div', { class: 'picker-status' });
  const selectBtn = h('button', { class: 'btn primary', disabled: true }, mode === 'dir' ? '选择此文件夹' : '选择文件');

  for (const root of roots.roots || []) {
    rootsRow.appendChild(h('button', { class: 'chip', onClick: () => navigate(root), text: root }));
  }
  for (const sc of roots.shortcuts || []) {
    if (sc.key === 'home' || roots.roots.includes(sc.path)) continue;
    const names = { desktop: '桌面', documents: '文档', downloads: '下载' };
    rootsRow.appendChild(h('button', { class: 'chip', onClick: () => navigate(sc.path), text: names[sc.key] || sc.key }));
  }

  function parentOf(p) {
    const sep = config.sep || '/';
    const norm = String(p).replace(/[\\/]+$/, '');
    const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
    if (idx <= 0) return p;
    if (/^[A-Za-z]:$/.test(norm.slice(0, idx))) return norm.slice(0, idx) + sep;
    return norm.slice(0, idx) || '/';
  }

  async function navigate(target) {
    if (!target) return;
    entries = [];
    listEl.innerHTML = '<div class="picker-loading">加载中…</div>';
    statusEl.textContent = '';
    try {
      const data = await api.list(target);
      current = data.path;
      selected = null;
      pathInput.value = current;
      entries = data.entries;
      filterText = '';
      filterInput.value = '';
      render();
    } catch (err) {
      listEl.innerHTML = '';
      listEl.appendChild(h('div', { class: 'picker-error' }, err.message));
      toast(err.message, 'error');
    }
  }

  function render() {
    // breadcrumb
    clear(crumb);
    crumb.appendChild(h('button', { class: 'crumb-btn', title: '上一级', onClick: () => navigate(parentOf(current)) }, icon('arrow-up')));
    for (const seg of splitPath(current)) {
      crumb.appendChild(h('button', {
        class: 'crumb-btn',
        text: seg.name,
        onClick: () => navigate(seg.path),
      }));
      crumb.appendChild(h('span', { class: 'crumb-sep', text: '›' }));
    }

    clear(listEl);
    const filterLower = filterText.toLowerCase();
    const visible = entries.filter((e) => {
      if (mode === 'file' && e.isDir) return true;
      if (mode === 'file' && !e.isDir) return !filterLower || e.name.toLowerCase().includes(filterLower);
      return !filterLower || e.name.toLowerCase().includes(filterLower);
    });

    if (!visible.length) {
      listEl.appendChild(h('div', { class: 'picker-empty', text: filterLower ? '没有匹配的项目' : '空文件夹' }));
    }

    for (const entry of visible) {
      const isSel = selected === entry.path;
      const row = h('button', {
        class: `picker-row${isSel ? ' selected' : ''}${entry.isDir ? ' dir' : ''}`,
        onClick: () => {
          selected = entry.isDir && mode === 'dir' ? entry.path : entry.isDir ? null : entry.path;
          if (entry.isDir && mode === 'file') selected = null;
          render();
        },
        onDblclick: () => {
          if (entry.isDir) navigate(entry.path);
          else { selected = entry.path; confirm(); }
        },
      },
        h('span', { class: 'picker-row-icon' }, icon(entry.isDir ? 'folder' : 'file', entry.isDir ? 'folder-icon' : '')),
        h('span', { class: 'picker-row-name', text: entry.name }),
        h('span', { class: 'picker-row-meta', text: entry.isDir ? '' : formatBytes(entry.size) })
      );
      listEl.appendChild(row);
    }

    updateFooter();
  }

  function updateFooter() {
    if (mode === 'dir') {
      const target = selected || current;
      selectBtn.disabled = false;
      selectBtn.textContent = selected ? `选择「${baseName(selected)}」` : '选择此文件夹';
      statusEl.textContent = target;
    } else {
      selectBtn.disabled = !selected;
      statusEl.textContent = selected || '请选择文件';
    }
  }

  function confirm() {
    const value = mode === 'dir' ? (selected || current) : selected;
    if (!value) return;
    closedByUser = true;
    modal.close();
    resolve(value);
  }

  let resolve;
  const promise = new Promise((res) => { resolve = res; });

  const body = h('div', { class: 'picker' },
    h('div', { class: 'picker-roots-row' }, rootsRow),
    h('div', { class: 'picker-path-row' }, h('span', { class: 'picker-path-icon' }, icon('hard-drive')), pathInput, h('button', { class: 'btn sm', onClick: () => navigate(pathInput.value.trim()) }, '前往')),
    crumb,
    h('div', { class: 'picker-filter-row' }, icon('filter'), filterInput),
    listEl,
    statusEl
  );

  filterInput.addEventListener('input', () => { filterText = filterInput.value.trim(); render(); });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = listEl.querySelector('.picker-row');
      if (first) first.click();
    }
  });
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = pathInput.value.trim();
      if (!val) return;
      if (mode === 'file' && /\.[^\\/]+$/.test(val)) { selected = val; closedByUser = true; modal.close(); resolve(val); return; }
      navigate(val);
    }
  });

  selectBtn.addEventListener('click', confirm);

  modal = openModal({
    title,
    width: '720px',
    body,
    closeOnBackdrop: false,
    onClose: () => {
      if (!closedByUser) resolve(null);
    },
    footer: [
      h('button', { class: 'btn', onClick: () => { modal.close(); } }, '取消'),
      selectBtn,
    ],
  });

  await navigate(current);
  if (!closedByUser) filterInput.focus();
  return promise;
}
