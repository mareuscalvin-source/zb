import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('.');
const types = { '.html':'text/html', '.js':'text/javascript', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const srv = http.createServer((req,res)=>{ const u = decodeURIComponent(new URL(req.url,'http://x').pathname); let f = path.join(root,u); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f,'index.html'); if(!fs.existsSync(f)){res.writeHead(404);return res.end();} res.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);}).listen(0);
const port = srv.address().port;
const SP = process.argv[2];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
async function run(url, vp, name, steps) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 2, hasTouch: vp.width < 500 });
  const errs = []; page.on('pageerror', e => errs.push('pageerror: ' + e)); page.on('console', m => { if (m.type() === 'error' && !/404|fonts/.test(m.text())) errs.push(m.text()); });
  await page.goto(`http://localhost:${port}/${url}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SP}/${name}-0.png` });
  await steps(page);
  console.log(name, errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no errors');
  await page.close();
}
await run('dev/mock-artifact.html', { width: 390, height: 844 }, 'cloud-phone', async (page) => {
  await page.click('#wake');
  await page.waitForTimeout(700);
  await page.fill('#msg', 'Remember I like testing new gadgets and start a tea timer');
  await page.press('#msg', 'Enter');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${process.argv[2]}/cloud-phone-1.png` });
  const info = await page.evaluate(() => ({
    log: [...document.querySelectorAll('#log .line .txt')].map(e => e.textContent),
    mem: document.getElementById('roMem').textContent,
    link: document.getElementById('roLink').textContent,
    timers: document.getElementById('timers').textContent,
    status: document.getElementById('statusText').textContent,
    turns: window.__lastInput.length, first: window.__lastInput[0].content.slice(0, 160), last: window.__lastInput.at(-1),
    opts: window.__lastOpts, db: Object.keys(window.__db || {}), chat: (window.__db || {})['data/users/u_test/chat'],
    mood: document.querySelector('#status').dataset.state,
  }));
  console.log(JSON.stringify(info, null, 1));
  await page.click('#btnSettings');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.argv[2]}/cloud-phone-2.png` });
});
await run('dev/mock-artifact.html', { width: 1280, height: 800 }, 'cloud-desk', async (page) => {
  await page.click('#wake');
  await page.waitForTimeout(500);
  await page.mouse.move(900, 200);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${process.argv[2]}/cloud-desk-1.png` });
});
await run('docs/index.html', { width: 390, height: 844 }, 'web-phone', async (page) => {
  await page.click('#wake');
  await page.waitForTimeout(600);
  await page.fill('#msg', 'hello');
  await page.press('#msg', 'Enter');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${process.argv[2]}/web-phone-1.png` });
  console.log(await page.evaluate(() => [...document.querySelectorAll('#log .line .txt')].map(e => e.textContent)));
});
await browser.close(); srv.close();
