import { api, config } from './api.js';
import { diffLines, findHunks, toUnified, unifiedHunks } from './diff.js';
import {
  h, icon, escapeHtml, formatBytes, formatTime, baseName, joinPath,
  toast, confirmDialog, openModal,
} from './ui.js';

const MAX_DIFF_LINES = 20000;
const MAX_RENDER_ROWS = 4000;

export const DEFAULT_COMPARE_OPTIONS = {
  ignoreCase: false,
  ignoreWhitespace: 'none',
  ignoreBlankLines: false,
  wrap: true,
  view: 'side',
};

export const DEFAULT_FOLDER_STATE = {
  onlyDiff: true,
  filter: '',
  status: 'all',
  selected: null,
  fast: false,
  renderLimit: 1500,
};

function btn(iconName, title, onClick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`.trim(), title, 'aria-label': title, onClick }, icon(iconName));
}

function labeledBtn(iconName, label, onClick, cls = '') {
  return h('button', { class: `btn sm ${cls}`.trim(), onClick },
    icon(iconName), h('span', { text: label }));
}

function absOf(root, rel) {
  return joinPath(root, rel.split('/').join(config.sep || '/'));
}

function segsHtml(segs, fallback) {
  if (!segs) return escapeHtml(fallback ?? '');
  let out = '';
  for (const seg of segs) {
    const txt = escapeHtml(seg.text);
    if (seg.type === 'same') out += txt;
    else out += `<span class="wd-${seg.type}">${txt}</span>`;
  }
  return out;
}

function statusLabel(status) {
  return { same: '相同', modified: '已修改', 'left-only': '仅左侧', 'right-only': '仅右侧' }[status] || status;
}

function statusClass(status) {
  return { same: 'same', modified: 'mod', 'left-only': 'left', 'right-only': 'right' }[status] || 'same';
}

export class CompareView {
  constructor({ host, onOpenFile, onOpenDiff, onChanged }) {
    this.host = host;
    this.onOpenFile = onOpenFile || (() => {});
    this.onOpenDiff = onOpenDiff || (() => {});
    this.onChanged = onChanged || (() => {});
    this.currentTab = null;
  }

  show(tab) {
    document.querySelectorAll('.popover').forEach((p) => p.remove());
    this.currentTab = tab;
    if (!tab.el) {
      tab.el = this.buildShell(tab);
    }
    this.host.replaceChildren(tab.el);
    if (tab.compare.mode === 'files' && tab.diff) this.updateFileUi(tab);
    if (tab.compare.mode === 'folders' && tab.folderData) this.renderFolders(tab);
  }

  dispose(tab) {
    if (tab.el) tab.el.remove();
    tab.el = null;
    tab.refs = null;
  }

  // -------------------------------------------------------------- shell

  buildShell(tab) {
    const el = h('div', { class: 'compare' });
    const header = h('div', { class: 'cmp-toolbar' });
    const body = h('div', { class: 'cmp-body' });
    const footer = h('div', { class: 'cmp-footer' });
    el.append(header, body, footer);
    tab.el = el;
    tab.refs = { header, body, footer };
    if (tab.compare.mode === 'files') {
      this.buildFileHeader(tab);
      this.loadFiles(tab);
    } else {
      this.buildFolderHeader(tab);
      this.loadFolders(tab);
    }
    return el;
  }

  showError(tab, err) {
    tab.refs.body.innerHTML = '';
    tab.refs.body.appendChild(h('div', { class: 'cmp-error' },
      h('div', { class: 'cmp-error-icon' }, icon(err.code === 'BINARY' ? 'file-x' : 'alert-triangle')),
      h('h3', { text: err.code === 'BINARY' ? '无法显示二进制文件' : '打开失败' }),
      h('p', { text: err.message }),
      h('div', { class: 'cmp-error-actions' },
        h('button', { class: 'btn primary', onClick: () => this.reload(tab) }, '重试'),
        tab.compare.mode === 'files'
          ? h('button', { class: 'btn', onClick: () => this.onOpenFile(tab.compare.left) }, '在编辑器中打开左侧')
          : null
      )
    ));
    tab.refs.footer.textContent = '';
    this.onChanged(tab);
  }

  reload(tab) {
    if (tab.compare.mode === 'files') { tab.diff = null; this.loadFiles(tab); }
    else { tab.folderData = null; this.loadFolders(tab); }
  }

  // -------------------------------------------------------------- file compare

  buildFileHeader(tab) {
    const header = tab.refs.header;
    header.classList.add('file-mode');
    header.innerHTML = '';
    const c = tab.compare;
    const mkSide = (side) => {
      const path = side === 'left' ? c.left : c.right;
      const nameEl = h('div', { class: 'cmp-file-name', text: baseName(path) || path });
      const pathEl = h('div', { class: 'cmp-file-path', title: path, text: path });
      const openBtn = btn('file-text', '在编辑器中打开', () => this.onOpenFile(path), 'tiny');
      const wrap = h('div', { class: `cmp-side ${side}` },
        h('span', { class: 'cmp-side-tag', text: side === 'left' ? '左' : '右' }),
        h('div', { class: 'cmp-file' }, nameEl, pathEl),
        openBtn
      );
      wrap._name = nameEl;
      wrap._path = pathEl;
      return wrap;
    };
    const leftEl = mkSide('left');
    const rightEl = mkSide('right');

    const counter = h('span', { class: 'cmp-counter', text: '—' });
    tab.refs.counter = counter;

    const prevBtn = btn('arrow-up', '上一个差异 (Alt+↑)', () => this.navigateDiff(tab, -1));
    const nextBtn = btn('arrow-down', '下一个差异 (Alt+↓)', () => this.navigateDiff(tab, 1));
    tab.refs.prevBtn = prevBtn;

    const actions = h('div', { class: 'cmp-actions' },
      h('div', { class: 'cmp-nav' }, prevBtn, counter, nextBtn),
      h('div', { class: 'cmp-divider' }),
      btn('arrow-left-right', '交换左右', () => this.swap(tab)),
      btn('refresh-cw', '重新加载', () => this.reload(tab)),
      btn('columns-2', '切换并排 / 行内视图', (e) => this.toggleView(tab, e.currentTarget)),
      btn('settings', '比较选项', (e) => this.showFileOptions(tab, e.currentTarget))
    );
    tab.refs.viewBtn = actions.querySelector('[title*="并排"]');
    tab.refs.viewBtn.dataset.role = 'view-toggle';
    tab.refs.leftSide = leftEl;
    tab.refs.rightSide = rightEl;

    header.append(leftEl, actions, rightEl);
    this.updateFileHeader(tab);
  }

  updateFileHeader(tab) {
    const c = tab.compare;
    if (tab.refs.leftSide) {
      tab.refs.leftSide._name.textContent = baseName(c.left) || c.left;
      tab.refs.leftSide._path.textContent = c.left;
      tab.refs.leftSide._path.title = c.left;
    }
    if (tab.refs.rightSide) {
      tab.refs.rightSide._name.textContent = baseName(c.right) || c.right;
      tab.refs.rightSide._path.textContent = c.right;
      tab.refs.rightSide._path.title = c.right;
    }
  }

  async loadFiles(tab) {
    const c = tab.compare;
    tab.refs.body.innerHTML = `<div class="cmp-loading"><span class="spinner"></span><p>正在读取文件并计算差异…</p></div>`;
    tab.refs.footer.innerHTML = '';
    try {
      const [L, R] = await Promise.all([api.read(c.left), api.read(c.right)]);
      tab.files = { L, R };
      this.computeFileDiff(tab);
      this.renderFiles(tab);
      this.updateFileUi(tab);
    } catch (err) {
      this.showError(tab, err);
    }
  }

  computeFileDiff(tab) {
    const c = tab.compare;
    const opts = c.options || {};
    const aAll = tab.files.L.content.split('\n');
    const bAll = tab.files.R.content.split('\n');
    const truncated = aAll.length > MAX_DIFF_LINES || bAll.length > MAX_DIFF_LINES;
    const a = truncated ? aAll.slice(0, MAX_DIFF_LINES) : aAll;
    const b = truncated ? bAll.slice(0, MAX_DIFF_LINES) : bAll;
    const result = diffLines(a, b, {
      ignoreCase: !!opts.ignoreCase,
      ignoreWhitespace: opts.ignoreWhitespace || 'none',
      ignoreBlankLines: !!opts.ignoreBlankLines,
    });
    const hunks = findHunks(result.rows);
    const uni = toUnified(result.rows);
    const uniHunks = unifiedHunks(uni);
    tab.diff = {
      ...result,
      hunks,
      uni,
      uniHunks,
      truncated,
      totalLines: [aAll.length, bAll.length],
    };
    tab.diffIndex = -1;
  }

  renderFiles(tab) {
    const c = tab.compare;
    const opts = c.options || DEFAULT_COMPARE_OPTIONS;
    const d = tab.diff;
    if (!d) return;
    const body = tab.refs.body;
    const prevScroll = body.querySelector('.diff-scroll');
    const ratio = prevScroll && prevScroll.scrollHeight > prevScroll.clientHeight
      ? prevScroll.scrollTop / (prevScroll.scrollHeight - prevScroll.clientHeight)
      : 0;

    let html = '';
    if (d.truncated) {
      html += `<div class="cmp-banner">文件较大，仅对比前 ${MAX_DIFF_LINES.toLocaleString()} 行（左侧共 ${d.totalLines[0].toLocaleString()} 行，右侧共 ${d.totalLines[1].toLocaleString()} 行）。</div>`;
    }
    if (d.fallback) {
      html += `<div class="cmp-banner warn">内容差异过大，已按行位置近似对齐，仅供参考。</div>`;
    }

    const view = opts.view === 'side' ? 'side' : 'uni';
    const rows = view === 'side' ? d.rows : d.uni;
    const virtual = rows.length > 1200;
    html += `<div class="diff-scroll"><div class="diff-rows ${view === 'side' ? 'side' : 'uni-view'}${opts.wrap === false ? ' nowrap' : ''}${virtual ? ' virtual' : ''}" data-view="${view}">`;
    html += this.rowsHtml(view === 'side' ? d.rows : d.uni, view);
    html += '</div></div>';

    body.innerHTML = html;
    tab.refs.rows = body.querySelector('.diff-rows');
    tab.refs.scroll = body.querySelector('.diff-scroll');
    if (tab.refs.scroll && ratio > 0) {
      tab.refs.scroll.scrollTop = ratio * (tab.refs.scroll.scrollHeight - tab.refs.scroll.clientHeight);
    }
    if (tab.refs.viewBtn) {
      tab.refs.viewBtn.innerHTML = icon(view === 'side' ? 'columns-2' : 'rows-2').outerHTML;
      tab.refs.viewBtn.title = view === 'side' ? '切换为行内视图' : '切换为并排视图';
    }
    this.renderFileFooter(tab);
    this.updateCounter(tab);
    this.onChanged(tab);
  }

  rowsHtml(rows, view) {
    const out = [];
    if (view === 'side') {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const isChange = r.type !== 'equal';
        let left = '';
        let right = '';
        if (r.left) {
          const mark = r.type === 'del' ? '−' : r.type === 'mod' ? '~' : '';
          left = `<span class="dln">${r.left.no}</span><span class="dmark">${mark}</span><span class="dcode">${segsHtml(r.left.segs, r.left.text)}</span>`;
        }
        if (r.right) {
          const mark = r.type === 'ins' ? '+' : r.type === 'mod' ? '~' : '';
          right = `<span class="dln">${r.right.no}</span><span class="dmark">${mark}</span><span class="dcode">${segsHtml(r.right.segs, r.right.text)}</span>`;
        }
        out.push(`<div class="diff-row ${r.type}${isChange ? ' change' : ''}" data-row="${i}"${isChange ? ' data-change="1"' : ''}>`);
        out.push(`<div class="dcell left${r.left ? '' : ' blank'}">${left}</div>`);
        out.push(`<div class="dcell right${r.right ? '' : ' blank'}">${right}</div>`);
        out.push('</div>');
      }
      return out.join('');
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const mark = r.type === 'del' ? '−' : r.type === 'ins' ? '+' : ' ';
      const isChange = r.type !== 'equal';
      const code = r.type === 'equal' ? escapeHtml(r.text) : segsHtml(r.segs, r.text);
      out.push(`<div class="diff-row u-${r.type}${isChange ? ' change' : ''}" data-row="${i}"${isChange ? ' data-change="1"' : ''}>`);
      out.push(`<span class="uln">${r.ln1 ?? ''}</span><span class="uln">${r.ln2 ?? ''}</span><span class="umark">${mark}</span><span class="dcode">${code}</span>`);
      out.push('</div>');
    }
    return out.join('');
  }

  renderFileFooter(tab) {
    const d = tab.diff;
    const c = tab.compare;
    if (!d) return;
    const { stats } = d;
    const opts = c.options || {};
    const ignored = [
      opts.ignoreCase ? '忽略大小写' : '',
      opts.ignoreWhitespace === 'all' ? '忽略所有空白' : opts.ignoreWhitespace === 'trailing' ? '忽略行尾空白' : '',
      opts.ignoreBlankLines ? '忽略空行' : '',
    ].filter(Boolean);
    const total = d.stats.added + d.stats.removed + d.stats.modified;
    tab.refs.footer.innerHTML = '';
    const summary = total === 0
      ? h('span', { class: 'cmp-identical' }, icon('circle-check'), h('span', { text: '两个文件内容一致' }))
      : h('span', { class: 'cmp-stats' },
        h('span', { class: 'stat add', text: `+${stats.added}` }),
        h('span', { class: 'stat del', text: `−${stats.removed}` }),
        h('span', { class: 'stat mod', text: `~${stats.modified}` }),
        h('span', { class: 'stat-label', text: '行差异' })
      );
    tab.refs.footer.append(
      summary,
      h('span', { class: 'cmp-footer-meta' },
        h('span', { text: `左 ${tab.files ? tab.files.L.content.split('\n').length.toLocaleString() : '?'} 行 · ${formatBytes(tab.files ? tab.files.L.size : 0)}` }),
        h('span', { class: 'dot-sep', text: '·' }),
        h('span', { text: `右 ${tab.files ? tab.files.R.content.split('\n').length.toLocaleString() : '?'} 行 · ${formatBytes(tab.files ? tab.files.R.size : 0)}` }),
        ignored.length ? h('span', { class: 'dot-sep', text: '·' }) : null,
        ignored.length ? h('span', { class: 'cmp-ignore', text: ignored.join('、') }) : null
      )
    );
  }

  updateCounter(tab) {
    const d = tab.diff;
    if (!d || !tab.refs.counter) return;
    const view = (tab.compare.options || {}).view === 'side' ? 'side' : 'uni';
    const hunks = view === 'side' ? d.hunks : d.uniHunks;
    const total = hunks.length;
    if (!total) {
      tab.refs.counter.textContent = '无差异';
      tab.refs.counter.classList.add('none');
      return;
    }
    tab.refs.counter.classList.remove('none');
    const idx = tab.diffIndex >= 0 ? tab.diffIndex + 1 : '—';
    tab.refs.counter.textContent = `${idx} / ${total}`;
  }

  navigateDiff(tab, dir) {
    const d = tab.diff;
    if (!d) return;
    const view = (tab.compare.options || {}).view === 'side' ? 'side' : 'uni';
    const hunks = view === 'side' ? d.hunks : d.uniHunks;
    if (!hunks.length) { toast('没有差异可以跳转', 'info', 1600); return; }
    tab.diffIndex = (tab.diffIndex + dir + hunks.length) % hunks.length;
    const target = tab.refs.rows.querySelector(`[data-row="${hunks[tab.diffIndex].start}"]`);
    if (target) {
      const scroll = tab.refs.scroll;
      scroll.scrollTop = target.offsetTop - scroll.clientHeight / 2 + target.offsetHeight / 2;
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 700);
    }
    this.updateCounter(tab);
  }

  toggleView(tab) {
    const opts = tab.compare.options;
    opts.view = opts.view === 'side' ? 'uni' : 'side';
    this.renderFiles(tab);
  }

  swap(tab) {
    const c = tab.compare;
    [c.left, c.right] = [c.right, c.left];
    tab.diff = null;
    tab.folderData = null;
    toast('已交换左右', 'success', 1400);
    if (c.mode === 'files') { this.updateFileHeader(tab); this.loadFiles(tab); }
    else { this.updateFolderHeader(tab); this.loadFolders(tab); }
  }

  showFileOptions(tab, anchor) {
    document.querySelectorAll('.popover').forEach((p) => p.remove());
    const opts = tab.compare.options || (tab.compare.options = { ...DEFAULT_COMPARE_OPTIONS });
    const pop = h('div', { class: 'popover' });
    const seg = h('div', { class: 'segmented' },
      h('button', { class: opts.view === 'side' ? 'active' : '', onClick: () => { opts.view = 'side'; sync(); this.renderFiles(tab); } }, icon('columns-2'), '并排'),
      h('button', { class: opts.view === 'uni' ? 'active' : '', onClick: () => { opts.view = 'uni'; sync(); this.renderFiles(tab); } }, icon('rows-2'), '行内')
    );
    const caseCb = h('input', { type: 'checkbox', checked: opts.ignoreCase });
    const blankCb = h('input', { type: 'checkbox', checked: opts.ignoreBlankLines });
    const wrapCb = h('input', { type: 'checkbox', checked: opts.wrap !== false });
    const wsSel = h('select', { class: 'select' },
      h('option', { value: 'none', selected: opts.ignoreWhitespace === 'none' }, '不忽略空白'),
      h('option', { value: 'trailing', selected: opts.ignoreWhitespace === 'trailing' }, '忽略行尾空白'),
      h('option', { value: 'all', selected: opts.ignoreWhitespace === 'all' }, '忽略所有空白')
    );
    const apply = () => {
      opts.ignoreCase = caseCb.checked;
      opts.ignoreBlankLines = blankCb.checked;
      opts.ignoreWhitespace = wsSel.value;
      opts.wrap = wrapCb.checked;
      this.computeFileDiff(tab);
      this.renderFiles(tab);
    };
    caseCb.addEventListener('change', apply);
    blankCb.addEventListener('change', apply);
    wsSel.addEventListener('change', apply);
    wrapCb.addEventListener('change', () => {
      opts.wrap = wrapCb.checked;
      if (tab.refs.rows) tab.refs.rows.classList.toggle('nowrap', !opts.wrap);
    });

    pop.append(
      h('div', { class: 'popover-title' }, '比较选项'),
      h('div', { class: 'popover-section' }, h('div', { class: 'popover-label' }, '视图'), seg),
      h('label', { class: 'popover-check' }, caseCb, '忽略大小写'),
      h('label', { class: 'popover-field' }, h('span', {}, '空白处理'), wsSel),
      h('label', { class: 'popover-check' }, blankCb, '忽略空行'),
      h('label', { class: 'popover-check' }, wrapCb, '自动换行'),
      h('div', { class: 'popover-actions' },
        h('button', { class: 'btn sm', onClick: () => { pop.remove(); this.reload(tab); } }, icon('refresh-cw'), '重新加载')
      )
    );
    this._positionPopover(pop, anchor);
    function sync() {
      seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      const idx = opts.view === 'side' ? 0 : 1;
      seg.children[idx].classList.add('active');
      const wrapEl = tab.refs.rows;
      if (wrapEl) wrapEl.classList.toggle('nowrap', opts.wrap === false);
    }
  }

  _positionPopover(pop, anchor) {
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.top = Math.min(window.innerHeight - pr.height - 10, r.bottom + 6) + 'px';
    pop.style.left = Math.max(10, Math.min(window.innerWidth - pr.width - 10, r.right - pr.width)) + 'px';
    const close = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
        pop.remove();
        document.removeEventListener('mousedown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  }

  updateFileUi(tab) {
    this.updateFileHeader(tab);
    this.renderFileFooter(tab);
    this.updateCounter(tab);
  }

  // -------------------------------------------------------------- folder compare

  buildFolderHeader(tab) {
    const header = tab.refs.header;
    header.classList.add('folder-mode');
    header.innerHTML = '';
    const c = tab.compare;

    const mkSide = (side) => {
      const path = side === 'left' ? c.left : c.right;
      const nameEl = h('div', { class: 'cmp-file-name', text: baseName(path) || path });
      const pathEl = h('div', { class: 'cmp-file-path', title: path, text: path });
      return h('div', { class: `cmp-side ${side}` },
        h('span', { class: 'cmp-side-tag', text: side === 'left' ? '左' : '右' }),
        h('div', { class: 'cmp-file' }, nameEl, pathEl)
      );
    };
    const leftEl = mkSide('left');
    const rightEl = mkSide('right');
    tab.refs.leftSide = leftEl;
    tab.refs.rightSide = rightEl;

    const row1 = h('div', { class: 'folder-head-row' },
      leftEl,
      h('div', { class: 'cmp-folder-swap' }, btn('arrow-left-right', '交换左右', () => this.swap(tab))),
      rightEl
    );

    const chips = h('div', { class: 'summary-chips' });
    tab.refs.chips = chips;
    const syncRight = labeledBtn('arrow-right', '同步到右侧', () => this.batchSync(tab, 'right'), 'sync-btn');
    const syncLeft = labeledBtn('arrow-left', '同步到左侧', () => this.batchSync(tab, 'left'), 'sync-btn');
    tab.refs.syncRight = syncRight;
    tab.refs.syncLeft = syncLeft;

    const row2 = h('div', { class: 'folder-subbar' },
      chips,
      h('div', { class: 'folder-subbar-actions' },
        syncLeft,
        syncRight,
        btn('refresh-cw', '重新比较', () => this.reload(tab)),
        btn('settings', '比较选项', (e) => this.showFolderOptions(tab, e.currentTarget))
      )
    );
    header.append(row1, row2);
    this.updateFolderHeader(tab);
  }

  updateFolderHeader(tab) {
    const c = tab.compare;
    for (const [side, el] of [['left', tab.refs.leftSide], ['right', tab.refs.rightSide]]) {
      if (!el) continue;
      const path = side === 'left' ? c.left : c.right;
      el.querySelector('.cmp-file-name').textContent = baseName(path) || path;
      const p = el.querySelector('.cmp-file-path');
      p.textContent = path;
      p.title = path;
    }
    if (tab.folderData) this.updateSummaryChips(tab);
  }

  updateSummaryChips(tab) {
    const data = tab.folderData;
    if (!data || !tab.refs.chips) return;
    const s = data.summary;
    const state = tab.folderState;
    const make = (label, count, status, cls) => h('button', {
      class: `summary-chip ${cls}${state.status === status ? ' active' : ''}`,
      title: `筛选：${label}`,
      onClick: () => {
        state.status = state.status === status ? 'all' : status;
        this.renderFolders(tab);
      },
    }, h('span', { class: 'chip-dot' }), h('span', { text: label }), h('b', { text: String(count) }));
    tab.refs.chips.replaceChildren(
      make('相同', s.same, 'same', 'same'),
      make('修改', s.modified, 'modified', 'mod'),
      make('仅左', s.leftOnly, 'left-only', 'left'),
      make('仅右', s.rightOnly, 'right-only', 'right')
    );
    const rightCount = s.leftOnly + s.modified;
    const leftCount = s.rightOnly + s.modified;
    tab.refs.syncRight.disabled = rightCount === 0;
    tab.refs.syncLeft.disabled = leftCount === 0;
    tab.refs.syncRight.title = `将 ${rightCount} 个文件复制到右侧`;
    tab.refs.syncLeft.title = `将 ${leftCount} 个文件复制到左侧`;
  }

  async loadFolders(tab) {
    const c = tab.compare;
    const state = tab.folderState;
    tab.refs.body.innerHTML = `<div class="cmp-loading"><span class="spinner"></span><p>正在比对文件夹，请稍候…</p></div>`;
    tab.refs.footer.innerHTML = '';
    try {
      const data = await api.diffDirs({
        left: c.left,
        right: c.right,
        mode: state.fast ? 'fast' : 'content',
        include: c.include || '',
        exclude: c.exclude || '',
      });
      tab.folderData = data;
      tab.folderData.byRel = new Map(data.entries.map((e) => [e.rel, e]));
      this.renderFolders(tab);
    } catch (err) {
      this.showError(tab, err);
    }
  }

  renderFolders(tab) {
    const data = tab.folderData;
    if (!data || !tab.refs.body) return;
    const state = tab.folderState;

    // body
    const body = tab.refs.body;
    const prevList = body.querySelector('.folder-list');
    const prevScroll = prevList ? prevList.scrollTop : 0;

    this.updateSummaryChips(tab);

    const filterInput = h('input', {
      class: 'text-input sm',
      placeholder: '筛选文件名或路径…',
      value: state.filter,
      spellcheck: 'false',
    });
    filterInput.addEventListener('input', () => {
      state.filter = filterInput.value;
      state.renderLimit = 1500;
      this.renderFolderList(tab);
    });
    const onlyCb = h('input', { type: 'checkbox', checked: state.onlyDiff });
    onlyCb.addEventListener('change', () => {
      state.onlyDiff = onlyCb.checked;
      this.renderFolderList(tab);
      this.renderFolderFooter(tab);
    });
    const statusSel = h('select', { class: 'select sm' },
      ...['all', 'modified', 'left-only', 'right-only', 'same'].map((v) =>
        h('option', { value: v, selected: state.status === v }, v === 'all' ? '全部状态' : statusLabel(v)))
    );
    statusSel.addEventListener('change', () => {
      state.status = statusSel.value;
      this.renderFolderList(tab);
      this.renderFolderFooter(tab);
      this.updateSummaryChips(tab);
    });

    const listWrap = h('div', { class: 'folder-list-wrap' });
    const detail = h('aside', { class: 'folder-detail' });
    tab.refs.list = listWrap;
    tab.refs.detail = detail;
    tab.refs.filterInput = filterInput;

    const toolbar = h('div', { class: 'folder-list-toolbar' },
      h('div', { class: 'filter-input' }, icon('search'), filterInput),
      h('label', { class: 'inline-check', title: '仅显示有差异的文件' }, onlyCb, '仅差异'),
      statusSel
    );

    // The detail panel only appears once a row is selected, so the two folder
    // columns get the full width by default.
    const bodyEl = h('div', { class: 'folder-body' },
      h('div', { class: 'folder-main' }, toolbar, listWrap),
      detail
    );
    body.replaceChildren(bodyEl);
    tab.refs.folderBody = bodyEl;
    tab.refs.folderMain = body.querySelector('.folder-main');
    this.renderFolderList(tab);
    this.renderFolderFooter(tab);
    this.renderFolderDetail(tab, state.selected);
    if (prevScroll) {
      const l = tab.refs.list.querySelector('.folder-list');
      if (l) l.scrollTop = prevScroll;
    }
    this.onChanged(tab);
  }

  renderFolderList(tab) {
    const data = tab.folderData;
    const state = tab.folderState;
    if (!data || !tab.refs.list) return;
    let files = data.entries.filter((e) => !e.isDir);
    if (state.onlyDiff) files = files.filter((e) => e.status !== 'same');
    if (state.status !== 'all') files = files.filter((e) => e.status === state.status);
    if (state.filter) {
      const q = state.filter.toLowerCase();
      files = files.filter((e) => e.rel.toLowerCase().includes(q));
    }

    // Group rows by directory, so each folder header appears exactly once.
    const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    files = files.slice().sort((a, b) => {
      const da = dirOf(a.rel);
      const db = dirOf(b.rel);
      if (da !== db) return da.localeCompare(db, 'zh-Hans-CN', { numeric: true });
      return a.rel.localeCompare(b.rel, 'zh-Hans-CN', { numeric: true });
    });

    const list = h('div', { class: 'folder-list split' });
    // Side-by-side layout, the same idea as the file view: left folder on the
    // left, right folder on the right, rows aligned by relative path.
    list.appendChild(h('div', { class: 'fs-head' },
      h('div', { class: 'fs-side' }, icon('folder-open'), h('span', { text: baseName(data.left) || data.left })),
      h('div', { class: 'fs-mid', text: '状态' }),
      h('div', { class: 'fs-side right' }, icon('folder-open'), h('span', { text: baseName(data.right) || data.right }))
    ));
    if (!files.length) {
      list.appendChild(h('div', { class: 'panel-empty' },
        icon('circle-check'),
        h('p', { text: state.onlyDiff ? '没有差异，文件夹内容一致' : '没有匹配的文件' })
      ));
    }
    const limit = Math.min(files.length, state.renderLimit);
    let lastDir = null;
    for (let i = 0; i < limit; i++) {
      const entry = files[i];
      const dir = entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : '';
      if (dir !== lastDir) {
        lastDir = dir;
        list.appendChild(h('div', { class: 'fgroup', title: dir || '/' },
          icon('folder', 'folder-icon'),
          h('span', { text: dir || '/' })
        ));
      }
      const name = entry.rel.slice(entry.rel.lastIndexOf('/') + 1);
      const isSel = state.selected === entry.rel;
      const sideCell = (info, side) => {
        if (!info) return h('div', { class: `fs-cell ${side} absent`, title: '这一侧没有此文件' }, '—');
        return h('div', { class: `fs-cell ${side}` },
          h('span', { class: 'frow-icon' }, icon('file-text')),
          h('span', { class: 'fs-name', text: name }),
          h('span', { class: 'fs-size', text: info.size != null ? formatBytes(info.size) : '' })
        );
      };
      const row = h('button', {
        class: `fs-row ${statusClass(entry.status)}${isSel ? ' selected' : ''}`,
        dataset: { rel: entry.rel },
        title: `${entry.rel}\n${statusLabel(entry.status)}`,
        onClick: () => {
          state.selected = entry.rel;
          tab.refs.list.querySelectorAll('.fs-row.selected').forEach((el) => el.classList.remove('selected'));
          row.classList.add('selected');
          this.renderFolderDetail(tab, entry.rel);
        },
        onDblclick: () => this.openFolderDiff(tab, entry),
      },
        sideCell(entry.left, 'left'),
        h('div', { class: 'fs-mid' },
          h('span', { class: `frow-badge ${statusClass(entry.status)}`, text: statusLabel(entry.status) })
        ),
        sideCell(entry.right, 'right')
      );
      list.appendChild(row);
    }
    if (files.length > limit) {
      list.appendChild(h('button', {
        class: 'load-more',
        onClick: () => { state.renderLimit += 1500; this.renderFolderList(tab); },
      }, `还有 ${files.length - limit} 项，点击加载更多`));
    }
    tab.refs.list.replaceChildren(list);
    if (state.selected && !files.some((f) => f.rel === state.selected)) {
      state.selected = null;
      this.renderFolderDetail(tab, null);
    }
    tab.refs.visibleFiles = files;
  }

  renderFolderFooter(tab) {
    if (!tab.folderData || !tab.refs.footer) return;
    const state = tab.folderState;
    let files = tab.folderData.entries.filter((e) => !e.isDir);
    if (state.onlyDiff) files = files.filter((e) => e.status !== 'same');
    if (state.status !== 'all') files = files.filter((e) => e.status === state.status);
    if (state.filter) {
      const q = state.filter.toLowerCase();
      files = files.filter((e) => e.rel.toLowerCase().includes(q));
    }
    const total = tab.folderData.entries.filter((e) => !e.isDir).length;
    tab.refs.footer.replaceChildren(
      h('span', { class: 'cmp-footer-left' },
        h('span', { class: 'stat mod', text: `~${tab.folderData.summary.modified}` }),
        h('span', { class: 'stat del', text: `←${tab.folderData.summary.leftOnly}` }),
        h('span', { class: 'stat add', text: `→${tab.folderData.summary.rightOnly}` }),
        h('span', { class: 'stat-label', text: '待处理' })
      ),
      h('span', { class: 'cmp-footer-meta' },
        h('span', { text: `共 ${total.toLocaleString()} 个文件` }),
        h('span', { class: 'dot-sep', text: '·' }),
        h('span', { text: `当前显示 ${files.length.toLocaleString()} 个` }),
        tab.folderData.truncated ? h('span', { class: 'cmp-warn-text', text: ` · 已达上限 ${tab.folderData.maxEntries}` }) : null
      )
    );
  }

  renderFolderDetail(tab, rel) {
    const detail = tab.refs.detail;
    if (!detail) return;
    const data = tab.folderData;
    const state = tab.folderState;
    const entry = rel ? data.byRel.get(rel) : null;
    if (tab.refs.folderBody) tab.refs.folderBody.classList.toggle('detail-open', !!entry);
    if (!entry) {
      detail.replaceChildren(h('div', { class: 'detail-empty' },
        icon('file-search'),
        h('p', { text: '选择一个文件查看详情' })
      ));
      return;
    }
    const leftPath = absOf(data.left, entry.rel);
    const rightPath = absOf(data.right, entry.rel);

    const action = (iconName, label, onClick, cls = '') =>
      h('button', { class: `btn sm block ${cls}`.trim(), onClick }, icon(iconName), h('span', { text: label }));

    const actions = h('div', { class: 'detail-actions' },
      entry.status !== 'left-only' && entry.status !== 'right-only'
        ? action('git-compare', '对比文件内容', () => this.openFolderDiff(tab, entry), 'primary')
        : null,
      entry.status === 'left-only' || entry.status === 'modified'
        ? action('arrow-right', '复制到右侧', () => this.copyEntry(tab, entry, 'right'))
        : null,
      entry.status === 'right-only' || entry.status === 'modified'
        ? action('arrow-left', '复制到左侧', () => this.copyEntry(tab, entry, 'left'))
        : null,
      entry.left ? action('file-text', '在编辑器中打开左侧', () => this.onOpenFile(leftPath)) : null,
      entry.right ? action('file-text', '在编辑器中打开右侧', () => this.onOpenFile(rightPath)) : null
    );

    const sideCard = (side, info, path) => {
      if (!info) {
        return h('div', { class: `detail-side absent` },
          h('div', { class: 'detail-side-title' }, side),
          h('div', { class: 'detail-absent', text: '不存在' })
        );
      }
      return h('div', { class: 'detail-side' },
        h('div', { class: 'detail-side-title' }, side),
        h('div', { class: 'detail-path', title: path, text: path }),
        h('div', { class: 'detail-meta' },
          h('span', { text: formatBytes(info.size) }),
          h('span', { class: 'dot-sep', text: '·' }),
          h('span', { text: formatTime(info.mtime) })
        )
      );
    };

    detail.replaceChildren(
      h('div', { class: 'detail-head' },
        h('div', { class: `detail-status ${statusClass(entry.status)}`, text: statusLabel(entry.status) }),
        h('div', { class: 'detail-name', title: entry.rel }, entry.rel),
        h('button', {
          class: 'icon-btn detail-close',
          title: '关闭详情',
          'aria-label': '关闭详情',
          onClick: () => {
            state.selected = null;
            tab.refs.list.querySelectorAll('.fs-row.selected').forEach((el) => el.classList.remove('selected'));
            this.renderFolderDetail(tab, null);
          },
        }, icon('x'))
      ),
      h('div', { class: 'detail-sides' },
        sideCard('左侧', entry.left, leftPath),
        sideCard('右侧', entry.right, rightPath)
      ),
      actions,
      h('div', { class: 'detail-danger' },
        entry.left ? h('button', {
          class: 'link-btn danger',
          onClick: () => this.deleteSide(tab, entry, 'left'),
        }, '删除左侧文件') : null,
        entry.right ? h('button', {
          class: 'link-btn danger',
          onClick: () => this.deleteSide(tab, entry, 'right'),
        }, '删除右侧文件') : null
      )
    );
  }

  openFolderDiff(tab, entry) {
    const data = tab.folderData;
    const leftPath = absOf(data.left, entry.rel);
    const rightPath = absOf(data.right, entry.rel);
    if (!entry.left || !entry.right) {
      toast('该文件只存在于一侧，复制后才能对比', 'warn');
      return;
    }
    this.onOpenDiff(leftPath, rightPath);
  }

  async copyEntry(tab, entry, direction) {
    const data = tab.folderData;
    const from = direction === 'right' ? absOf(data.left, entry.rel) : absOf(data.right, entry.rel);
    const to = direction === 'right' ? absOf(data.right, entry.rel) : absOf(data.left, entry.rel);
    try {
      await api.copy(from, to);
      toast(`已复制到${direction === 'right' ? '右' : '左'}侧`, 'success');
      await this.loadFolders(tab);
      tab.folderState.selected = entry.rel;
      this.renderFolderDetail(tab, entry.rel);
    } catch (err) {
      toast('复制失败：' + err.message, 'error');
    }
  }

  async deleteSide(tab, entry, side) {
    const data = tab.folderData;
    const path = side === 'left' ? absOf(data.left, entry.rel) : absOf(data.right, entry.rel);
    const ok = await confirmDialog({
      title: '删除文件',
      message: `确定要删除${side === 'left' ? '左' : '右'}侧的「${entry.rel}」吗？`,
      detail: '此操作会直接删除文件，无法撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(path);
      toast('已删除', 'success');
      await this.loadFolders(tab);
    } catch (err) {
      toast('删除失败：' + err.message, 'error');
    }
  }

  async batchSync(tab, direction) {
    const data = tab.folderData;
    if (!data) return;
    const state = tab.folderState;
    const candidates = data.entries.filter((e) =>
      !e.isDir && (direction === 'right'
        ? (e.status === 'left-only' || e.status === 'modified')
        : (e.status === 'right-only' || e.status === 'modified'))
    );
    if (!candidates.length) {
      toast('没有需要同步的文件', 'info');
      return;
    }
    const ok = await confirmDialog({
      title: '批量同步',
      message: `将把 ${candidates.length} 个文件复制到${direction === 'right' ? '右' : '左'}侧。`,
      detail: '已存在的文件会被覆盖。建议先确认比较结果无误。',
      confirmText: `同步 ${candidates.length} 个文件`,
      danger: true,
    });
    if (!ok) return;

    const progress = openModal({
      title: '正在同步',
      width: '420px',
      body: h('div', { class: 'sync-progress' },
        h('div', { class: 'cmp-loading' }, h('span', { class: 'spinner' }), h('p', { text: '准备中…' }))
      ),
      closeOnBackdrop: false,
    });
    const progressText = progress.body.querySelector('p');
    let done = 0;
    let failed = [];
    for (const entry of candidates) {
      try {
        const from = direction === 'right' ? absOf(data.left, entry.rel) : absOf(data.right, entry.rel);
        const to = direction === 'right' ? absOf(data.right, entry.rel) : absOf(data.left, entry.rel);
        await api.copy(from, to);
      } catch (err) {
        failed.push(`${entry.rel}: ${err.message}`);
      }
      done++;
      if (progressText) progressText.textContent = `${done} / ${candidates.length}`;
    }
    progress.close();
    if (failed.length) {
      toast(`同步完成，${failed.length} 个文件失败`, 'error', 5000);
      console.warn('sync failures', failed);
    } else {
      toast(`已同步 ${done} 个文件`, 'success');
    }
    await this.loadFolders(tab);
  }

  showFolderOptions(tab, anchor) {
    document.querySelectorAll('.popover').forEach((p) => p.remove());
    const c = tab.compare;
    const state = tab.folderState;
    const pop = h('div', { class: 'popover wide' });
    const fastCb = h('input', { type: 'checkbox', checked: state.fast });
    const includeIn = h('input', { class: 'text-input sm', value: c.include || '', placeholder: '* 或 src/**' });
    const excludeIn = h('input', { class: 'text-input sm', value: c.exclude || '', placeholder: 'node_modules/**, .git/**' });
    pop.append(
      h('div', { class: 'popover-title' }, '文件夹比较选项'),
      h('label', { class: 'popover-check' }, fastCb, '快速比较（仅大小 + 修改时间）'),
      h('label', { class: 'popover-field' }, h('span', {}, '包含'), includeIn),
      h('label', { class: 'popover-field' }, h('span', {}, '排除'), excludeIn),
      h('div', { class: 'popover-note', text: '支持通配符 *、**、?，多个规则用逗号分隔。' }),
      h('div', { class: 'popover-actions' },
        h('button', {
          class: 'btn primary sm',
          onClick: () => {
            state.fast = fastCb.checked;
            c.include = includeIn.value.trim();
            c.exclude = excludeIn.value.trim();
            pop.remove();
            this.loadFolders(tab);
          },
        }, '应用并重新比较')
      )
    );
    this._positionPopover(pop, anchor);
  }
}
