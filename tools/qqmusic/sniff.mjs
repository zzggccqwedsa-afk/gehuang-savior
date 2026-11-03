// Capture the network calls a page makes, to learn the private web API shapes.
//   node sniff.mjs <url> [seconds] [filterRegex]
import { connect, sleep } from './cdp.mjs';

const url = process.argv[2] || 'https://y.qq.com/';
const seconds = Number(process.argv[3] || 8);
const filter = new RegExp(process.argv[4] || 'fcg|musicu|api', 'i');

const s = await connect({ port: Number(process.env.QM_CDP_PORT || 9222) });
await s.send('Network.enable', {});

const hits = [];
s.on('Network.requestWillBeSent', (p) => {
  if (!filter.test(p.request.url)) return;
  hits.push({
    method: p.request.method,
    url: p.request.url,
    postData: p.request.postData || null,
    type: p.type,
  });
});

await s.navigate(url, { waitMs: seconds * 1000 });
await sleep(1000);

const seen = new Set();
const unique = hits.filter((h) => {
  const k = h.method + h.url.slice(0, 300) + (h.postData || '').slice(0, 300);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
console.log(JSON.stringify(unique, null, 2));
await s.close();
