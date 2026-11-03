// Offline check: are these songs already in the user's library?
//   node libcheck.mjs <file-with-lines "标题||歌手">
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s·・,，.。'"“”‘’!！?？\-—_/\\]/g, '');

const file = process.argv[2];
const lines = (await readFile(file, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean);

const all = JSON.parse(await readFile(path.resolve('tools/qqmusic/out/playlists-all.json'), 'utf8'));
const byTitle = new Map();
for (const pl of all) {
  for (const s of pl.songs) {
    const t = norm(s.name);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push({ singers: s.singers, pl: pl.title });
  }
}

let dup = 0;
for (const line of lines) {
  const [title, artist] = line.split('||').map((x) => (x || '').trim());
  const hits = byTitle.get(norm(title)) || [];
  const exact = hits.find((h) => norm(h.singers).includes(norm(artist).split(' ')[0]));
  const any = hits[0];
  if (exact || any) {
    dup++;
    console.log(`HAS  ${title} — ${artist}  ←  ${(exact || any).singers} @ ${(exact || any).pl}`);
  } else {
    console.log(`new  ${title} — ${artist}`);
  }
}
console.log(`\n${lines.length} checked, ${dup} already in library`);
