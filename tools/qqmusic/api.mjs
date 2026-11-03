// Call QQ Music web APIs from inside the logged-in page (cookies included).
//   node api.mjs <module> <method> [key=value ...]
//   node api.mjs --raw <full-url>
import { connect } from './cdp.mjs';

const [moduleName, method, ...rest] = process.argv.slice(2);

const s = await connect({ port: Number(process.env.QM_CDP_PORT || 9222) });

if (moduleName === '--raw') {
  const url = method;
  const out = await s.evaluate(`fetch(${JSON.stringify(url)}, {credentials:'include'}).then(r=>r.text())`);
  console.log(out.slice(0, 20000));
} else {
  const param = {};
  for (const pair of rest) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i);
    const raw = pair.slice(i + 1);
    param[k] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
  const payload = {
    req_0: { module: moduleName, method, param },
    comm: { ct: 24, cv: 0, uin: '0' },
  };
  const expr = `(() => {
    const data = ${JSON.stringify(JSON.stringify(payload))};
    return fetch('https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(data), { credentials: 'include' })
      .then(r => r.text());
  })()`;
  const text = await s.evaluate(expr);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 40000));
  } catch {
    console.log(text.slice(0, 4000));
  }
}

await s.close();
