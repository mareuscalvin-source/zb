// Store: profile, memory, mirror, chat history and the Vault index.
// On claude.ai these live in the page's private per-person database, so they follow
// the user across phone, Mac and laptop. Everywhere else they stay on the device.

import { DEFAULT_PERSONALITY, LEGACY_PERSONALITIES } from './brain.js';
import { defaultMirror, upgradeMirror, MAX_SAMPLES } from './mirror.js';

const PREFIX = 'jarvis:';
export const local = {
  get(k, d) {
    try {
      const v = localStorage.getItem(PREFIX + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(PREFIX + k, JSON.stringify(v));
    } catch (e) {
      /* storage can be blocked; the app still works for this visit */
    }
  },
};

export const DEFAULT_PROFILE = {
  v: 4,
  assistantName: 'ZB',
  userName: 'boss',
  personality: '', // empty = the built-in persona, so improvements keep reaching people who never edited it
  look: 'orb', // orb | face
  palette: 'aurora',
  color: 'cyan',
  beard: true,
  hair: true,
  deep: false,
  zbSpeaker: 52, // ZB's own voice: which of the 904, how much Miami, how fast
  zbAccent: 2,
  zbRate: 1.05,
};

// Bring profiles saved by the first version up to date without overwriting real customizations.
function upgrade(p) {
  const out = { ...DEFAULT_PROFILE, ...p };
  const v = p.v || 1;
  if (v < 2) {
    if (!p.assistantName || p.assistantName === 'Jarvis') out.assistantName = 'ZB';
    out.look = 'orb';
    out.palette = p.palette || 'aurora';
  }
  if (v < 4 && (!p.personality || p.personality === DEFAULT_PERSONALITY || LEGACY_PERSONALITIES.includes(p.personality))) out.personality = '';
  out.v = DEFAULT_PROFILE.v;
  return out;
}

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const MAX_CHAT = 60;
const MAX_MEM = 120;
const DOC_BUDGET = 200 * 1024; // stay well under the 256 KiB per-document limit
export const MAX_VAULT = 2000;

const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const words = (s) => new Set(String(s || '').toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 2));

// Trim the oldest entries of an array field until the document fits the budget.
function fit(doc, field) {
  let out = doc;
  while (out[field].length > 1 && bytes(out) > DOC_BUDGET) out = { ...out, [field]: out[field].slice(Math.ceil(out[field].length / 10)) };
  return out;
}

// Keep a Vault index entry small no matter what the summary model returned.
export function capVaultItem(it) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    id: s(it.id, 40),
    name: s(it.name, 160),
    type: s(it.type, 80),
    kind: s(it.kind, 20),
    size: Number(it.size) || 0,
    title: s(it.title, 120),
    summary: s(it.summary, 700),
    facts: (Array.isArray(it.facts) ? it.facts : []).slice(0, 12).map((f) => s(f, 200)),
    keys: (Array.isArray(it.keys) ? it.keys : []).slice(0, 40).map((k) => s(k, 24)),
    chars: Number(it.chars) || 0,
    parts: Number(it.parts) || 0,
    note: s(it.note, 200),
    assetId: it.assetId ? s(it.assetId, 64) : null,
    device: s(it.device, 40),
    at: Number(it.at) || Date.now(),
  };
}

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createStore({ cloudPossible = false } = {}) {
  const listeners = new Set();
  const state = {
    profile: upgrade(local.get('profile', {})),
    memory: local.get('memory', []),
    chat: local.get('chat', []),
    mirror: upgradeMirror(local.get('mirror', {})),
    vault: local.get('vault', []),
    sync: 'device', // device | connecting | synced | offline | full
  };
  let cloud = null; // { db, base, refs, items }
  // Vault writes made while the cloud is still connecting wait for it, so they land where every device can see them.
  let settle = () => {};
  const settled = cloudPossible ? new Promise((r) => (settle = r)) : Promise.resolve();
  const pending = {};
  const dirty = {};
  const ready = {}; // a document's first definitive snapshot has been applied
  // Changes made before a document's first cloud snapshot, replayed on top of the cloud copy
  // so a device that just woke up never overwrites what the others saved.
  const preOps = { profile: [], memory: [], chat: [], mirror: [] };
  let recordOps = cloudPossible;

  const emit = (what) => listeners.forEach((f) => f(what));
  const body = {
    profile: () => ({ ...state.profile }),
    memory: () => fit({ items: state.memory }, 'items'),
    chat: () => fit({ turns: state.chat }, 'turns'),
    mirror: () => {
      const m = { ...state.mirror };
      while (m.samples.length > 1 && bytes(m) > DOC_BUDGET) m.samples = m.samples.slice(5);
      return m;
    },
  };

  function setSync(s) {
    if (state.sync !== s) {
      state.sync = s;
      emit('sync');
    }
  }

  // One write at a time per document; bursts collapse into the latest state.
  // Resolves true when the cloud has it (or there is no cloud), false otherwise.
  function save(name) {
    local.set(name, state[name]);
    if (!cloud || !ready[name]) return Promise.resolve(true);
    if (pending[name]) {
      dirty[name] = true;
      return pending[name];
    }
    pending[name] = (async () => {
      let ok = true;
      do {
        dirty[name] = false;
        try {
          await cloud.refs[name].set(body[name]());
          ok = true;
          setSync('synced');
        } catch (e) {
          ok = false;
          setSync(e && (e.code === 'invalid_argument' || e.code === 'quota_exceeded') ? 'full' : 'offline');
        }
      } while (dirty[name]);
      pending[name] = null;
      return ok;
    })();
    return pending[name];
  }

  // Change one slice of state; before the cloud copy arrives, remember the change so it can be replayed.
  function mutate(name, fn) {
    state[name] = fn(state[name]);
    if (recordOps && !ready[name]) preOps[name].push(fn);
    emit(name === 'chat' ? 'chat-local' : name);
    return save(name);
  }

  const api = {
    get profile() {
      return state.profile;
    },
    get memory() {
      return state.memory;
    },
    get chat() {
      return state.chat;
    },
    get sync() {
      return state.sync;
    },
    get mirror() {
      return state.mirror;
    },
    get vault() {
      return state.vault;
    },
    onChange(f) {
      listeners.add(f);
      return () => listeners.delete(f);
    },

    setProfile(patch) {
      return mutate('profile', (p) => ({ ...p, ...patch }));
    },

    setMirror(patch) {
      return mutate('mirror', (m) => ({ ...m, ...patch }));
    },
    // Keep one of the user's own messages as a sample of how they talk. Returns samples since the last study.
    addSample(text, src = 'chat') {
      const t = String(text || '').trim().slice(0, 1500);
      if (!t || state.mirror.samples.some((s) => s.t === t)) return state.mirror.since;
      const entry = { t, src, at: Date.now() };
      mutate('mirror', (m) => {
        if (m.samples.some((s) => s.t === t)) return m;
        return { ...m, samples: [...m.samples, entry].slice(-MAX_SAMPLES), since: (m.since || 0) + 1 };
      });
      return state.mirror.since;
    },
    resetMirror() {
      return mutate('mirror', () => defaultMirror());
    },

    addMemory(text) {
      text = String(text || '').trim().slice(0, 300);
      if (!text) return false;
      const same = (m) => m.text.toLowerCase() === text.toLowerCase();
      if (state.memory.some(same)) return false;
      const item = { id: rid(), text, at: Date.now() };
      mutate('memory', (mem) => (mem.some(same) ? mem : [...mem, item].slice(-MAX_MEM)));
      return true;
    },
    // Forget the memory that best matches a few words (whole words only, never substrings).
    forgetMemory(query) {
      const q = [...words(query)];
      if (!q.length) return 0;
      const need = q.length === 1 ? 1 : Math.max(2, Math.ceil(q.length * 0.6));
      let best = null;
      let bestHits = 0;
      for (const m of state.memory) {
        const w = words(m.text);
        const hits = q.filter((x) => w.has(x)).length;
        if (hits > bestHits) {
          best = m;
          bestHits = hits;
        }
      }
      if (!best || bestHits < need) return 0;
      const id = best.id;
      mutate('memory', (mem) => mem.filter((m) => m.id !== id));
      return 1;
    },
    removeMemory(id) {
      return mutate('memory', (mem) => mem.filter((m) => m.id !== id));
    },
    clearMemory() {
      return mutate('memory', () => []);
    },

    appendTurns(turns) {
      const clean = turns.map((t) => ({ ...t, t: String(t.t).slice(0, 4000), ...(t.raw ? { raw: String(t.raw).slice(0, 6000) } : {}) }));
      return mutate('chat', (chat) => [...chat, ...clean].slice(-MAX_CHAT));
    },
    clearChat() {
      const r = mutate('chat', () => []);
      emit('chat');
      return r;
    },

    // ---- Vault index: one small document per file ----
    // Where file text lives in the cloud: private documents under the person's subtree.
    get cloudText() {
      return cloud ? (id) => cloud.db.doc(`${cloud.base}/vault`).collection('text').doc(id) : null;
    },
    async putVaultItem(item) {
      const it = capVaultItem(item);
      if (!state.vault.some((x) => x.id === it.id) && state.vault.length >= MAX_VAULT) {
        throw new StoreError('vault_full', `The Vault holds up to ${MAX_VAULT} files. Forget a few to add more.`);
      }
      if (cloud) {
        try {
          await cloud.items.doc(it.id).set(it);
        } catch (e) {
          throw new StoreError(e?.code || 'unavailable', e?.code === 'quota_exceeded' ? 'Your ZB storage is full. Forget a few files to add more.' : 'Couldn’t save that to the Vault right now. Try again in a bit.');
        }
      }
      state.vault = [...state.vault.filter((x) => x.id !== it.id), it];
      local.set('vault', state.vault);
      emit('vault');
      return it;
    },
    async removeVaultItem(id) {
      if (cloud) await cloud.items.doc(id).delete();
      state.vault = state.vault.filter((x) => x.id !== id);
      local.set('vault', state.vault);
      emit('vault');
    },

    // Connect to the claude.ai page database. Resolves true when synced.
    whenConnected() {
      return Promise.race([settled, new Promise((r) => setTimeout(r, 10000))]);
    },
    async connectCloud() {
      try {
        return await connect();
      } finally {
        settle();
      }
    },
  };
  async function connect() {
    {
      const c = window.claude;
      if (!c || !c.use) {
        recordOps = false;
        return false;
      }
      setSync('connecting');
      const [db, user] = await Promise.all([c.use('db'), c.use('user')]);
      const uid = user ? await user.id() : null;
      if (!db || !uid) {
        recordOps = false;
        for (const k of Object.keys(preOps)) preOps[k] = [];
        setSync('device');
        return false;
      }
      const base = `data/users/${uid}`;
      cloud = {
        db,
        base,
        refs: {
          profile: db.doc(`${base}/profile`),
          memory: db.doc(`${base}/memory`),
          chat: db.doc(`${base}/chat`),
          mirror: db.doc(`${base}/mirror`),
        },
        items: db.doc(`${base}/vault`).collection('items'),
      };
      settle();
      const fromCloud = {
        profile: (d) => upgrade(d),
        mirror: (d) => upgradeMirror(d),
        memory: (d) => (Array.isArray(d.items) ? d.items : []),
        chat: (d) => (Array.isArray(d.turns) ? d.turns : []),
      };
      const needsUpgrade = {
        profile: (d) => (d.v || 1) < DEFAULT_PROFILE.v,
        mirror: (d) => (d.v || 1) < 2,
        memory: () => false,
        chat: () => false,
      };

      const firsts = Object.keys(cloud.refs).map(
        (name) =>
          new Promise((resolve) => {
            cloud.refs[name].onSnapshot(
              (snap) => {
                if (!ready[name]) {
                  // a cached "nothing here yet" can be wrong on a new device: wait for the server
                  if (!snap.exists && snap.metadata.fromCache) return;
                  const ops = preOps[name];
                  preOps[name] = [];
                  if (snap.exists) {
                    state[name] = fromCloud[name](snap.data());
                    for (const op of ops) state[name] = op(state[name]);
                  }
                  ready[name] = true;
                  local.set(name, state[name]);
                  emit(name);
                  // write back when this device had changes, the cloud copy is old, or the cloud is empty
                  const empty = !snap.exists && (name === 'profile' || name === 'mirror' || state[name].length > 0);
                  if (ops.length || empty || (snap.exists && needsUpgrade[name](snap.data()))) save(name);
                  resolve();
                  return;
                }
                if (snap.metadata.hasPendingWrites || pending[name] || !snap.exists) return;
                state[name] = fromCloud[name](snap.data());
                local.set(name, state[name]);
                emit(name);
              },
              () => {
                setSync('offline');
                resolve();
              },
            );
          }),
      );

      // Vault: subscribe to the per-file collection, and move entries from the old single index document.
      const vaultFirst = new Promise((resolve) => {
        let done = false;
        cloud.items.onSnapshot(
          (snap) => {
            if (!done && snap.empty && snap.metadata.fromCache) return;
            state.vault = snap.docs.filter((d) => d.exists).map((d) => d.data());
            local.set('vault', state.vault);
            emit('vault');
            if (!done) {
              done = true;
              resolve();
            }
          },
          () => {
            setSync('offline');
            if (!done) {
              done = true;
              resolve();
            }
          },
        );
      });
      const migrate = (async () => {
        try {
          const old = await db.doc(`${base}/vault`).get();
          const items = old.exists && Array.isArray(old.data().items) ? old.data().items : [];
          for (const it of items) await cloud.items.doc(String(it.id)).set(capVaultItem(it));
          if (items.length) await db.doc(`${base}/vault`).set({ items: [], movedToItems: true });
        } catch (e) {
          /* nothing to move, or try again next visit */
        }
      })();

      await Promise.all([...firsts, vaultFirst, migrate]);
      recordOps = false;
      if (state.sync === 'connecting') setSync('synced');
      return true;
    }
  }
  return api;
}
