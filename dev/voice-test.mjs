// ZB's own voice end to end: auto-download on a computer, cache, start, speak, and the Miami/Kreyòl front end.
import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const OUT = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.wasm': 'application/wasm' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = u === '/' ? 'dev/mock-artifact.html' : path.join('dist', u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push('pageerror: ' + e.stack)); page.on('console', (m) => { if (m.type() === 'error' && !/fonts|404/.test(m.text())) errs.push(m.text()); });
await page.addInitScript(() => {
  window.__played = { buffers: 0, device: 0 };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) { if (this.buffer && this.buffer.duration > 0.3) window.__played.buffers++; return start.apply(this, a); };
  const speak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = (u) => { if (u.text.trim()) window.__played.device++; return speak(u); };
});
const t0 = Date.now();
await page.goto(`http://localhost:${srv.address().port}/`);
await page.waitForFunction(() => /ready/i.test(document.getElementById('toast').textContent), null, { timeout: 240000 });
console.log('downloaded + started in', ((Date.now() - t0) / 1000).toFixed(1), 's');
// speak through a fresh worker using the cached pack, and time it
const r = await page.evaluate(async () => {
  const get = (k) => new Promise((res) => { const o = indexedDB.open('zb-voice'); o.onsuccess = () => { const q = o.result.transaction('files').objectStore('files').get(k); q.onsuccess = () => res(q.result); }; });
  const [manifest, half, wasm] = [await get('manifest'), await get('half'), await get('wasm')];
  const w = new Worker('lib/voice-worker.js');
  const t = performance.now();
  await new Promise((res, rej) => { w.onmessage = (e) => (e.data.type === 'ready' ? res() : rej(e.data.message)); w.postMessage({ type: 'init', manifest, half, wasm }, [half.buffer, wasm]); });
  const init = performance.now() - t;
  const say = (id, text, accent = 2) => new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage({ type: 'say', id, text, speaker: 52, accent, rate: 1.05 }); });
  const out = [];
  for (const [i, text] of ["Yo boss, I got your lease saved in the Vault, so whenever you need it, just ask, ya feel me.", 'Sak pase? Nap boule, e ou menm?', "Rent's $1,850 starting November 1, 2026, ngl that's a lot fr."].entries()) {
    const s = performance.now(); const m = await say(i + 1, text);
    const pcm = m.pcm; let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    out.push({ text: text.slice(0, 30), secs: +(pcm.length / m.sampleRate).toFixed(2), ms: Math.round(performance.now() - s), peak: +peak.toFixed(2), wav: Array.from(new Uint8Array(pcm.buffer)).length });
    if (i === 0) window.__first = pcm;
  }
  return { init: Math.round(init), out };
});
console.log(JSON.stringify(r, null, 1));
// save the first clip so it can be listened to
const b64 = await page.evaluate(() => { const p = window.__first; const n = p.length; const buf = new DataView(new ArrayBuffer(44 + n * 2)); const w = (o, s) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, 22050, true); buf.setUint32(28, 44100, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); w(36, 'data'); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, p[i])) * 32767, true);
  let s = ''; const u = new Uint8Array(buf.buffer); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
fs.writeFileSync(`${OUT}/zb-browser-voice.wav`, Buffer.from(b64, 'base64'));
// the app itself: wake ZB and check he talks with his own voice (the dock chip is gone, nothing fell back)
await page.click('#wake'); await page.waitForTimeout(6000);
const app = await page.evaluate(() => ({ played: window.__played, chip: document.getElementById('voiceChip').hidden, toast: document.getElementById('toast').textContent, log: [...document.querySelectorAll('#log .txt')].map((e) => e.textContent).slice(-1) }));
console.log('APP', JSON.stringify(app));
// settings show the voice as ready
await page.click('#btnSettings'); await page.waitForTimeout(300);
console.log('SETTINGS', JSON.stringify(await page.evaluate(() => ({ engine: document.getElementById('setEngine').value, status: document.getElementById('zbStatus').textContent, speaker: document.getElementById('zbSpeaker').value, accent: document.getElementById('zbAccent').value, zbHidden: document.getElementById('zbVoice').hidden }))));
await page.evaluate(() => document.getElementById('zbVoice').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/voice-settings.png` });
// stepping to another voice previews it with ZB's engine
const before = await page.evaluate(() => window.__played.buffers);
await page.click('#zbNext'); await page.waitForTimeout(3500);
console.log('NEXT', JSON.stringify(await page.evaluate((b) => ({ speaker: document.getElementById('zbSpeaker').value, previewed: window.__played.buffers > b, device: window.__played.device }), before)));
console.log('ERRORS:', errs.length ? errs.join('\n') : 'none');
await browser.close(); srv.close();
