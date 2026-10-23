import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(process.argv[2] || '.');
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const srv = http.createServer((req,res)=>{ const u = decodeURIComponent(new URL(req.url,'http://x').pathname); let f = path.join(root,u); if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f,'index.html'); if(!fs.existsSync(f)){res.writeHead(404);return res.end();} res.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);}).listen(0);
const port = srv.address().port;
const shots = JSON.parse(process.argv[3]);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: s.w||600, height: s.h||700 }, deviceScaleFactor: s.dpr||1 });
  const errs=[]; page.on('pageerror', e=>errs.push(String(e))); page.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
  await page.goto(`http://localhost:${port}/${s.url}`);
  await page.waitForTimeout(s.wait||1500);
  if (s.eval) await page.evaluate(s.eval);
  if (s.after) await page.waitForTimeout(s.after);
  await page.screenshot({ path: s.out });
  if (errs.length) console.log(s.out, 'ERRORS:', errs.join('\n'));
  await page.close();
}
await browser.close(); srv.close();
