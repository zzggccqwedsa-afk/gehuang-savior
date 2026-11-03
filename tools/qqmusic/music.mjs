// 音乐推荐工作流 CLI（复用入口）
//   node music.mjs verify music/candidates/round-01.json
//   node music.mjs render music/rounds/round-01.json
//   node music.mjs push   music/rounds/round-01.json
//   node music.mjs feedback <roundId> <songId|title> <like|skip> [备注]
//   node music.mjs status
import { connect, sleep, browserVersion } from './cdp.mjs';
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '../..');
const PORT = Number(process.env.QM_CDP_PORT || 9222);
const MAIN_PLAYLIST = process.env.QM_MAIN_PLAYLIST || '新建歌单2';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·・,，.。'"“”‘’!！?？\-—_/\\]/g, '');

const [cmd, ...args] = process.argv.slice(2);

async function searchSongs(page, query, n = 8) {
  const payload = {
    comm: { ct: 24, cv: 0 },
    req_0: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query, num_per_page: n, page_num: 1, search_type: 0 },
    },
  };
  const expr = `fetch('https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(${JSON.stringify(JSON.stringify(payload))}), {credentials:'include'})
    .then(r => r.json())
    .then(j => {
      const list = (((j.req_0 || {}).data || {}).body || {}).song || {list: []};
      return JSON.stringify((list.list || []).map(s => ({
        mid: s.mid,
        name: s.name || s.title,
        singers: (s.singer || []).map(x => x.name).join(' / '),
        album: (s.album || {}).name || '',
        interval: s.interval,
        pay: ((s.pay || {}).pay_play !== undefined ? (s.pay || {}).pay_play : null),
      })));
    })`;
  return JSON.parse(await page.evaluate(expr, { timeoutMs: 30000 }));
}

async function loadLibrary() {
  const file = path.join(WS, 'tools/qqmusic/out/playlists-all.json');
  const all = JSON.parse(await readFile(file, 'utf8'));
  const index = new Set();
  for (const pl of all) {
    for (const s of pl.songs) {
      index.add(norm(s.name) + '|' + norm(s.singers.split(' / ')[0]));
      index.add(norm(s.name));
    }
  }
  return index;
}

function pickMatch(results, cand) {
  const t = norm(cand.title);
  const artist = norm(String(cand.artist).split('/')[0]);
  const album = norm(cand.album);
  const scored = results.map((r) => {
    const rt = norm(r.name);
    const ra = norm(r.singers);
    const albumMatch = Boolean(album && norm(r.album).includes(album));
    const exactTitle = rt === t;
    const artistMatch = Boolean(artist && ra.includes(artist)) || (exactTitle && albumMatch);
    let score = 0;
    if (exactTitle) score += 10;
    else if (rt.startsWith(t) || t.startsWith(rt)) score += 6;
    else if (rt.includes(t)) score += 3;
    score += artistMatch ? 8 : -12;
    if (albumMatch) score += 4;
    if (!albumMatch && /live|remix|伴奏|纯音乐|dj|翻唱|cover/i.test(r.name)) score -= 6;
    return { r, score, artistMatch };
  }).sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score >= 14 && scored[0].artistMatch ? scored[0].r : null;
}

async function preflight() {
  try {
    await browserVersion(PORT);
  } catch {
    throw new Error(
      '浏览器未启动（CDP 127.0.0.1:' + PORT + ' 不可达）。' +
      '请双击 tools/qqmusic/open-browser.cmd，或以 sandbox_permissions: danger-full-access 启动 Edge 后重试。'
    );
  }
}

async function cmdDoctor() {
  const fsStat = await import('node:fs/promises').then((m) => m.stat).catch(() => null);
  let browser = 'down';
  try { await browserVersion(PORT); browser = 'ok'; } catch { /* down */ }

  let playlistsAgeMin = null;
  try {
    const st = await fsStat(path.join(WS, 'tools/qqmusic/out/playlists-all.json'));
    playlistsAgeMin = Math.round((Date.now() - st.mtimeMs) / 60000);
  } catch { /* 没有快照 */ }

  let feedback = 0;
  try {
    feedback = (await readFile(path.join(WS, 'music/feedback.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).length;
  } catch { /* 无 */ }

  let backlog = 0;
  try {
    const b = JSON.parse(await readFile(path.join(WS, 'music/backlog.json'), 'utf8'));
    backlog = b.items.filter((i) => i.status === 'reserve').length;
  } catch { /* 无 */ }

  console.log(JSON.stringify({
    browser,
    nextStep: browser === 'ok' ? '可以跑 verify / push' : '先启动浏览器（open-browser.cmd）',
    playlistsAgeMin,
    feedbackEntries: feedback,
    backlogReserve: backlog,
  }, null, 2));
}

async function withPage(fn) {
  await preflight();
  const page = await connect({ port: PORT });
  try { return await fn(page); } finally { await page.close(); }
}

async function resolveCandidates(page, list, lib, pendingLabel) {
  const items = [];
  for (const c of list) {
    let results = await searchSongs(page, c.title, 12);
    let hit = pickMatch(results, c);
    if (!hit) {
      results = await searchSongs(page, `${c.title} ${String(c.artist).split('/')[0]}`, 12);
      hit = pickMatch(results, c);
    }
    const already = hit ? lib.has(norm(hit.name) + '|' + norm(hit.singers.split(' / ')[0])) || lib.has(norm(hit.name)) : false;
    items.push({
      ...c,
      qq: hit ? { mid: hit.mid, name: hit.name, singers: hit.singers, album: hit.album, interval: hit.interval } : null,
      resolved: Boolean(hit),
      alreadyInLibrary: already,
      status: already ? '已在库' : hit ? pendingLabel : '未找到',
    });
    console.error(`[${hit && !already ? 'ok' : already ? 'dup' : 'miss'}] ${c.title} — ${c.artist}` + (hit ? ` => ${hit.name} / ${hit.singers}` : ''));
  }
  return items;
}

async function cmdVerify(file) {
  const cand = JSON.parse(await readFile(path.resolve(WS, file), 'utf8'));
  const lib = await loadLibrary();
  const out = await withPage((page) => resolveCandidates(page, cand.candidates, lib, 'pending'));

  const roundFile = path.join(WS, 'music/rounds', `round-${String(cand.round).padStart(2, '0')}.json`);
  await mkdir(path.dirname(roundFile), { recursive: true });
  const payload = {
    round: cand.round,
    createdAt: cand.createdAt,
    targetPlaylistName: cand.targetPlaylistName,
    verifiedAt: new Date().toISOString(),
    items: out,
  };
  await writeFile(roundFile, JSON.stringify(payload, null, 2), 'utf8');

  const summary = {
    round: cand.round,
    total: out.length,
    resolved: out.filter((i) => i.resolved).length,
    already: out.filter((i) => i.alreadyInLibrary).length,
    missing: out.filter((i) => !i.resolved).length,
    file: path.relative(WS, roundFile),
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function cmdReserve(file) {
  const cand = JSON.parse(await readFile(path.resolve(WS, file), 'utf8'));
  const lib = await loadLibrary();
  const out = await withPage((page) => resolveCandidates(page, cand.candidates, lib, 'reserve'));
  const outFile = path.join(WS, 'music/backlog.json');
  await writeFile(outFile, JSON.stringify({ kind: 'backlog', verifiedAt: new Date().toISOString(), items: out }, null, 2), 'utf8');

  const byTerritory = {};
  for (const i of out) {
    const t = i.territory || '未分类';
    byTerritory[t] = byTerritory[t] || { total: 0, usable: 0 };
    byTerritory[t].total++;
    if (i.status === 'reserve') byTerritory[t].usable++;
  }
  console.log(JSON.stringify({
    ok: true,
    total: out.length,
    usable: out.filter((i) => i.status === 'reserve').length,
    already: out.filter((i) => i.alreadyInLibrary).length,
    missing: out.filter((i) => !i.resolved).length,
    byTerritory,
    file: path.relative(WS, outFile),
  }, null, 2));
}

async function cmdRender(file) {
  const data = JSON.parse(await readFile(path.resolve(WS, file), 'utf8'));
  const A = data.items.filter((i) => i.bucket === 'A');
  const B = data.items.filter((i) => i.bucket === 'B');
  const L = [];
  L.push(`# 第 ${data.round} 轮推荐`, '');
  L.push(`> 依据「${MAIN_PLAYLIST}」最近添加的 120 首推断口味；A = 兴趣延伸，B = 拓宽审美。`);
  L.push(`> 目标歌单：${data.targetPlaylistName}`, '');
  L.push(`共 ${data.items.length} 首（A ${A.length} / B ${B.length}）。`, '');

  for (const [tag, list, desc] of [
    ['A · 兴趣延伸', A, '贴着你现在正在听的方向，应该会中。'],
    ['B · 拓宽审美', B, '每 2–3 首是一块新地盘，听个整体感受。'],
  ]) {
    L.push(`## ${tag}`, '', desc, '');
    L.push('| # | 歌名 | 歌手 | 专辑 | 为什么是它 |');
    L.push('|---|------|------|------|------------|');
    list.forEach((i, n) => {
      const q = i.qq || {};
      L.push(`| ${n + 1} | ${i.title}${i.alreadyInLibrary ? '（已有）' : ''} | ${i.artist} | ${q.album || i.album || ''} | ${i.why} |`);
    });
    L.push('');
  }

  L.push('## 听的时候可以顺手记', '');
  L.push('- 直接跟我说「第 3 首好听 / 第 7 首不行（太吵）」，我记到 `music/feedback.jsonl`');
  L.push('- 反馈会改变下一轮：喜欢的歌手的邻近作品加权，跳过的那类降权');
  L.push('');
  const md = L.join('\n');
  const outFile = path.resolve(WS, file).replace(/\.json$/, '.md');
  await writeFile(outFile, md, 'utf8');
  console.log(JSON.stringify({ ok: true, file: path.relative(WS, outFile) }));
}

async function findPlaylistId(page, name) {
  const raw = await page.evaluate(`JSON.stringify([...document.querySelectorAll('a[href*="/n/ryqq_v2/playlist/"]')]
    .map(a => [ (a.textContent || '').trim(), (a.getAttribute('href') || '').match(/playlist\\/(\\d+)/) ? RegExp.$1 : null ])
    .filter(([t, id]) => t && id))`);
  const rows = JSON.parse(raw);
  const hit = rows.find(([t]) => t === name);
  return hit ? hit[1] : null;
}

async function cmdPush(file, limitArg) {
  const abs = path.resolve(WS, file);
  const data = JSON.parse(await readFile(abs, 'utf8'));
  const targetName = data.targetPlaylistName;
  const limit = limitArg ? Number(limitArg) : Infinity;
  await preflight();
  const page = await connect({ port: PORT });

  const save = async () => writeFile(abs, JSON.stringify(data, null, 2), 'utf8');

  await page.navigate('https://y.qq.com/n/ryqq_v2/profile/create', { waitMs: 1500 });
  let id = await findPlaylistId(page, targetName);
  if (!id) {
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('a,button,div,span')].filter(e => e.offsetParent && (e.textContent || '').trim() === '新建歌单')[0];
      if (b) b.click();
      return Boolean(b);
    })()`);
    await sleep(900);
    await page.evaluate(`(() => {
      const input = document.querySelector('.yqq-dialog .form_txt__input');
      if (!input) return 'no input';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(targetName)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const ok = [...document.querySelectorAll('.yqq-dialog button, .yqq-dialog a')].filter(e => (e.textContent || '').trim() === '确定')[0];
      if (ok) ok.click();
      return 'ok';
    })()`);
    await sleep(2500);
    await page.navigate('https://y.qq.com/n/ryqq_v2/profile/create', { waitMs: 1800 });
    id = await findPlaylistId(page, targetName);
  }

  data.playlistId = id;
  data.pushedAt = new Date().toISOString();
  await save();
  if (!id) {
    console.log(JSON.stringify({ ok: false, error: '播放列表创建/定位失败', targetName }));
    await page.close();
    return;
  }

  let n = 0;
  for (const item of data.items) {
    if (n >= limit) break;
    if (!item.qq) { item.status = '未找到'; continue; }
    if (item.status === 'added') continue;
    const queries = [`${item.qq.name} ${item.qq.singers.split(' / ')[0]}`, item.qq.name];
    let res = 'row-not-found';
    for (const query of queries) {
      await page.navigate(`https://y.qq.com/n/ryqq_v2/search?w=${encodeURIComponent(query)}`, { waitMs: 1300 });
      res = await page.evaluate(`(() => {
      const norm = s => String(s || '').toLowerCase().replace(/[（(][^）)]*[）)]/g, '').replace(/[\\s·・,，.。'"“”‘’!！?？\\-—_/\\\\]/g, '');
      const wantTitle = norm(${JSON.stringify(item.qq.name)});
      const wantSinger = norm(${JSON.stringify(item.qq.singers.split(' / ')[0])});
      const rows = [...document.querySelectorAll('.songlist__item')];
      const row = rows.find(r => {
        const t = (r.querySelector('.songlist__songname_txt') || {}).textContent || '';
        const s = (r.querySelector('.songlist__artist') || {}).textContent || '';
        return norm(t) === wantTitle && norm(s).includes(wantSinger);
      });
      if (!row) return 'row-not-found';
      const add = row.querySelector('a.list_menu__add');
      if (!add) return 'no-add';
      add.click();
      return 'clicked';
    })()`);
      if (res === 'clicked') break;
    }
    if (res !== 'clicked') { item.status = '添加失败:' + res; await save(); continue; }

    await sleep(700);
    // 可能先出现行菜单，也可能是歌单列表；两次尝试都覆盖
    await page.evaluate(`(() => {
      if (document.querySelector('.mod_operate_menu')) return 'already';
      const it = [...document.querySelectorAll('.mod_list_menu .list_menu__add')].filter(e => e.offsetParent)[0];
      if (it) it.click();
      return it ? 'clicked-sub' : 'no-sub';
    })()`);
    await sleep(700);

    const picked = await page.evaluate(`(() => {
      const links = [...document.querySelectorAll('.mod_operate_menu a.operate_menu__link')];
      const hit = links.find(a => (a.textContent || '').trim() === ${JSON.stringify(targetName)});
      if (!hit) return 'playlist-not-listed';
      hit.click();
      return 'picked';
    })()`);
    await sleep(900);
    item.status = picked === 'picked' ? 'added' : '添加失败:' + picked;
    if (picked === 'picked') n++;
    await save();
    console.error(`[${item.status}] ${item.qq.name}`);
  }

  await page.close();
  const added = data.items.filter((i) => i.status === 'added').length;
  console.log(JSON.stringify({ ok: true, playlistId: data.playlistId, targetName, added, total: data.items.length }, null, 2));
}

async function cmdSet(file, id, spec, why) {
  const abs = path.resolve(WS, file);
  const data = JSON.parse(await readFile(abs, 'utf8'));
  const [title, artist, album] = String(spec).split('|').map((s) => (s || '').trim());
  const item = data.items.find((i) => i.id === id);
  if (!item) throw new Error('no item ' + id);

  const hit = await withPage(async (page) => {
    let results = await searchSongs(page, title, 12);
    let h = pickMatch(results, { title, artist, album });
    if (!h) {
      results = await searchSongs(page, `${title} ${artist}`, 12);
      h = pickMatch(results, { title, artist, album });
    }
    return h;
  });

  if (!hit) {
    console.log(JSON.stringify({ ok: false, error: '未找到 ' + title }));
    return;
  }
  Object.assign(item, {
    title,
    artist,
    album,
    why: why || item.why,
    qq: { mid: hit.mid, name: hit.name, singers: hit.singers, album: hit.album, interval: hit.interval },
    resolved: true,
    alreadyInLibrary: false,
    status: 'pending',
  });
  await writeFile(abs, JSON.stringify(data, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, id, qq: item.qq, status: item.status }, null, 2));
}

async function cmdInfer() {
  // 用户说会把喜欢的歌「加进新建歌单2」——那就把这种可观察的动作当成反馈，而不是等他打字。
  const all = JSON.parse(await readFile(path.join(WS, 'tools/qqmusic/out/playlists-all.json'), 'utf8'));
  const main = all.find((p) => p.title === MAIN_PLAYLIST);
  if (!main) throw new Error('找不到歌单 ' + MAIN_PLAYLIST);
  const mainMids = new Set(main.songs.map((s) => s.mid).filter(Boolean));

  const roundsDir = path.join(WS, 'music/rounds');
  const files = (await readdir(roundsDir)).filter((f) => /^round-\d+\.json$/.test(f)).sort();

  let existing = new Set();
  try {
    const raw = await readFile(path.join(WS, 'music/feedback.jsonl'), 'utf8');
    existing = new Set(raw.trim().split('\n').filter(Boolean).map((l) => {
      const e = JSON.parse(l);
      return `${e.round}|${e.songId}|${e.verdict}`;
    }));
  } catch { /* 还没有反馈文件 */ }

  const fresh = [];
  for (const f of files) {
    const round = JSON.parse(await readFile(path.join(roundsDir, f), 'utf8'));
    for (const item of round.items || []) {
      const mid = item.qq?.mid;
      if (!mid || !mainMids.has(mid)) continue;
      const key = `${round.round}|${item.id}|adopted`;
      if (existing.has(key)) continue;
      existing.add(key);
      fresh.push({
        at: new Date().toISOString(),
        round: round.round,
        songId: item.id,
        title: item.title,
        verdict: 'adopted',
        inferred: true,
        note: '已出现在主歌单里（用户自己加进去的）',
      });
    }
  }

  if (fresh.length) {
    await appendFile(path.join(WS, 'music/feedback.jsonl'), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
  console.log(JSON.stringify({ ok: true, roundsChecked: files.length, adopted: fresh.length, added: fresh.map((e) => `R${e.round} ${e.songId} ${e.title}`) }, null, 2));
}

async function cmdDiff() {
  // 新建歌单2 的增量：用户又加了什么（A 组推荐应该跟着这个走）。
  const all = JSON.parse(await readFile(path.join(WS, 'tools/qqmusic/out/playlists-all.json'), 'utf8'));
  const main = all.find((p) => p.title === MAIN_PLAYLIST);
  if (!main) throw new Error('找不到歌单 ' + MAIN_PLAYLIST);
  const snapFile = path.join(WS, 'music/snapshot.json');

  let prev = null;
  try {
    prev = JSON.parse(await readFile(snapFile, 'utf8'));
  } catch { /* 首次运行，建立基线 */ }

  const now = main.songs.map((s) => ({ mid: s.mid, name: s.name, singers: s.singers }));
  const prevMids = new Set((prev?.songs || []).map((s) => s.mid).filter(Boolean));

  const added = prev ? now.filter((s) => s.mid && !prevMids.has(s.mid)) : [];
  await writeFile(snapFile, JSON.stringify({ takenAt: new Date().toISOString(), total: now.length, songs: now }, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    baseline: !prev,
    totalSongs: now.length,
    previousTotal: prev ? prev.songs.length : null,
    addedSinceLast: added.length,
    added: added.slice(0, 40),
  }, null, 2));
}

async function cmdFeedback(roundId, songId, verdict, ...note) {
  const entry = {
    at: new Date().toISOString(),
    round: Number(roundId),
    songId,
    verdict,
    note: note.join(' '),
  };
  await mkdir(path.join(WS, 'music'), { recursive: true });
  await appendFile(path.join(WS, 'music/feedback.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: true, entry }));
}

async function cmdStatus() {
  const { readdir } = await import('node:fs/promises');
  const roundsDir = path.join(WS, 'music/rounds');
  let rounds = [];
  try { rounds = (await readdir(roundsDir)).filter((f) => f.endsWith('.json')).sort(); } catch {}
  let fb = 0;
  try {
    fb = (await readFile(path.join(WS, 'music/feedback.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).length;
  } catch {}
  console.log(JSON.stringify({ rounds, feedbackEntries: fb }, null, 2));
}

const handlers = {
  verify: cmdVerify,
  reserve: cmdReserve,
  render: cmdRender,
  push: cmdPush,
  set: cmdSet,
  infer: cmdInfer,
  diff: cmdDiff,
  doctor: cmdDoctor,
  feedback: cmdFeedback,
  status: cmdStatus,
};
if (!handlers[cmd]) {
  console.error('usage: verify|reserve|render|push|set|infer|diff|doctor|feedback|status');
  process.exit(1);
}
try {
  await handlers[cmd](...args);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
  process.exit(1);
}
