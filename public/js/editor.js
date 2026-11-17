/** CodeMirror wrapper: languages, per-tab documents, view state. */

const LANG_BY_EXT = {
  js: ['javascript', 'JavaScript', { jsx: true }],
  mjs: ['javascript', 'JavaScript', { jsx: true }],
  cjs: ['javascript', 'JavaScript', { jsx: true }],
  jsx: ['javascript', 'JavaScript (JSX)', { jsx: true }],
  ts: ['javascript', 'TypeScript', { typescript: true }],
  tsx: ['javascript', 'TypeScript (TSX)', { typescript: true, jsx: true }],
  json: ['javascript', 'JSON', { json: true }],
  jsonc: ['javascript', 'JSON with Comments', { json: true }],
  html: ['htmlmixed', 'HTML'],
  htm: ['htmlmixed', 'HTML'],
  vue: ['htmlmixed', 'Vue'],
  svelte: ['htmlmixed', 'Svelte'],
  xml: ['xml', 'XML'],
  svg: ['xml', 'SVG'],
  xsl: ['xml', 'XSL'],
  plist: ['xml', 'Property List'],
  css: ['css', 'CSS'],
  scss: ['text/x-scss', 'SCSS'],
  less: ['text/x-less', 'Less'],
  md: ['markdown', 'Markdown', { fencedCodeBlocks: true }],
  markdown: ['markdown', 'Markdown', { fencedCodeBlocks: true }],
  py: ['python', 'Python'],
  pyw: ['python', 'Python'],
  c: ['text/x-csrc', 'C'],
  h: ['text/x-csrc', 'C Header'],
  cpp: ['text/x-c++src', 'C++'],
  cc: ['text/x-c++src', 'C++'],
  cxx: ['text/x-c++src', 'C++'],
  hpp: ['text/x-c++src', 'C++ Header'],
  java: ['text/x-java', 'Java'],
  cs: ['text/x-csharp', 'C#'],
  go: ['go', 'Go'],
  rs: ['rust', 'Rust'],
  php: ['php', 'PHP'],
  sql: ['sql', 'SQL'],
  sh: ['shell', 'Shell'],
  bash: ['shell', 'Bash'],
  zsh: ['shell', 'Zsh'],
  bat: ['shell', 'Batch'],
  cmd: ['shell', 'Batch'],
  ps1: ['powershell', 'PowerShell'],
  yml: ['yaml', 'YAML'],
  yaml: ['yaml', 'YAML'],
  toml: ['toml', 'TOML'],
  ini: ['properties', 'INI'],
  conf: ['properties', 'Config'],
  cfg: ['properties', 'Config'],
  env: ['properties', 'Env'],
  properties: ['properties', 'Properties'],
  lua: ['lua', 'Lua'],
  vb: ['vb', 'Visual Basic'],
  swift: ['swift', 'Swift'],
  pl: ['perl', 'Perl'],
  r: ['r', 'R'],
  groovy: ['groovy', 'Groovy'],
  coffee: ['coffeescript', 'CoffeeScript'],
  clj: ['clojure', 'Clojure'],
  cljs: ['clojure', 'ClojureScript'],
  dart: ['dart', 'Dart'],
  diff: ['diff', 'Diff'],
  patch: ['diff', 'Patch'],
  txt: ['text/plain', '纯文本'],
  log: ['text/plain', '日志'],
};

const LANG_BY_NAME = {
  dockerfile: ['dockerfile', 'Dockerfile'],
  makefile: ['text/x-csrc', 'Makefile'],
  '.gitignore': ['text/plain', 'Git Ignore'],
  '.env': ['properties', 'Env'],
  '.editorconfig': ['properties', 'EditorConfig'],
  '.npmrc': ['properties', 'NPM Config'],
  '.babelrc': ['javascript', 'Babel Config', { json: true }],
};

export function languageFor(filePath) {
  if (!filePath) return { cmMode: 'text/plain', label: '纯文本', key: 'plain' };
  const name = filePath.split(/[\\/]/).pop() || '';
  const lower = name.toLowerCase();
  if (LANG_BY_NAME[lower]) {
    const [mode, label, extra] = LANG_BY_NAME[lower];
    return { cmMode: extra ? { name: mode, ...extra } : mode, label, key: lower };
  }
  if (lower.startsWith('dockerfile')) return { cmMode: 'dockerfile', label: 'Dockerfile', key: 'dockerfile' };
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  const entry = LANG_BY_EXT[ext];
  if (!entry) return { cmMode: 'text/plain', label: ext ? ext.toUpperCase() : '纯文本', key: 'plain' };
  const [mode, label, extra] = entry;
  return { cmMode: extra ? { name: mode, ...extra } : mode, label, key: ext };
}

export function isBinaryExt(ext) {
  return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'pdf', 'zip', 'rar', '7z', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib', 'mp3', 'mp4', 'avi', 'mov', 'woff', 'woff2', 'ttf', 'otf', 'class', 'jar', 'pyc', 'bin', 'dat'].includes(ext);
}

export class FileDockEditor {
  constructor({ textarea, onChange, onCursor, onFocus }) {
    this.cm = CodeMirror.fromTextArea(textarea, {
      value: '',
      theme: 'filedock',
      lineNumbers: true,
      lineWrapping: false,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      styleActiveLine: { nonEmpty: true },
      matchBrackets: true,
      autoCloseBrackets: true,
      autoCloseTags: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      highlightSelectionMatches: { showToken: /[\w$]+/, annotateScrollbar: false },
      showTrailingSpace: false,
      cursorBlinkRate: 520,
      scrollbarStyle: 'native',
      extraKeys: {
        'Ctrl-F': 'find',
        'Ctrl-H': 'replace',
        'Shift-Ctrl-F': 'replace',
        'Ctrl-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Ctrl-R': 'replaceAll',
        'Ctrl-/': 'toggleComment',
        'Ctrl-Shift-/': 'toggleComment',
        'Ctrl-D': (cm) => duplicateLines(cm),
        'Ctrl-Shift-D': (cm) => deleteLines(cm),
        'Alt-Up': (cm) => moveLines(cm, -1),
        'Alt-Down': (cm) => moveLines(cm, 1),
        'Ctrl-Shift-K': (cm) => deleteLines(cm),
      },
    });
    this.cm.setSize('100%', '100%');
    this.cm.on('change', () => onChange && onChange(this.cm));
    this.cm.on('cursorActivity', () => onCursor && onCursor(this.cm));
    this.cm.on('focus', () => onFocus && onFocus(this.cm));
    this.cm.on('scroll', () => { this.lastScroll = this.cm.getScrollInfo(); });
    this.lastScroll = { left: 0, top: 0 };
  }

  createDoc(text, filePath) {
    const lang = languageFor(filePath);
    const doc = CodeMirror.Doc(text || '', lang.cmMode, 0);
    return { doc, lang };
  }

  activate(tab) {
    this.cm.swapDoc(tab.doc);
    this.cm.setOption('mode', tab.lang.cmMode);
    this.cm.setOption('indentUnit', tab.tabSize ?? 4);
    this.cm.setOption('tabSize', tab.tabSize ?? 4);
    this.cm.setOption('indentWithTabs', tab.indentWithTabs ?? false);
    if (tab.cursor) tab.doc.setCursor(tab.cursor);
    this.cm.refresh();
    requestAnimationFrame(() => {
      this.cm.refresh();
      if (tab.scroll) this.cm.scrollTo(tab.scroll.left || 0, tab.scroll.top || 0);
      this.cm.focus();
    });
  }

  saveView(tab) {
    if (!tab || !tab.doc) return;
    tab.cursor = tab.doc.getCursor();
    const info = this.cm.getScrollInfo();
    tab.scroll = { left: info.left, top: info.top };
  }

  getValue(tab) {
    if (!tab) return '';
    return tab.doc.getValue();
  }

  insertText(text) {
    this.cm.replaceSelection(text);
  }

  gotoLine(line, ch = 0, { select = false, flash = true } = {}) {
    const target = { line: Math.max(0, line - 1), ch: Math.max(0, ch - 1) };
    this.cm.setCursor(target);
    this.cm.scrollIntoView({ line: target.line, ch: target.ch }, 120);
    this.cm.focus();
    if (select) {
      const lineText = this.cm.getLine(target.line) || '';
      this.cm.setSelection(target, { line: target.line, ch: lineText.length });
    }
  }

  focus() {
    this.cm.focus();
  }

  refresh() {
    this.cm.refresh();
  }

  setOption(key, value) {
    this.cm.setOption(key, value);
    this.cm.refresh();
  }
}

// ------------------------------------------------------------------ line commands

export function duplicateLines(cm) {
  const ranges = cm.listSelections().sort((a, b) => b.anchor.line - a.anchor.line);
  cm.operation(() => {
    for (const range of ranges) {
      const start = Math.min(range.anchor.line, range.head.line);
      const end = Math.max(range.anchor.line, range.head.line);
      const text = cm.getRange({ line: start, ch: 0 }, { line: end, ch: null });
      cm.replaceRange('\n' + text, { line: end, ch: null }, { line: end, ch: null }, '+input');
    }
  });
}

export function deleteLines(cm) {
  const ranges = cm.listSelections().sort((a, b) => b.anchor.line - a.anchor.line);
  cm.operation(() => {
    for (const range of ranges) {
      const start = Math.min(range.anchor.line, range.head.line);
      const end = Math.max(range.anchor.line, range.head.line);
      if (start === end && start === cm.lastLine()) {
        cm.replaceRange('', { line: start, ch: 0 }, { line: start, ch: null });
      } else {
        cm.replaceRange('', { line: start, ch: 0 }, { line: Math.min(end + 1, cm.lastLine()), ch: 0 });
      }
    }
  });
}

function moveLines(cm, dir) {
  const ranges = cm.listSelections();
  cm.operation(() => {
    for (const range of ranges) {
      let start = Math.min(range.anchor.line, range.head.line);
      let end = Math.max(range.anchor.line, range.head.line);
      start = Math.max(0, Math.min(start, cm.lastLine()));
      end = Math.max(0, Math.min(end, cm.lastLine()));
      if (dir < 0 && start === 0) continue;
      if (dir > 0 && end >= cm.lastLine()) continue;

      const line = cm.getLine(start);
      const text = cm.getRange({ line: start, ch: 0 }, { line: end, ch: null });

      if (dir < 0) {
        const above = cm.getLine(start - 1);
        cm.replaceRange(above + '\n' + text, { line: start - 1, ch: 0 }, { line: end, ch: null });
        cm.setSelection({ line: start - 1, ch: 0 }, { line: start - 1, ch: 0 });
        cm.setCursor({ line: start - 1, ch: range.anchor.ch });
        void line;
      } else {
        const below = cm.getLine(end + 1);
        cm.replaceRange(text + '\n' + below, { line: start, ch: 0 }, { line: end + 1, ch: null });
        cm.setCursor({ line: start + 1, ch: range.anchor.ch });
      }
    }
  });
}
