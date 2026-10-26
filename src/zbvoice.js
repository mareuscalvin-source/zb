// ZB's own voice: downloaded once per device, kept in IndexedDB, and run in a worker.
// The page can only host web file types, so the model travels as base64 text parts (see dev/voice-pack.py).

/* global __ZB_VOICE_VERSION__ */
const VERSION = typeof __ZB_VOICE_VERSION__ === 'string' ? __ZB_VOICE_VERSION__ : 'dev';
const DB = 'zb-voice';
const STORE = 'files';
export const ZB_DEFAULT_SPEAKER = 52;
export const ZB_SPEAKERS = 904;
export const VOICE_DOWNLOAD_MB = 58;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req && req.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error || new Error('Storage failed'));
      };
    };
  });
}

function fromBase64(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchBytes(url, onBytes, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Couldn’t download the voice (${res.status})`);
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    onBytes(b.length);
    return b;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export class ZbVoice {
  constructor() {
    this.state = 'unknown'; // unknown | missing | downloading | loading | ready | failed | unsupported
    this.progress = 0;
    this.message = '';
    this.listeners = new Set();
    this.worker = null;
    this.nextId = 1;
    this.waiting = new Map();
    this.ctl = null;
    if (!(window.Worker && window.indexedDB && window.WebAssembly && window.DecompressionStream)) this._set('unsupported');
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _set(state, extra = {}) {
    Object.assign(this, { state, ...extra });
    for (const fn of this.listeners) fn(this);
  }

  // Is the current version saved on this device?
  async check() {
    if (this.state === 'unsupported') return false;
    try {
      const meta = await idb('readonly', (s) => s.get('meta'));
      const have = meta && meta.version === VERSION;
      if (this.state === 'unknown') this._set(have ? 'loading' : 'missing');
      return have;
    } catch (e) {
      this._set('missing');
      return false;
    }
  }

  async download() {
    if (this.state === 'downloading' || this.state === 'unsupported') return;
    this.ctl = new AbortController();
    const signal = this.ctl.signal;
    this._set('downloading', { progress: 0, message: '' });
    try {
      const manifest = await (await fetch('voice/zb-voice.json', { signal })).json();
      const total = Math.ceil(manifest.gzipBytes / 3) * 4 + 11.3e6;
      let got = 0;
      const tick = (n) => {
        got += n;
        const p = Math.min(0.99, got / total);
        if (p - this.progress > 0.005) this._set('downloading', { progress: p });
      };
      const wasm = await fetchBytes('lib/ort-wasm-simd-threaded.wasm', tick, signal);
      const gz = [];
      for (const part of manifest.parts) {
        const text = new TextDecoder().decode(await fetchBytes(`voice/${part}`, tick, signal));
        gz.push(fromBase64(text.trim()));
      }
      const stream = new Blob(gz).stream().pipeThrough(new DecompressionStream('gzip'));
      let half = new Uint8Array(await new Response(stream).arrayBuffer());
      gz.length = 0;
      if (half.length !== manifest.halfBytes) throw new Error('The voice download was incomplete. Try again.');
      if (manifest.version !== VERSION && VERSION !== 'dev') throw new Error('The voice on this page is updating. Reload and try again.');
      await idb('readwrite', (s) => {
        s.put(manifest, 'manifest');
        s.put(half, 'half');
        s.put(wasm.buffer, 'wasm');
        return s.put({ version: manifest.version, at: Date.now() }, 'meta');
      });
      half = null; // start() reads its own copy; on phones two copies of the voice at once is a lot of memory
      this._set('loading', { progress: 1 });
      await this.start();
    } catch (e) {
      if (signal.aborted) this._set('missing', { progress: 0 });
      else this._set('failed', { message: e?.name === 'QuotaExceededError' ? 'This device is out of space for ZB’s voice.' : e?.message || 'Download failed.' });
    } finally {
      this.ctl = null;
    }
  }

  cancelDownload() {
    this.ctl?.abort();
  }

  async start() {
    if (this.worker) return;
    this._set('loading');
    try {
      const [manifest, half, wasm] = await Promise.all(['manifest', 'half', 'wasm'].map((k) => idb('readonly', (s) => s.get(k))));
      if (!manifest || !half || !wasm) {
        this._set('missing');
        return;
      }
      const w = new Worker('lib/voice-worker.js');
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('The voice took too long to start.')), 90000);
        w.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(t);
            resolve();
          } else if (e.data.type === 'failed') {
            clearTimeout(t);
            reject(new Error(e.data.message));
          }
        };
        w.onerror = (e) => {
          clearTimeout(t);
          reject(new Error(e.message || 'The voice couldn’t start.'));
        };
        w.postMessage({ type: 'init', manifest, half, wasm }, [half.buffer, wasm]);
      });
      w.onmessage = (e) => this._message(e.data);
      w.onerror = () => {
        for (const res of this.waiting.values()) res(null);
        this.waiting.clear();
        this.worker = null;
        this._set('failed', { message: 'The voice stopped working. Reload to try again.' });
      };
      this.worker = w;
      this._set('ready');
    } catch (e) {
      this._set('failed', { message: e?.message || 'The voice couldn’t start.' });
    }
  }

  _message(m) {
    const res = this.waiting.get(m.id);
    if (!res) return;
    this.waiting.delete(m.id);
    if (m.type === 'audio') res({ pcm: m.pcm, sampleRate: m.sampleRate });
    else if (m.type === 'error') res({ error: new Error(m.message) });
    else res(null);
  }

  // Resolves {pcm, sampleRate}, {error}, or null when cancelled.
  speak(text, { speaker = ZB_DEFAULT_SPEAKER, accent = 2, rate = 1 } = {}) {
    if (!this.worker) return Promise.resolve({ error: new Error('ZB’s voice isn’t loaded yet.') });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ type: 'say', id, text, speaker, accent, rate });
    });
  }

  cancel() {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'cancel', upTo: this.nextId - 1 });
    for (const res of this.waiting.values()) res(null);
    this.waiting.clear();
  }

  async remove() {
    this.cancelDownload();
    this.worker?.terminate();
    this.worker = null;
    await idb('readwrite', (s) => s.clear()).catch(() => {});
    this._set('missing', { progress: 0 });
  }
}
