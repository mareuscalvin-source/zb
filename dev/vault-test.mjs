import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('.'); const OUT = process.argv[2]; const FILES = process.argv[3];
const types = { '.html':'text/html', '.js':'text/javascript', '.png':'image/png' };
const srv = http.createServer((req,res)=>{ const u = decodeURIComponent(new URL(req.url,'http://x').pathname); let f = path.join(root,u); if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end();} res.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);}).listen(0);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const errs = []; page.on('pageerror', e => errs.push('pageerror: ' + e.stack)); page.on('console', m => { if (m.type() === 'error' && !/404|fonts/.test(m.text())) errs.push(m.text()); });
await page.goto(`http://localhost:${srv.address().port}/dev/mock-artifact.html`);
await page.waitForTimeout(1500);
await page.click('#wake'); await page.waitForTimeout(400);
// 1) attach a docx with nothing typed: it gets filed and ZB announces it
await page.setInputFiles('#attachIn', path.join(FILES, 'lease.docx'));
await page.waitForTimeout(3500);
const a = await page.evaluate(() => ({
  vault: Object.keys(window.__db).filter(k => k.startsWith('data/users/u_test/vault/items/')).map(k => window.__db[k]), text: window.__db[Object.keys(window.__db).find(k => k.includes('/vault/text/'))],
  lastMsg: window.__lastInput.at(-1).content, sysHasFile: window.__lastInput[0].content.includes('Lease Agreement'), sysHasText: window.__lastInput[0].content.includes('Tenant: Wesley Pierre'),
  log: [...document.querySelectorAll('#log .line .txt')].map(e => e.textContent).slice(-2), presence: window.__presence, link: document.getElementById('roLink').textContent,
}));
console.log('ATTACH', JSON.stringify(a, null, 1));
// 2) PDF through the Vault panel with a typed question afterwards
await page.click('#btnVault'); await page.waitForTimeout(300);
await page.setInputFiles('#vaultIn', path.join(FILES, 'card.pdf'));
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/v-panel.png` });
const b = await page.evaluate(() => ({ items: Object.keys(window.__db).filter(k => k.startsWith('data/users/u_test/vault/items/')).map(k => window.__db[k]).map(i => [i.name, i.kind, i.note, !!i.assetId, i.chars]), json: window.__lastJson.input.slice(0, 400), assets: Object.values(window.__assets) }));
console.log('PDF', JSON.stringify(b, null, 1));
await page.click('#vaultClose');
await page.fill('#msg', 'what was the deductible on my insurance card'); await page.press('#msg', 'Enter');
await page.waitForTimeout(6000);
const c = await page.evaluate(() => ({ sysHasPdfText: window.__lastInput[0].content.includes('Deductible $500'), turns: (window.__db['data/users/u_test/chat'] || {}).turns.map(t => t.r + ':' + t.t.slice(0, 60)) }));
console.log('ASK', JSON.stringify(c, null, 1));
await page.screenshot({ path: `${OUT}/v-chat.png` });
// 3) forget the lease
await page.click('#btnVault'); await page.waitForTimeout(200);
const before = await page.evaluate(() => Object.keys(window.__assets).length);
await page.locator('.vault-item').filter({ hasText: 'lease.docx' }).getByRole('button', { name: 'Forget' }).click();
await page.locator('.vault-item').filter({ hasText: 'lease.docx' }).getByRole('button', { name: 'Tap again to forget' }).click();
await page.waitForTimeout(500);
console.log('FORGET', JSON.stringify(await page.evaluate(() => ({ items: Object.keys(window.__db).filter(k => k.startsWith('data/users/u_test/vault/items/')).map(k => window.__db[k]).map(i => i.name), textDocs: Object.keys(window.__db).filter(k => k.includes('/vault/text/')).length }))), 'assets before', before);
console.log('ERRORS:', errs.length ? errs.join('\n') : 'none');
await browser.close(); srv.close();
