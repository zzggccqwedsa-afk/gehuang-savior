// Search QQ Music and print "歌名 | 歌手 | 专辑" lines (for manual verification/picking).
//   node search.mjs "落日飞车" [n]
import { connect } from './cdp.mjs';

const query = process.argv[2] || '';
const n = Number(process.argv[3] || 10);

const s = await connect({ port: Number(process.env.QM_CDP_PORT || 9222) });
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
  .then(j => JSON.stringify(((((j || {}).req_0 || {}).data || {}).body || {}).song.list.map(s => [s.name, (s.singer || []).map(x => x.name).join(' / '), (s.album || {}).name || ''])))`;
const rows = JSON.parse(await s.evaluate(expr));
rows.forEach(([name, singer, album]) => console.log(`${name} | ${singer} | ${album}`));
await s.close();
