/**
 * Lightweight preview renderers for Markdown and JSON.
 *
 * No third-party code: the app already ships CodeMirror for editing, and these
 * formats only need a readable rendering. Everything is HTML-escaped first, so
 * a document can never inject markup or scripts into the app window.
 */

export function previewKind(langKey) {
  if (langKey === 'md' || langKey === 'markdown') return 'markdown';
  if (langKey === 'json' || langKey === 'jsonc') return 'json';
  return null;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(url) {
  const value = String(url).trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^(#|\/|\.{1,2}\/)/.test(value)) return value;
  return '';
}

function inline(text) {
  const codes = [];
  let out = escapeHtml(text);

  // Inline code first, so its content is not touched by the other rules.
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt, url) => `<span class="md-image">${alt || url}</span>`);

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>` : m;
  });

  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^\s_][^_\n]*?)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');

  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

const LIST_RE = /^ {0,3}([-*+]|\d+\.)\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

export function markdownToHtml(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null; // { tag, items }
  let quote = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    html.push(`<blockquote>${paragraphsOf(quote)}</blockquote>`);
    quote = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  const paragraphsOf = (text) => String(text)
    .split(/\n{2,}/)
    .map((block) => `<p>${inline(block.replace(/\n/g, ' '))}</p>`)
    .join('');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushAll();
      const marker = fence[1][0];
      const lang = fence[2];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      html.push(`<pre><code class="md-lang-${escapeHtml(lang || 'text')}">${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    // Blockquote.
    const quoted = line.match(/^ {0,3}>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote = quote ? `${quote}\n${quoted[1]}` : quoted[1];
      continue;
    }
    flushQuote();

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      html.push('<hr>');
      continue;
    }

    // GitHub-style table: header row followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushAll();
      const head = splitTableRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--;
      html.push('<table><thead><tr>' +
        head.map((cell) => `<th>${inline(cell)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + row.map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    const item = line.match(LIST_RE);
    if (item) {
      flushParagraph();
      flushQuote();
      const tag = /\d/.test(item[1][0]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(item[2]);
      continue;
    }

    if (list) {
      // Indented continuation of the previous list item.
      if (/^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
        continue;
      }
      flushList();
    }

    paragraph.push(line.trim());
  }

  flushAll();
  return html.join('\n');
}

const JSON_TOKEN_SOURCE = '("(?:\\\\u[\\da-fA-F]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(?:true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+-]?\\d+)?)';

function highlightJson(value) {
  const text = JSON.stringify(value, null, 2);
  const re = new RegExp(JSON_TOKEN_SOURCE, 'g');
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    out += escapeHtml(text.slice(last, match.index));
    const token = match[0];
    let cls = 'j-num';
    if (token.startsWith('"')) cls = /:\s*$/.test(token) ? 'j-key' : 'j-str';
    else if (/^(?:true|false|null)$/.test(token)) cls = 'j-lit';
    out += `<span class="${cls}">${escapeHtml(token)}</span>`;
    last = match.index + token.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

export function jsonToHtml(source) {
  const text = String(source).trim();
  if (!text) return '<p class="preview-empty">（空文件）</p>';
  try {
    const parsed = JSON.parse(text);
    const keys = Array.isArray(parsed)
      ? `${parsed.length} 项`
      : parsed && typeof parsed === 'object' ? `${Object.keys(parsed).length} 个键` : '标量';
    return `<div class="json-meta">JSON 有效 · ${keys}</div><pre class="json-view"><code>${highlightJson(parsed)}</code></pre>`;
  } catch (err) {
    return `<div class="preview-error">${escapeHtml(err.message)}</div>` +
      `<pre class="json-view"><code>${escapeHtml(text)}</code></pre>`;
  }
}

export function renderPreview(kind, source) {
  if (kind === 'markdown') return `<article class="markdown-body">${markdownToHtml(source)}</article>`;
  if (kind === 'json') return jsonToHtml(source);
  return '';
}
