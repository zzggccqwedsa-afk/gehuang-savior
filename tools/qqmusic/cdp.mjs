// Minimal Chrome DevTools Protocol driver — zero dependencies (Node 22+ global WebSocket).
// Usage: import { connect } from './cdp.mjs'

const DEFAULT_PORT = 9222;

async function httpJson(url, timeoutMs = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function listTargets(port = DEFAULT_PORT) {
  return httpJson(`http://127.0.0.1:${port}/json/list`);
}

export async function browserVersion(port = DEFAULT_PORT) {
  return httpJson(`http://127.0.0.1:${port}/json/version`);
}

/**
 * Attach to the first page target (or one whose url matches `matchUrl`).
 * Returns a small session object with helpers.
 */
export async function connect({ port = DEFAULT_PORT, matchUrl = null, createIfMissing = false } = {}) {
  let targets = await listTargets(port);
  let page = targets.filter((t) => t.type === 'page');
  if (matchUrl) {
    const re = matchUrl instanceof RegExp ? matchUrl : new RegExp(matchUrl);
    page = page.filter((t) => re.test(t.url));
  }
  let target = page[0];

  if (!target && createIfMissing) {
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    targets = await listTargets(port);
    target = targets.find((t) => t.type === 'page');
  }
  if (!target) throw new Error('no page target found on port ' + port);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('websocket open timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('websocket error: ' + (e.message || 'unknown'))); }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const closed = { flag: false };
  let closeResolve;
  const closePromise = new Promise((r) => { closeResolve = r; });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const hs = listeners.get(msg.method);
    if (hs) for (const h of [...hs]) h(msg.params);
  });

  ws.addEventListener('close', () => {
    closed.flag = true;
    for (const [, p] of pending) p.reject(new Error('connection closed'));
    pending.clear();
    closeResolve();
  });

  function send(method, params = {}, timeoutMs = 30000) {
    if (closed.flag) return Promise.reject(new Error('connection closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeoutMs);
      pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function waitFor(event, predicate = () => true, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs);
      off = on(event, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  /** Evaluate an expression in the page; awaits promises; returns the JSON value. */
  async function evaluate(expression, { timeoutMs = 30000 } = {}) {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page exception: ' + (d.exception?.description || d.text || 'unknown'));
    }
    return r.result?.value;
  }

  async function navigate(url, { waitMs = 1500, timeoutMs = 45000 } = {}) {
    const loaded = waitFor('Page.loadEventFired', () => true, timeoutMs).catch(() => null);
    const r = await send('Page.navigate', { url });
    if (r.errorText) throw new Error('navigate failed: ' + r.errorText);
    await loaded;
    await sleep(waitMs);
    return r;
  }

  async function screenshot(path) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, 30000);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  function close() {
    try { ws.close(); } catch {}
    return closePromise;
  }

  return { send, on, waitFor, evaluate, navigate, screenshot, close, target, wsUrl: target.webSocketDebuggerUrl };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
