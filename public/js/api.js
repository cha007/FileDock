const CFG = window.__FILEDOCK_CONFIG__ || {};

export const config = CFG;

async function request(method, url, body) {
  const headers = { 'x-app-token': CFG.token || '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error('无法连接本地服务，请重新启动 FileDock');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) {
    const e = new Error((data && (data.error || data.message)) || `请求失败 (${res.status})`);
    e.status = res.status;
    e.code = data && data.code;
    throw e;
  }
  return data;
}

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
};

export const api = {
  info: () => request('GET', '/api/info'),
  roots: () => request('GET', '/api/fs/roots'),
  list: (path) => request('GET', '/api/fs/list?' + qs({ path })),
  stat: (path) => request('GET', '/api/fs/stat?' + qs({ path })),
  read: (path) => request('GET', '/api/fs/read?' + qs({ path })),
  files: (path, opts = {}) => request('GET', '/api/fs/files?' + qs({ path, max: opts.max, include: opts.include, exclude: opts.exclude })),
  write: (path, content, encoding = 'utf8', eol = 'LF') =>
    request('POST', '/api/fs/write', { path, content, encoding, eol }),
  mkdir: (path) => request('POST', '/api/fs/mkdir', { path }),
  rename: (from, to) => request('POST', '/api/fs/rename', { from, to }),
  remove: (path) => request('POST', '/api/fs/delete', { path }),
  copy: (from, to) => request('POST', '/api/fs/copy', { from, to }),
  reveal: (path) => request('POST', '/api/fs/reveal', { path }),
  search: (params) => request('GET', '/api/search?' + qs(params)),
  indexSearch: (params) => request('GET', '/api/index/search?' + qs(params)),
  indexStatus: (root) => request('GET', '/api/index/status?' + qs({ root })),
  indexBuild: (root) => request('POST', '/api/index/build', { root }),
  replace: (params) => request('POST', '/api/replace', params),
  diffDirs: (params) => request('POST', '/api/diff/dirs', params),
};
