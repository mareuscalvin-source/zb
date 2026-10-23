// Interrupting a reply keeps the partial; file notes wait for a quiet moment instead of cutting ZB off.
import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('.'); const FILES = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript' };
const srv = http.createServer((req, res) => { const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push('pageerror: ' + e.stack));
await page.goto(`http://localhost:${srv.address().port}/dev/mock-artifact.html`);
await page.waitForTimeout(1500);
await page.click('#wake'); await page.waitForTimeout(300);
await page.fill('#msg', 'first question'); await page.press('#msg', 'Enter');
await page.waitForTimeout(450); // mid-stream
await page.fill('#msg', 'actually never mind, second question'); await page.press('#msg', 'Enter');
await page.waitForTimeout(250);
// a file lands while ZB is still answering: its note must wait
await page.click('#btnVault'); await page.setInputFiles('#vaultIn', path.join(FILES, 'notes.txt')); await page.click('#vaultClose');
const mid = await page.evaluate(() => window.__lastInput.at(-1).content);
await page.waitForTimeout(9000);
const r = await page.evaluate(() => ({
  turns: (window.__db['data/users/u_test/chat'] || {}).turns.map((t) => t.r + ':' + t.t.slice(0, 70)),
  last: window.__lastInput.at(-1).content.slice(0, 120),
  pending: document.querySelectorAll('#log .line.pending').length,
}));
console.log('MID', mid.slice(0, 80));
console.log(JSON.stringify(r, null, 1));
const ok = r.turns[0] === 'u:first question' && /…$/.test(r.turns[1]) && r.turns[2] === 'u:actually never mind, second question' && r.turns.some((t) => t.startsWith('u:(added notes.txt')) && !/Note from the app/.test(mid) && r.pending === 0;
console.log(ok ? 'RACE OK' : 'RACE FAIL', 'ERRORS:', errs.length ? errs.join('\n') : 'none');
await browser.close(); srv.close();
