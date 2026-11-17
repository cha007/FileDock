'use strict';

/**
 * Desktop bridge for the Tauri shell. The page itself is served by the Rust
 * local server, so window chrome and native drag & drop are driven by plain
 * HTTP calls plus a few globals the Rust side evaluates in the webview.
 */
(function () {
  const cfg = window.__FILEDOCK_CONFIG__ || {};
  if (!cfg.desktop) return;
  if (window.filedock && window.filedock.desktop) return;

  const token = cfg.token || '';
  const headers = { 'x-app-token': token };

  const call = (name) => {
    fetch('/api/desktop/' + name, { method: 'POST', headers }).catch(() => {});
  };

  const maximizedCbs = new Set();
  const closeCbs = new Set();
  const dropCbs = new Set();
  const dragCbs = new Set();
  let currentMaximized = false;
  let stateKnown = false;

  const safe = (fn, value) => {
    try {
      fn(value);
    } catch (err) {
      console.error(err);
    }
  };

  window.__filedockWindowState = (maximized) => {
    currentMaximized = !!maximized;
    stateKnown = true;
    document.body.classList.toggle('maximized', currentMaximized);
    maximizedCbs.forEach((cb) => safe(cb, currentMaximized));
  };

  window.__filedockCloseRequested = () => {
    closeCbs.forEach((cb) => safe(cb));
  };

  window.__filedockDragState = (active) => {
    dragCbs.forEach((cb) => safe(cb, !!active));
  };

  window.__filedockDrop = (paths) => {
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
    dragCbs.forEach((cb) => safe(cb, false));
    dropCbs.forEach((cb) => safe(cb, list));
  };

  window.filedock = {
    desktop: true,
    platform: cfg.platform || 'win32',
    minimize: () => call('minimize'),
    toggleMaximize: () => call('toggle-maximize'),
    close: () => call('close'),
    forceClose: () => call('force-close'),
    startDrag: () => call('start-drag'),
    getPathForFile: () => '',
    onMaximized(callback) {
      if (typeof callback !== 'function') return () => {};
      maximizedCbs.add(callback);
      if (stateKnown) safe(callback, currentMaximized);
      return () => maximizedCbs.delete(callback);
    },
    onCloseRequested(callback) {
      if (typeof callback !== 'function') return () => {};
      closeCbs.add(callback);
      return () => closeCbs.delete(callback);
    },
    onFileDrop(callback) {
      if (typeof callback !== 'function') return () => {};
      dropCbs.add(callback);
      return () => dropCbs.delete(callback);
    },
    onDragState(callback) {
      if (typeof callback !== 'function') return () => {};
      dragCbs.add(callback);
      return () => dragCbs.delete(callback);
    },
    refreshWindowState() {
      return fetch('/api/desktop/state', { headers })
        .then((res) => (res.ok ? res.json() : null))
        .then((value) => {
          if (value) window.__filedockWindowState(!!value.maximized);
        })
        .catch(() => {});
    },
  };

  window.filedock.refreshWindowState();
})();
