import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('.'); const OUT = process.argv[2];
const types = { '.html':'text/html', '.js':'text/javascript', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const srv = http.createServer((req,res)=>{ const u = decodeURIComponent(new URL(req.url,'http://x').pathname); let f = path.join(root,u); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f,'index.html'); if(!fs.existsSync(f)){res.writeHead(404);return res.end();} res.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push('pageerror: ' + e.stack)); page.on('console', m => { if (m.type() === 'error' && !/404|fonts/.test(m.text())) errs.push(m.text()); });
await page.goto(`http://localhost:${port}/dev/mock-artifact.html`);
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/i-0.png` });
await page.click('#wake'); await page.waitForTimeout(500);
await page.fill('#msg', 'yo remember my cousin name is Wesley and set a tea timer real quick'); await page.press('#msg', 'Enter');
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/i-1.png` });
const info = await page.evaluate(() => ({
  log: [...document.querySelectorAll('#log .line .txt')].map(e => e.textContent),
  mark: document.getElementById('mark').textContent, look: document.getElementById('app').dataset.look,
  mirrorDoc: (window.__db||{})['data/users/u_test/mirror'] ? (window.__db['data/users/u_test/mirror'].samples||[]).map(s=>s.src+':'+s.t.slice(0,40)) : null,
  sysHas: { mirror: window.__lastInput[0].content.includes('You are their mirror') || window.__lastInput[0].content.includes('mirror'), twin: window.__lastInput[0].content.includes('AI twin') },
  sysLen: window.__lastInput[0].content.length,
}));
console.log(JSON.stringify(info, null, 1));
await page.click('#btnSettings'); await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/i-2.png`, fullPage: false });
await page.evaluate(() => document.querySelector('#setPalette .swatch:nth-child(2)').click()); await page.waitForTimeout(300);
await page.selectOption('#setLook', 'face'); await page.waitForTimeout(400);
const look1 = await page.evaluate(() => ({ look: document.getElementById('app').dataset.look, faceHidden: document.getElementById('faceCanvas').hidden, orbHidden: document.getElementById('orbCanvas').hidden, palette: (window.__db||{})['data/users/u_test/profile']?.palette }));
await page.click('#btnClose'); await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/i-3-face.png` });
await page.click('#btnSettings'); await page.selectOption('#setLook', 'orb'); await page.click('#btnClose'); await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/i-4-orb-lakay.png` });
console.log(JSON.stringify(look1), 'ERRORS:', errs.length ? errs.join('\n') : 'none');
await browser.close(); srv.close();
