// QQ Music web driver over CDP (zero dependencies).
// The browser itself must be started OUTSIDE the DSH sandbox (see open-browser.cmd),
// because Chromium cannot create its Mojo IPC named pipes inside the sandbox.
//
//   node qqm.mjs status
//   node qqm.mjs open [url]
//   node qqm.mjs login            # wait until QQ Music login cookies appear
//   node qqm.mjs shot [file]
//   node qqm.mjs playlists
//   node qqm.mjs songs <disstid> [limit]
//   node qqm.mjs eval "<js>"
//   node qqm.mjs close

import { connect, browserVersion, sleep } from './cdp.mjs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.QM_CDP_PORT || 9222);
const OUT_DIR = path.resolve(process.env.QM_OUT_DIR || new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const cmd = process.argv[2] || 'status';

async function main() {
  if (cmd === 'status') {
    let v;
    try {
      v = await browserVersion(PORT);
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: 'CDP not reachable on port ' + PORT, detail: String(e.message) }));
      process.exit(1);
    }
    const s = await connect({ port: PORT });
    const info = await s.evaluate(`JSON.stringify({url: location.href, title: document.title, ready: document.readyState})`);
    await s.close();
    console.log(JSON.stringify({ ok: true, browser: v.Browser, port: PORT, page: JSON.parse(info) }, null, 2));
    return;
  }

  const s = await connect({ port: PORT, createIfMissing: cmd === 'open' });

  if (cmd === 'open') {
    const url = process.argv[3] || 'https://y.qq.com/';
    await s.navigate(url, { waitMs: 2500 });
    console.log(JSON.stringify({ ok: true, url, title: await s.evaluate('document.title') }));
  } else if (cmd === 'eval') {
    const expr = process.argv.slice(3).join(' ');
    console.log(typeof (await s.evaluate(expr)) === 'string' ? await s.evaluate(expr) : JSON.stringify(await s.evaluate(expr), null, 2));
  } else if (cmd === 'shot') {
    await mkdir(OUT_DIR, { recursive: true });
    const file = process.argv[3] ? path.resolve(process.argv[3]) : path.join(OUT_DIR, `shot-${Date.now()}.png`);
    await s.screenshot(file);
    console.log(JSON.stringify({ ok: true, file }));
  } else if (cmd === 'login') {
    // Poll for QQ Music login cookies (qm_keyst = login key, uin = account id).
    const deadline = Date.now() + Number(process.env.QM_LOGIN_TIMEOUT_MS || 240000);
    let last = null;
    while (Date.now() < deadline) {
      const cookies = await s.send('Network.getAllCookies', {});
      const jar = Object.fromEntries((cookies.cookies || []).filter((c) => /(^|\.)qq\.com$/.test(c.domain) || /(^|\.)y\.qq\.com$/.test(c.domain)).map((c) => [c.name, c.value]));
      last = { loggedIn: Boolean(jar.qm_keyst), uin: jar.uin || jar.wxuin || null, nick: jar.qqmusic_nick || null, keys: Object.keys(jar).length };
      if (last.loggedIn) { console.log(JSON.stringify({ ok: true, ...last })); await s.close(); return; }
      await sleep(2000);
    }
    console.log(JSON.stringify({ ok: false, error: 'login timeout', ...last }));
    await s.close();
    process.exit(2);
  } else if (cmd === 'playlists') {
    const raw = await s.evaluate(`(() => {
      const out = []; const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/n/ryqq/playlist/"]')) {
        const m = (a.getAttribute('href') || '').match(/playlist\\/(\\d+)/);
        if (!m) continue;
        const id = m[1];
        const title = (a.getAttribute('title') || a.textContent || '').trim().replace(/\\s+/g, ' ');
        if (!title || seen.has(id)) continue;
        seen.add(id); out.push({ id, title });
      }
      return JSON.stringify(out);
    })()`);
    const list = JSON.parse(raw);
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, 'playlists.json'), JSON.stringify(list, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, count: list.length, playlists: list }, null, 2));
  } else if (cmd === 'songs') {
    const disstid = process.argv[3];
    if (!disstid) throw new Error('usage: songs <disstid>');
    const limit = Number(process.argv[4] || 500);
    const raw = await s.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.songlist__item, .songlist__item--even, li.songlist__item')];
      const songs = rows.map((row) => {
        const name = (row.querySelector('.songlist__songname_txt')?.textContent || '').trim();
        const singer = (row.querySelector('.songlist__artist')?.textContent || '').trim();
        const album = (row.querySelector('.songlist__album')?.textContent || '').trim();
        const dur = (row.querySelector('.songlist__time')?.textContent || '').trim();
        return { name, singer, album, dur };
      }).filter((x) => x.name);
      return JSON.stringify({ count: songs.length, songs: songs.slice(0, ${limit}) });
    })()`);
    const data = JSON.parse(raw);
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, `playlist-${disstid}.json`), JSON.stringify(data, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, disstid, count: data.count, songs: data.songs }, null, 2));
  } else if (cmd === 'eval-file') {
    const file = process.argv[3];
    const expr = await readFile(file, 'utf8');
    const val = await s.evaluate(expr);
    console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
  } else if (cmd === 'frames') {
    const tree = await s.send('Page.getFrameTree', {});
    const flat = [];
    (function walk(node, depth) {
      flat.push({ depth, id: node.frame.id, url: node.frame.url, name: node.frame.name });
      for (const c of node.childFrames || []) walk(c, depth + 1);
    })(tree.frameTree, 0);
    console.log(JSON.stringify(flat, null, 2));
  } else if (cmd === 'frame-eval') {
    const needle = process.argv[3];
    const expr = process.argv.slice(4).join(' ');
    const tree = await s.send('Page.getFrameTree', {});
    const found = [];
    (function walk(node) {
      if (node.frame.url.includes(needle)) found.push(node.frame);
      for (const c of node.childFrames || []) walk(c);
    })(tree.frameTree);
    if (!found.length) throw new Error('no frame matching ' + needle);
    const out = [];
    for (const f of found) {
      const { executionContextId } = await s.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'qm-probe' });
      const r = await s.send('Runtime.evaluate', { expression: expr, contextId: executionContextId, returnByValue: true, awaitPromise: true });
      out.push({ frameId: f.id, url: f.url, value: r.result?.value ?? null, error: r.exceptionDetails?.exception?.description || null });
    }
    console.log(JSON.stringify(out, null, 2));
  } else if (cmd === 'close') {
    await s.send('Browser.close').catch(() => {});
    console.log(JSON.stringify({ ok: true }));
  } else {
    throw new Error('unknown command: ' + cmd);
  }

  await s.close();
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exit(1);
});
