// Fetch every playlist of the logged-in account via the legacy musicu API,
// then write JSON + Markdown into ./out/.
//   node fetch-all.mjs
import { connect, sleep } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const PORT = Number(process.env.QM_CDP_PORT || 9222);
const PAGE = 100;

// created (我创建的歌单) + collected (收藏的歌单)
// 歌单从个人主页自动发现，仓库里不内置任何人的歌单 ID。
const FALLBACK_PLAYLISTS = [];

const s = await connect({ port: PORT });

async function discoverPlaylists() {
  const pages = [
    ['https://y.qq.com/n/ryqq_v2/profile/create', '我创建的歌单'],
    ['https://y.qq.com/n/ryqq_v2/profile/like/playlist', '收藏的歌单'],
  ];
  const seen = new Map();
  for (const [url, kind] of pages) {
    try {
      await s.navigate(url, { waitMs: 1600 });
      const raw = await s.evaluate(`JSON.stringify([...document.querySelectorAll('a[href*="/n/ryqq_v2/playlist/"]')]
        .map(a => [ (a.textContent || '').trim(), ((a.getAttribute('href') || '').match(/playlist\\/(\\d+)/) || [])[1] ])
        .filter(([t, id]) => t && id && t.length < 60))`);
      for (const [title, id] of JSON.parse(raw)) {
        if (!seen.has(id)) seen.set(id, { id, title, kind });
      }
    } catch (e) {
      console.error(`[warn] 发现${kind}失败: ${e.message}`);
    }
  }
  return [...seen.values()];
}

let PLAYLISTS = await discoverPlaylists();
if (PLAYLISTS.length < 2) {
  throw new Error('自动发现歌单失败：请确认已登录 QQ 音乐、个人主页可访问');
  PLAYLISTS = FALLBACK_PLAYLISTS;
} else {
  console.error(`[ok] 发现 ${PLAYLISTS.length} 个歌单: ${PLAYLISTS.map((p) => p.title).join(' / ')}`);
}

function pageExpr(disstid, begin, num) {
  const payload = {
    comm: { ct: 24, cv: 0 },
    req_0: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: {
        disstid: Number(disstid),
        enc_host_uin: '',
        tag: 1,
        userinfo: 1,
        song_begin: begin,
        song_num: num,
        onlysonglist: 1,
      },
    },
  };
  return `fetch('https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(${JSON.stringify(JSON.stringify(payload))}), {credentials:'include'})
    .then(r => r.json())
    .then(j => {
      const d = j.req_0 && j.req_0.data;
      if (!d) return JSON.stringify({error: 'no data', raw: j});
      const songs = (d.songlist || []).map(s => ({
        name: s.name || s.title || '',
        singers: (s.singer || []).map(x => x.name).filter(Boolean).join(' / '),
        album: (s.album && (s.album.name || s.album.title)) || '',
        mid: s.mid || '',
        interval: s.interval || 0,
      }));
      return JSON.stringify({ songnum: d.dirinfo ? d.dirinfo.songnum : null, title: d.dirinfo ? d.dirinfo.title : null, host_nick: d.dirinfo ? d.dirinfo.host_nick : null, listennum: d.dirinfo ? d.dirinfo.listennum : null, ctime: d.dirinfo ? d.dirinfo.ctime : null, mtime: d.dirinfo ? d.dirinfo.mtime : null, songs });
    })`;
}

const result = [];
for (const pl of PLAYLISTS) {
  const entry = { ...pl, songs: [], songnum: null, listennum: null };
  let begin = 0;
  for (let guard = 0; guard < 40; guard++) {
    const raw = await s.evaluate(pageExpr(pl.id, begin, PAGE), { timeoutMs: 45000 });
    const page = JSON.parse(raw);
    if (page.error) { entry.error = page.error; break; }
    entry.songnum = page.songnum;
    entry.listennum = page.listennum;
    entry.host_nick = page.host_nick;
    entry.ctime = page.ctime;
    entry.mtime = page.mtime;
    if (page.title) entry.title = page.title;
    entry.songs.push(...page.songs);
    const total = page.songnum ?? entry.songs.length;
    if (entry.songs.length >= total || page.songs.length === 0) break;
    begin += PAGE;
    await sleep(250);
  }
  console.error(`[ok] ${entry.title}: ${entry.songs.length}/${entry.songnum}`);
  result.push(entry);
}

let nick = result.find((p) => p.host_nick)?.host_nick || '';
if (!nick) {
  try {
    result.forEach((p) => { p.host_nick = undefined; });
    await s.navigate('https://y.qq.com/n/ryqq_v2/profile', { waitMs: 1800 });
    nick = (await s.evaluate(`(document.querySelector('.profile__name')?.textContent || '').trim()`)) || '';
  } catch { /* keep empty */ }
}
result.forEach((p) => { p.host_nick = nick; });

await s.close();

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'playlists-all.json'), JSON.stringify(result, null, 2), 'utf8');

const esc = (t) => String(t ?? '').replace(/\|/g, '\\|');
const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const totalSongs = result.reduce((a, p) => a + p.songs.length, 0);

const lines = [];
lines.push('# QQ 音乐歌单导出', '');
lines.push(`- 账号昵称：${nick}`);
lines.push(`- 歌单数量：${result.length}`);
lines.push(`- 曲目合计：${totalSongs} 首`);
lines.push(`- 导出时间：${now}`);
lines.push('');
lines.push('| # | 歌单 | 类型 | 曲目数 |');
lines.push('|---|------|------|--------|');
result.forEach((p, i) => {
  lines.push(`| ${i + 1} | ${esc(p.title)} | ${p.kind} | ${p.songs.length} |`);
});

// 出现次数最多的歌手（同一首歌在多歌单中只计一次）
const artistCount = new Map();
const seenMids = new Set();
for (const p of result) {
  for (const song of p.songs) {
    if (song.mid && seenMids.has(song.mid)) continue;
    if (song.mid) seenMids.add(song.mid);
    for (const a of song.singers.split(' / ').filter(Boolean)) {
      artistCount.set(a, (artistCount.get(a) || 0) + 1);
    }
  }
}
const topArtists = [...artistCount].sort((a, b) => b[1] - a[1]).slice(0, 15);
lines.push('', `## 歌手分布 Top 15`, '');
lines.push('| 歌手 | 曲目数 |', '|------|--------|');
topArtists.forEach(([a, n]) => lines.push(`| ${esc(a)} | ${n} |`));

for (const p of result) {
  lines.push('', `## ${p.title}`, '');
  lines.push(`${p.kind}，共 ${p.songs.length} 首。`, '');
  p.songs.forEach((song, i) => {
    lines.push(`${i + 1}. ${song.name} — ${song.singers}${song.album ? `（${song.album}）` : ''}`);
  });
}
await writeFile(path.join(OUT, '歌单合集.md'), lines.join('\n'), 'utf8');

console.log(JSON.stringify({
  ok: true,
  playlists: result.map((p) => ({ title: p.title, kind: p.kind, count: p.songs.length, songnum: p.songnum })),
  totalSongs: result.reduce((a, p) => a + p.songs.length, 0),
}, null, 2));
