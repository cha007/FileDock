/**
 * Line / word diff engine used by the compare view.
 * Myers O(ND) diff with prefix/suffix trimming, plus a safe fallback
 * for very large or very different files.
 */

const DEFAULT_OPTIONS = {
  ignoreCase: false,
  ignoreWhitespace: 'none', // none | trailing | all
  ignoreBlankLines: false,
};

function normalizeLine(line, opts) {
  let s = line;
  if (opts.ignoreCase) s = s.toLowerCase();
  if (opts.ignoreWhitespace === 'all') s = s.replace(/\s+/g, '');
  else if (opts.ignoreWhitespace === 'trailing') s = s.replace(/[ \t]+$/, '');
  return s;
}

/** Myers diff on two arrays. Returns null when the edit distance exceeds maxD. */
function myers(a, b, maxD = 3000) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((_, j) => ({ t: 'ins', j }));
  if (!m) return a.map((_, i) => ({ t: 'del', i }));

  const limit = Math.min(maxD, n + m);
  let v = new Map();
  v.set(1, 0);
  const trace = [];
  let foundD = -1;

  for (let d = 0; d <= limit; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const left = v.has(k - 1) ? v.get(k - 1) : -Infinity;
      const down = v.has(k + 1) ? v.get(k + 1) : -Infinity;
      let x;
      if (k === -d || (k !== d && left < down)) x = down === -Infinity ? 0 : down;
      else x = (left === -Infinity ? 0 : left) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { foundD = d; break; }
    }
    if (foundD >= 0) break;
  }

  if (foundD < 0) return null;

  const ops = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const left = prev.has(k - 1) ? prev.get(k - 1) : -Infinity;
    const down = prev.has(k + 1) ? prev.get(k + 1) : -Infinity;
    let prevK;
    if (k === -d || (k !== d && left < down)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = prev.has(prevK) ? prev.get(prevK) : 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--; y--;
      ops.push({ t: 'eq', i: x, j: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ t: 'ins', j: y });
      } else {
        x--;
        ops.push({ t: 'del', i: x });
      }
    }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ t: 'eq', i: x, j: y }); }
  while (x > 0) { x--; ops.push({ t: 'del', i: x }); }
  while (y > 0) { y--; ops.push({ t: 'ins', j: y }); }
  ops.reverse();
  return ops;
}

/** Diff two sequences with common prefix/suffix trimming. Returns null if too different. */
function diffSequence(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return b.map((_, j) => ({ t: 'ins', j }));
  if (!m) return a.map((_, i) => ({ t: 'del', i }));

  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let mid;
  if (!midA.length) mid = midB.map((_, j) => ({ t: 'ins', j }));
  else if (!midB.length) mid = midA.map((_, i) => ({ t: 'del', i }));
  else mid = myers(midA, midB, maxD);

  if (mid === null) return null;

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: 'eq', i, j: i });
  for (const op of mid) {
    if (op.t === 'eq') ops.push({ t: 'eq', i: start + op.i, j: start + op.j });
    else if (op.t === 'del') ops.push({ t: 'del', i: start + op.i });
    else ops.push({ t: 'ins', j: start + op.j });
  }
  for (let k = 0; k < n - endA; k++) ops.push({ t: 'eq', i: endA + k, j: endB + k });
  return ops;
}

// ------------------------------------------------------------------ words

const TOKEN_RE = /[\u3400-\u9fff\uf900-\ufaff]|[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu;

function tokenize(line) {
  return line.match(TOKEN_RE) || [];
}

function pushSeg(list, text, type) {
  if (!text) return;
  const last = list[list.length - 1];
  if (last && last.type === type) last.text += text;
  else list.push({ text, type });
}

function diffWords(a, b) {
  if (a === b) {
    return { left: [{ text: a, type: 'same' }], right: [{ text: b, type: 'same' }] };
  }
  if (a.length > 4000 || b.length > 4000) {
    return { left: [{ text: a, type: 'del' }], right: [{ text: b, type: 'add' }] };
  }
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length > 900 || tb.length > 900) {
    return { left: [{ text: a, type: 'del' }], right: [{ text: b, type: 'add' }] };
  }
  const ops = diffSequence(ta, tb, 500);
  if (!ops) {
    return { left: [{ text: a, type: 'del' }], right: [{ text: b, type: 'add' }] };
  }
  const left = [];
  const right = [];
  for (const op of ops) {
    if (op.t === 'eq') {
      pushSeg(left, ta[op.i], 'same');
      pushSeg(right, tb[op.j], 'same');
    } else if (op.t === 'del') {
      pushSeg(left, ta[op.i], 'del');
    } else {
      pushSeg(right, tb[op.j], 'add');
    }
  }
  return { left, right };
}

// ------------------------------------------------------------------ rows

function fallbackRows(a, b, opts) {
  const rows = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const l = a[i];
    const r = b[i];
    if (l === undefined) {
      rows.push({ type: 'ins', left: null, right: { no: i + 1, text: r } });
    } else if (r === undefined) {
      rows.push({ type: 'del', left: { no: i + 1, text: l }, right: null });
    } else if (normalizeLine(l, opts) === normalizeLine(r, opts)) {
      rows.push({ type: 'equal', left: { no: i + 1, text: l }, right: { no: i + 1, text: r } });
    } else {
      const wd = diffWords(l, r);
      rows.push({
        type: 'mod',
        left: { no: i + 1, text: l, segs: wd.left },
        right: { no: i + 1, text: r, segs: wd.right },
      });
    }
  }
  return { rows, fallback: true };
}

/**
 * Build side-by-side rows.
 * @returns {{rows: Array, stats: {added:number, removed:number, modified:number}, fallback: boolean}}
 */
export function diffLines(aLines, bLines, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const a = aLines;
  const b = bLines;
  const normA = a.map((l) => normalizeLine(l, opts));
  const normB = b.map((l) => normalizeLine(l, opts));

  const ops = diffSequence(normA, normB, 4000);
  if (!ops) {
    return fallbackRows(a, b, opts);
  }

  const rows = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.t === 'eq') {
      rows.push({
        type: 'equal',
        left: { no: op.i + 1, text: a[op.i] },
        right: { no: op.j + 1, text: b[op.j] },
      });
      i++;
      continue;
    }
    const dels = [];
    const inss = [];
    while (i < ops.length && ops[i].t !== 'eq') {
      if (ops[i].t === 'del') dels.push(ops[i].i);
      else inss.push(ops[i].j);
      i++;
    }
    if (opts.ignoreBlankLines && dels.every((k) => !a[k].trim()) && inss.every((k) => !b[k].trim())) {
      continue;
    }
    const pair = Math.min(dels.length, inss.length);
    for (let k = 0; k < pair; k++) {
      const li = dels[k];
      const ri = inss[k];
      const wd = diffWords(a[li], b[ri]);
      rows.push({
        type: 'mod',
        left: { no: li + 1, text: a[li], segs: wd.left },
        right: { no: ri + 1, text: b[ri], segs: wd.right },
      });
    }
    for (let k = pair; k < dels.length; k++) {
      rows.push({ type: 'del', left: { no: dels[k] + 1, text: a[dels[k]] }, right: null });
    }
    for (let k = pair; k < inss.length; k++) {
      rows.push({ type: 'ins', left: null, right: { no: inss[k] + 1, text: b[inss[k]] } });
    }
  }

  return { rows, stats: summarize(rows), fallback: false };
}

export function summarize(rows) {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const row of rows) {
    if (row.type === 'ins') added++;
    else if (row.type === 'del') removed++;
    else if (row.type === 'mod') modified++;
  }
  return { added, removed, modified };
}

export function findHunks(rows, changedTypes = ['mod', 'del', 'ins']) {
  const hunks = [];
  let current = null;
  for (let i = 0; i < rows.length; i++) {
    if (changedTypes.includes(rows[i].type)) {
      if (!current) current = { start: i, end: i };
      else current.end = i;
    } else if (current) {
      hunks.push(current);
      current = null;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export function toUnified(rows) {
  const out = [];
  for (const row of rows) {
    if (row.type === 'equal') {
      out.push({ type: 'equal', ln1: row.left.no, ln2: row.right.no, text: row.left.text });
    } else if (row.type === 'mod') {
      out.push({ type: 'del', ln1: row.left.no, text: row.left.text, segs: row.left.segs, row });
      out.push({ type: 'ins', ln2: row.right.no, text: row.right.text, segs: row.right.segs, row });
    } else if (row.type === 'del') {
      out.push({ type: 'del', ln1: row.left.no, text: row.left.text, row });
    } else {
      out.push({ type: 'ins', ln2: row.right.no, text: row.right.text, row });
    }
  }
  return out;
}

export function unifiedHunks(items) {
  return findHunks(items, ['del', 'ins']);
}

export { DEFAULT_OPTIONS };
