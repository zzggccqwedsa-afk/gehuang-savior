// 生成 music/profile.json：口味快照，供后续轮次复用（不必每次重算）。
//   node build-profile.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.resolve(HERE, '../..');
const MAIN_PLAYLIST = process.env.QM_MAIN_PLAYLIST || '新建歌单2';

const all = JSON.parse(await readFile(path.join(WS, 'tools/qqmusic/out/playlists-all.json'), 'utf8'));
const main = all.find((p) => p.title === MAIN_PLAYLIST);
const RECENT = 120;

const lang = (s) => (/[\u4e00-\u9fa5]/.test(s) ? 'zh' : /[\u3040-\u30ff]/.test(s) ? 'ja' : 'other');

const tally = (songs, pick) => {
  const m = new Map();
  for (const s of songs) for (const k of pick(s)) m.set(k, (m.get(k) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

const recent = main.songs.slice(0, RECENT);
const older = main.songs.slice(RECENT);

const profile = {
  generatedAt: new Date().toISOString(),
  account: main.host_nick || null,
  playlists: all.map((p) => ({ title: p.title, kind: p.kind, count: p.songs.length })),
  main: {
    playlist: main.title,
    total: main.songs.length,
    orderAssumption: '列表第 1 首 = 最近添加，最后 = 最早添加（跨度约十年）',
    recentWindow: RECENT,
  },
  recentTopArtists: tally(recent, (s) => s.singers.split(' / ')).slice(0, 25),
  allTopArtists: tally(main.songs, (s) => s.singers.split(' / ')).slice(0, 30),
  recentLanguageMix: tally(recent, (s) => [lang(s.name)]),
  olderLanguageMix: tally(older, (s) => [lang(s.name)]),
  observations: [],
};

await writeFile(path.join(WS, 'music/profile.json'), JSON.stringify(profile, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, recentTop: profile.recentTopArtists.slice(0, 8) }, null, 2));
