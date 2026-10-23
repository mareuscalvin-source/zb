import fs from 'node:fs';
const frag = fs.readFileSync('dist/jarvis.html', 'utf8');
const mock = `
window.__said = [];
window.claude = { use: async (name) => {
  await new Promise(r => setTimeout(r, 60));
  if (name === 'sample') {
    const f = async (input, opts = {}) => {
      window.__lastInput = input; window.__lastOpts = { ...opts, onText: !!opts.onText };
      const reply = "[mood:happy] Hey boss, good to see you. [remember:Likes testing new gadgets] Got that locked in. [mood:amused] And I started a tea timer for you. [timer:90|tea]";
      let text = '';
      for (const ch of reply.match(/[\\s\\S]{1,6}/g)) { await new Promise(r => setTimeout(r, 30)); if (opts.signal?.aborted) throw {code:'cancelled', text}; text += ch; opts.onText && opts.onText({ text, delta: ch }); }
      return { text, truncated: false, modelTierApplied: opts.modelTier || 'default' };
    };
    f.json = async (input, opts = {}) => {
      window.__jsonCalls = (window.__jsonCalls || 0) + 1; window.__lastJson = { input: String(input).slice(0, 4000), images: !!(opts.images && opts.images.length) };
      await new Promise(r => setTimeout(r, 50));
      if (/mirrorProfile/.test(input)) return { mirrorProfile: 'Talks in long run-on dictated sentences, says basically and ya feel me, gives full control, wants it done right. '.repeat(2), signaturePhrases: ['ya feel me', 'basically', 'allat'] };
      return { title: 'Lease Agreement', summary: 'Lease for Wesley Pierre at $1,850 a month, starting November 1, 2026.', facts: ['Rent $1,850/month', 'Move-in November 1, 2026'], kind: 'document' };
    };
    f.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 2e7, mediaTypes: ['image/jpeg', 'image/png'] } });
    return f;
  }
  if (name === 'db') {
    const store = window.__db = {}; const subs = {}; const csubs = {};
    const meta = { fromCache: false, hasPendingWrites: false };
    const snap = (p) => ({ id: p.split('/').pop(), exists: p in store, data: () => store[p], metadata: meta });
    const parent = (p) => p.slice(0, p.lastIndexOf('/'));
    const csnap = (c) => { const docs = Object.keys(store).filter((k) => parent(k) === c).sort().map(snap); return { docs, empty: !docs.length, size: docs.length, metadata: meta }; };
    const notify = (p) => { (subs[p] || []).forEach((f) => f(snap(p))); (csubs[parent(p)] || []).forEach((f) => f(csnap(parent(p)))); };
    const coll = (c) => ({ path: c, doc: (id) => doc(c + '/' + id), get: async () => csnap(c),
      onSnapshot: (next) => { (csubs[c] ||= []).push(next); setTimeout(() => next(csnap(c)), 40); return () => {}; } });
    const doc = (path) => ({ path, id: path.split('/').pop(), get: async () => snap(path),
      set: async (d) => { await new Promise(r => setTimeout(r, 20)); store[path] = JSON.parse(JSON.stringify(d)); notify(path); },
      update: async (d) => { await new Promise(r => setTimeout(r, 20)); store[path] = { ...(store[path] || {}), ...JSON.parse(JSON.stringify(d)) }; notify(path); },
      delete: async () => { delete store[path]; notify(path); },
      collection: (c) => coll(path + '/' + c),
      onSnapshot: (next) => { (subs[path] ||= []).push(next); setTimeout(() => next(snap(path)), 40); return () => {}; } });
    return { doc, collection: coll };
  }
  if (name === 'user') return { id: async () => 'u_test', isOwner: async () => true };
  if (name === 'assets') {
    const blobs = window.__assets = {};
    return {
      upload: async (blob, o = {}) => { const id = Math.random().toString(16).slice(2).padEnd(32, '0'); blobs[id] = { size: blob.size, type: o.type || blob.type }; return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: o.type || blob.type }; },
      list: async () => ({ assets: Object.entries(blobs).map(([id, b]) => ({ id, url: '/_blob/' + id, contentType: b.type, sizeBytes: b.size, createdAt: '' })), usage: { files: Object.keys(blobs).length, bytes: Object.values(blobs).reduce((a, b) => a + b.size, 0), maxFiles: 1000, maxBytes: 1e9 } }),
      delete: async (id) => ({ deleted: delete blobs[id] }),
    };
  }
  if (name === 'room') {
    let h = null;
    return { presence: async (p) => { window.__presence = p; }, onPeers: (fn) => { h = fn; setTimeout(() => fn({ peers: [{ isMe: true, kind: 'viewer', presence: window.__presence || {} }, { isMe: true, kind: 'viewer', presence: { device: 'iPhone' } }], joined: [], left: [], updated: [] }), 200); return () => {}; } };
  }
  return null;
} };`;
fs.writeFileSync('dev/mock-artifact.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script>${mock}</script></head><body>${frag}</body></html>`);
