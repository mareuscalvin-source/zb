// App: wires the face, voice, brain and memory into one assistant.
import { Avatar } from './avatar.js';
import { PALETTES, DEFAULT_PALETTE, hexToRgb } from './palettes.js';
import { Speaker, Listener, designVoices, saveDesignedVoice, ZB_VOICE_DESCRIPTION, ZB_VOICE_SAMPLE } from './voice.js';
import {
  buildSystem, TagStream, Sentences, normalizeMood, askViaPage, pageErrorText, DEFAULT_PERSONALITY,
} from './brain.js';
import { createStore, local } from './store.js';
import { STUDY_EVERY, isGoodSample, studyInput, parseStudy, mirrorProfileOf, fillUser } from './mirror.js';
import { createVault, deviceLabel } from './vault.js';
import { kindOf } from './extract.js';

const paletteOf = (p) => PALETTES[p.palette] || PALETTES[DEFAULT_PALETTE];
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const tidy = (s) => s.replace(/[ \t]{2,}/g, ' ').replace(/ ([.,!?])/g, '$1').trim();

export function boot({ apiAsk = null, apiErrorText = null, models = [] } = {}) {
  const inClaude = !!(window.claude && typeof window.claude.use === 'function');
  const mode = inClaude ? 'cloud' : 'web';
  const app = $('app');
  app.dataset.mode = mode;

  const store = createStore({ cloudPossible: inClaude });
  const dev = {
    engine: 'device', voiceURI: '', pitch: 0.92, rate: 1, muted: false,
    elevenKey: '', elevenVoice: '', elevenModel: 'eleven_flash_v2_5',
    apiKey: '', model: 'claude-opus-5-5', web: false, wake: false,
    ...local.get('device', {}),
  };
  if (dev.elevenModel === 'eleven_turbo_v2_5') dev.elevenModel = 'eleven_flash_v2_5'; // retired option
  const saveDev = () => local.set('device', dev);

  // ---------- face ----------
  const view = $('view');
  const startPal = paletteOf(store.profile);
  const face = new Avatar({
    orbCanvas: $('orbCanvas'),
    faceCanvas: $('faceCanvas'),
    look: store.profile.look || 'orb',
    palette: startPal.stops,
    faceColor: hexToRgb(startPal.ui),
    faceOptions: { beard: store.profile.beard !== false, hair: store.profile.hair !== false },
  });
  const hud = $('hud');
  const dock = $('dock');
  const layout = () => {
    const top = hud.getBoundingClientRect().height + 8;
    const bottom = dock.getBoundingClientRect().height;
    app.style.setProperty('--dock-h', `${Math.round(bottom)}px`);
    face.setViewport(top, bottom + 48);
  };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(layout);
    ro.observe(dock);
    ro.observe(app);
  } else addEventListener('resize', layout);
  layout();

  // ---------- status ----------
  const statusEl = $('status');
  const statusText = $('statusText');
  const LABEL = {
    idle: 'Standing by', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking',
    sleeping: 'Asleep · tap to wake', error: 'Trouble connecting', ears: 'Ears on',
  };
  function setStatus(s) {
    statusEl.dataset.state = s;
    statusText.textContent = LABEL[s] || s;
  }

  // Screen readers hear one polite announcement per event, never the streaming text.
  function announce(text) {
    const a = $('announce');
    a.textContent = '';
    setTimeout(() => (a.textContent = text), 50);
  }
  let toastTimer = 0;
  function toast(msg, bad = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('bad', bad);
    t.hidden = false;
    announce(msg);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4200);
  }

  // ---------- transcript ----------
  const log = $('log');
  function addLine(role, text, extra = {}) {
    const el = document.createElement('div');
    el.className = `line ${role}`;
    const p = store.profile;
    if (role !== 'note') {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = role === 'a' ? p.assistantName : p.userName || 'You';
      el.append(who);
    }
    if (extra.file) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.textContent = extra.file;
      el.append(chip);
    }
    if (extra.pic) {
      const img = document.createElement('img');
      img.className = 'pic';
      img.alt = 'Photo you sent';
      img.src = extra.pic;
      el.append(img);
    }
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = text;
    el.append(txt);
    log.append(el);
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    return {
      el,
      set(v) {
        txt.textContent = v;
        log.scrollTop = log.scrollHeight;
      },
    };
  }
  const chatKey = () => {
    const last = store.chat[store.chat.length - 1];
    return `${store.chat.length}|${last ? last.at : 0}|${last ? last.t.length : 0}`;
  };
  let renderedKey = '';
  function renderLog() {
    log.textContent = '';
    for (const t of store.chat.slice(-20)) addLine(t.r === 'u' ? 'u' : 'a', t.t);
    if (!store.chat.length) {
      addLine('a', `${store.profile.assistantName} online. Tap me or type below to start.`).el.classList.add('intro');
    }
    renderedKey = chatKey();
  }

  // ---------- voice ----------
  let busy = false; // a reply is streaming
  let relaxTimer = 0;
  const speaker = new Speaker({
    onStart(item) {
      clearTimeout(relaxTimer);
      face.setState('speaking');
      face.setMood(item.meta.mood || 'neutral');
      setStatus('speaking');
      listener.pause();
    },
    onIdle() {
      if (!busy) {
        face.setState('idle');
        setStatus(listener.wakeOn ? 'ears' : 'idle');
        listener.resume();
        setTimeout(flushNotes, 400);
      }
      relaxTimer = setTimeout(() => {
        if (!speaker.speaking && !busy) face.setMood('neutral');
      }, 3500);
    },
    onWord() {
      const r = Math.random();
      if (r < 0.07) face.flashBrows();
      else if (r < 0.12) face.nod();
    },
    onError(e) {
      toast(e?.message || 'Voice trouble. Using the device voice instead.', true);
    },
    onVoices() {
      if (!$('panel').hidden) fillVoices();
    },
  });
  const applyVoice = () => speaker.configure({
    engine: mode === 'web' ? dev.engine : 'device',
    voiceURI: dev.voiceURI, pitch: dev.pitch, rate: dev.rate, muted: dev.muted,
    elevenKey: dev.elevenKey, elevenVoice: dev.elevenVoice, elevenModel: dev.elevenModel,
  });
  applyVoice();
  face.mouthSource = () => speaker.mouth();

  // ---------- listening (downloadable app only; claude.ai pages can't use the mic) ----------
  const micBtn = $('btnMic');
  const msg = $('msg');
  const listener = new Listener({
    onState(s) {
      micBtn.classList.toggle('live', s === 'command');
      if (s === 'command') {
        face.setState('listening');
        face.setMood('listening');
        setStatus('listening');
      } else if (!busy && !speaker.speaking) {
        face.setState('idle');
        setStatus(s === 'wake' || listener.wakeOn ? 'ears' : 'idle');
      }
    },
    onInterim(text) {
      msg.value = text;
    },
    onFinal(text) {
      msg.value = '';
      send(text);
    },
    onWake() {
      chirp();
      face.setMood('listening');
    },
    onEmpty() {
      msg.value = '';
      face.setMood('neutral');
      listener.resume();
      flushNotes();
    },
    onError(code) {
      micBtn.classList.remove('live');
      if (code === 'blocked') {
        dev.wake = false;
        saveDev();
        $('setWake').checked = false;
        toast('The microphone is blocked. Allow it for this site in your browser settings.', true);
      } else if (code === 'network') toast('Speech recognition needs an internet connection.', true);
      if (!busy) setStatus('idle');
    },
  });
  const canListen = mode === 'web' && listener.supported;
  micBtn.hidden = !canListen;

  // ---------- profile / look ----------
  function applyProfile() {
    const p = store.profile;
    const name = p.assistantName || 'ZB';
    $('mark').textContent = name.toUpperCase();
    $('wakeText').textContent = `Tap to wake ${name}`;
    msg.placeholder = `Talk to ${name}…`;
    $('wakeLabel').textContent = `Hands-free: say “${name}”`;
    document.title = name;
    listener.wakeWord = name.toLowerCase();
    const pal = paletteOf(p);
    const rgb = hexToRgb(pal.ui);
    face.setPalette(pal.stops);
    face.setFaceLook(rgb, { beard: p.beard !== false, hair: p.hair !== false });
    if ((p.look || 'orb') !== face.look) face.use(p.look || 'orb');
    app.dataset.look = face.look;
    app.style.setProperty('--holo', `rgb(${rgb.join(',')})`);
    app.style.setProperty('--holo-rgb', rgb.join(','));
    app.style.setProperty('--glow-a', hexToRgb(pal.stops[1]).join(','));
    app.style.setProperty('--glow-b', hexToRgb(pal.stops[2]).join(','));
    $('roMem').textContent = String(store.memory.length).padStart(2, '0');
  }
  let devices = [];
  function applySync() {
    const el = $('roLink');
    const s = mode === 'web' ? 'device' : store.sync;
    el.textContent = s === 'synced' && devices.length > 1 ? `${devices.length} devices` : { device: 'Device', connecting: 'Linking', synced: 'Synced', offline: 'Offline', full: 'Storage full' }[s] || s;
    el.title = devices.length > 1 ? `Open now on: ${devices.join(', ')}` : '';
    el.classList.toggle('on', s === 'synced');
  }
  store.onChange((what) => {
    if (what === 'profile') {
      applyProfile();
      if (!$('panel').hidden) fillSettings(true);
    }
    if (what === 'memory') {
      $('roMem').textContent = String(store.memory.length).padStart(2, '0');
      if (!$('panel').hidden) fillMemory();
    }
    if (what === 'chat' && !busy && chatKey() !== renderedKey) renderLog(); // another device added to the chat
    if (what === 'sync') applySync();
    if (what === 'mirror' && !$('panel').hidden) fillMirror(true);
    if (what === 'vault' && !$('vaultPanel').hidden) renderVault();
  });
  applyProfile();
  applySync();
  renderLog();

  // ---------- hints ----------
  const touch = matchMedia('(pointer: coarse)').matches;
  function setHint() {
    let h = '';
    if (mode === 'cloud') {
      if (touch) h = 'Tip: tap the mic on your keyboard to talk';
      else if (/Mac/i.test(navigator.platform || navigator.userAgent)) h = 'Tip: press Fn twice to dictate on a Mac';
      else if (/Win/i.test(navigator.platform || navigator.userAgent)) h = 'Tip: press Windows + H to dictate';
    } else if (!dev.apiKey) h = 'Add your Claude API key in Settings to start';
    else if (canListen) h = dev.wake ? `Say “${store.profile.assistantName}” or tap the mic` : 'Tap the mic or my face to talk';
    else h = 'Type to talk. Chrome, Edge and Safari can also listen';
    $('hint').textContent = h;
  }
  setHint();

  // ---------- waking / audio unlock ----------
  let awake = false;
  const wakeBtn = $('wake');
  function unlock() {
    speaker.unlock();
    if (!awake) {
      awake = true;
      wakeBtn.hidden = true;
      layout();
      if (canListen && dev.wake) listener.setWake(true);
      return true;
    }
    return false;
  }
  function greet() {
    const p = store.profile;
    const h = new Date().getHours();
    const part = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
    const lines = [
      `${part}, ${p.userName}. I'm up, what we getting into?`,
      `Yo ${p.userName}, I'm here, what's good?`,
      `${part}. Mwen la, talk to me.`,
    ];
    log.querySelector('.line.intro')?.remove();
    let text = lines[Math.floor(Math.random() * lines.length)];
    if (mode === 'web' && !dev.apiKey) text += ' One thing first: I need a Claude API key before I can think. Tap the gear up top.';
    sayLocal(text, mode === 'web' && !dev.apiKey ? 'concerned' : 'confident');
  }
  function sayLocal(text, mood = 'neutral') {
    addLine('a', text);
    face.setMood(mood);
    speaker.say(text, { mood });
  }
  wakeBtn.addEventListener('click', () => {
    unlock();
    noteActivity();
    greet();
  });

  // ---------- sleep ----------
  let lastActive = Date.now();
  function noteActivity() {
    lastActive = Date.now();
    if (face.state === 'sleeping') {
      face.setState('idle');
      setStatus('idle');
    }
  }
  setInterval(() => {
    if (busy || speaker.speaking || listener.mode === 'command') return;
    if (Date.now() - lastActive > 4 * 60 * 1000 && face.state !== 'sleeping') {
      face.setState('sleeping');
      setStatus('sleeping');
    }
  }, 15000);

  // ---------- looking around ----------
  view.addEventListener('pointermove', (e) => {
    const r = view.getBoundingClientRect();
    const nx = (e.clientX - r.left - face.cx) / (r.width / 2);
    const ny = -(e.clientY - r.top - face.cy) / (r.height / 2);
    face.lookAt(nx * 1.3, ny * 1.3);
  });
  view.addEventListener('click', (e) => {
    const r = view.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const first = unlock();
    noteActivity();
    if (first) {
      greet();
      return;
    }
    if (!face.hit(x, y)) return;
    if (speaker.speaking) {
      speaker.stop();
      return;
    }
    if (canListen) toggleMic();
    else msg.focus();
  });

  // ---------- timers ----------
  let timers = local.get('timers', []).filter((t) => t.end > Date.now());
  const timersEl = $('timers');
  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  const timerEls = new Map();
  function renderTimers() {
    timersEl.textContent = '';
    timerEls.clear();
    for (const t of timers) {
      const el = document.createElement('div');
      el.className = 'timer';
      const label = document.createElement('span');
      label.textContent = t.label || 'Timer';
      const left = document.createElement('b');
      left.textContent = fmt(t.end - Date.now());
      const x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', `Cancel ${t.label || 'timer'}`);
      x.textContent = '×';
      x.onclick = () => {
        timers = timers.filter((q) => q !== t);
        local.set('timers', timers);
        renderTimers();
      };
      el.append(label, left, x);
      timersEl.append(el);
      timerEls.set(t.id, left);
    }
  }
  function tickTimers() {
    for (const t of timers) {
      const b = timerEls.get(t.id);
      if (b) b.textContent = fmt(t.end - Date.now());
    }
  }
  function addTimer(value) {
    const [secRaw, ...rest] = String(value).split('|');
    const sec = clamp(Math.round(parseFloat(secRaw)) || 0, 1, 86400);
    const label = rest.join('|').trim().slice(0, 40);
    timers.push({ id: Date.now() + Math.random(), end: Date.now() + sec * 1000, label });
    local.set('timers', timers);
    renderTimers();
    announce(`${label || 'Timer'} set for ${fmt(sec * 1000)}`);
  }
  setInterval(() => {
    if (!timers.length) return;
    const due = timers.filter((t) => t.end <= Date.now());
    if (due.length) {
      timers = timers.filter((t) => t.end > Date.now());
      local.set('timers', timers);
      for (const t of due) {
        chirp(3);
        noteActivity();
        sayLocal(`${store.profile.userName}, your ${t.label ? `${t.label} ` : ''}timer's done.`, 'surprised');
      }
      renderTimers();
    }
    tickTimers();
  }, 1000);
  renderTimers();

  function chirp(n = 1) {
    const ac = speaker._ensureAudio();
    if (!ac) return;
    for (let i = 0; i < n; i++) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const t0 = ac.currentTime + i * 0.22;
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(ac.destination);
      o.start(t0);
      o.stop(t0 + 0.18);
    }
  }

  // ---------- photos ----------
  async function jpegBase64(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const k = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { mediaType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.86).split(',')[1] };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- the brain ----------
  let samplePromise = null;
  const getSample = () => (samplePromise ||= inClaude ? window.claude.use('sample') : Promise.resolve(null));
  let imagesOk = mode === 'web'; // can Claude look at images in this view
  const imagesReady = !inClaude
    ? Promise.resolve(true)
    : getSample().then(async (s) => {
      try {
        imagesOk = !!(s && (await s.limits()).images);
      } catch (e) {
        imagesOk = false;
      }
      return imagesOk;
    });
  if (inClaude) {
    store.connectCloud().catch(() => applySync());
    // which of their devices have ZB open right now
    window.claude.use('room').then((room) => {
      if (!room) return;
      room.presence({ device: deviceLabel() }).catch(() => {});
      room.onPeers(({ peers }) => {
        devices = peers.filter((p) => p.isMe && p.kind === 'viewer').map((p) => String(p.presence?.device || 'device'));
        applySync();
      }, () => {});
    });
  }

  // ---------- files: the Vault ----------
  let assetsPromise = null;
  const getAssets = () => (assetsPromise ||= inClaude ? window.claude.use('assets') : Promise.resolve(null));
  async function askJson(prompt, image, signal) {
    if (mode === 'cloud') {
      const sample = await getSample();
      if (!sample) throw { code: 'unavailable' };
      const opts = { modelTier: 'default', cache: false };
      if (signal) opts.signal = signal;
      if (image && imagesOk) opts.images = [image];
      return sample.json(prompt, opts);
    }
    if (!dev.apiKey) throw { code: 'bad_key' };
    const r = await apiAsk({
      apiKey: dev.apiKey, model: dev.model, deep: false, webSearch: false,
      system: { stable: 'You file things into a personal memory vault for an AI assistant.', dynamic: 'Reply with the JSON object only.' },
      history: [], message: prompt, image: image ? await jpegBase64(image) : null, onText: () => {}, signal,
    });
    return r.text;
  }
  // Originals go to the page's shared file storage, which editors can list, so only the owner keeps them.
  const canKeepOriginals = async () => {
    if (!inClaude) return false;
    const u = await window.claude.use('user');
    return u ? u.isOwner() : false;
  };
  const vault = createVault({
    store, ask: askJson, getAssets, user: () => store.profile.userName,
    canSeeImages: () => imagesReady, canKeepOriginals,
  });

  const sizeOf = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  async function fileOne(file, onStep, signal) {
    if (mode === 'web' && !dev.apiKey) throw new Error('Add your Claude API key under Brain so ZB can read files.');
    if (file.size > 60 * 1024 * 1024) throw new Error(`${file.name} is over 60 MB, which is too big to read here.`);
    return vault.add(file, onStep, signal);
  }

  // A file attached in the composer is filed into the Vault right away; a message sent with it waits for it.
  let pending = null; // { file, isImg, job, item, ctl, thumbUrl }
  function clearPending() {
    pending = null;
    $('thumb').hidden = true;
    $('thumbState').textContent = '';
  }
  // X on the attachment: stop filing it, or take it back out of the Vault if it already landed.
  function cancelPending() {
    const pf = pending;
    if (!pf) return;
    clearPending();
    if (pf.item) {
      vault.remove(pf.item).then(() => toast(`Removed ${pf.file.name}`), () => {});
    } else pf.ctl.abort();
  }
  function attach(file) {
    unlock();
    noteActivity();
    if (pending && !pending.item) pending.ctl.abort(); // replaced before it finished: drop the old one
    const isImg = kindOf(file) === 'image';
    const ctl = new AbortController();
    const job = fileOne(file, (step) => {
      if (pending && pending.job === job) $('thumbState').textContent = step === 'Studying' ? 'Reading\u2026' : `${step}\u2026`;
    }, ctl.signal);
    const thumbUrl = isImg ? URL.createObjectURL(file) : '';
    pending = { file, isImg, job, item: null, ctl, thumbUrl };
    $('thumbImg').hidden = !isImg;
    if (isImg) $('thumbImg').src = thumbUrl;
    $('thumbName').textContent = isImg ? '' : file.name;
    $('thumbState').textContent = 'Reading\u2026';
    $('thumb').hidden = false;
    job.then(
      (item) => {
        if (!pending || pending.job !== job) return;
        pending.item = item;
        $('thumbState').textContent = 'Saved';
        // nothing typed: ZB tells them what it got
        if (!msg.value.trim()) {
          clearPending();
          sendNote({ justAdded: [item.id], image: item.jpeg || null });
        }
      },
      (e) => {
        if (pending && pending.job === job) clearPending();
        if (e && e.code === 'cancelled') return;
        toast(e.message || 'Couldn\u2019t read that file.', true);
      },
    );
  }
  const noteFor = (items) => `${store.profile.userName} just added ${items.length === 1 ? `"${items[0].name}"` : `${items.length} files (${items.map((i) => `"${i.name}"`).join(', ')})`} to your Vault from their ${deviceLabel()}. In one or two sentences, tell them what ${items.length === 1 ? 'it is' : 'they are'} and the one thing worth knowing.`;
  async function fileMany(files) {
    unlock();
    noteActivity();
    const added = [];
    const prog = $('vaultProgress');
    for (const [i, f] of files.entries()) {
      try {
        added.push(await fileOne(f, (step) => {
          prog.textContent = `${step} ${f.name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}\u2026`;
        }));
      } catch (e) {
        toast(e.message || `Couldn\u2019t read ${f.name}.`, true);
      }
    }
    prog.textContent = '';
    if (added.length) {
      toast(added.length === 1 ? `Saved ${added[0].title} to the Vault` : `Saved ${added.length} files to the Vault`);
      sendNote({ justAdded: added.map((x) => x.id) });
    }
  }
  $('btnAttach').addEventListener('click', () => $('attachIn').click());
  $('attachIn').addEventListener('change', () => {
    const files = [...($('attachIn').files || [])];
    $('attachIn').value = '';
    if (files.length === 1) attach(files[0]);
    else if (files.length) fileMany(files);
  });
  $('thumbX').addEventListener('click', cancelPending);

  // drag and drop anywhere on the app (desktop)
  let dragDepth = 0;
  app.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('dropzone').hidden = false;
  });
  app.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  app.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropzone').hidden = true;
  });
  app.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    fileMany(files);
  });

  // the Vault panel
  const vaultPanel = $('vaultPanel');
  const vaultBtn = $('btnVault');
  // On a phone a panel fills the screen: make what's behind it unreachable and stop drawing the stage.
  // On wider screens it's a side sheet and the rest of the app makes room for it.
  function coverCheck() {
    const open = !$('panel').hidden || !$('vaultPanel').hidden;
    const cover = open && innerWidth <= 560;
    app.classList.toggle('panel-open', open);
    for (const id of ['hud', 'dock', 'view', 'wake', 'timers']) {
      if (cover) $(id).setAttribute('inert', '');
      else $(id).removeAttribute('inert');
    }
    face.setCovered(cover);
  }
  addEventListener('resize', coverCheck);
  face.onFallback = () => {
    app.dataset.look = 'face';
    toast('Switched to the hologram head: this device\u2019s graphics stopped responding.', true);
  };
  function openVault() {
    if (!$('panel').hidden) closeSettings();
    renderVault();
    vaultPanel.hidden = false;
    vaultBtn.setAttribute('aria-expanded', 'true');
    coverCheck();
    setTimeout(() => $('vaultAdd').focus(), 30);
    getAssets().then((a) => a?.list().then(({ usage }) => {
      $('vaultUsage').textContent = `Storage: ${sizeOf(usage.bytes)} of ${sizeOf(usage.maxBytes)} used.`;
    }).catch(() => {}));
  }
  function closeVault() {
    vaultPanel.hidden = true;
    vaultBtn.setAttribute('aria-expanded', 'false');
    coverCheck();
    vaultBtn.focus();
  }
  vaultBtn.addEventListener('click', () => (vaultPanel.hidden ? openVault() : closeVault()));
  $('vaultClose').addEventListener('click', closeVault);
  $('vaultAdd').addEventListener('click', () => $('vaultIn').click());
  $('vaultIn').addEventListener('change', () => {
    const files = [...($('vaultIn').files || [])];
    $('vaultIn').value = '';
    if (files.length) fileMany(files);
  });
  function renderVault() {
    const items = [...store.vault].sort((a, b) => b.at - a.at);
    const originals = mode === 'cloud' && items.some((it) => it.assetId);
    $('vaultNote').textContent = (items.length
      ? `${items.length} file${items.length === 1 ? '' : 's'} ${store.profile.assistantName} remembers${mode === 'cloud' ? ', on all your devices' : ' on this device'}. Ask about any of them.`
      : `Drop in anything you want ${store.profile.assistantName} to remember: a lease, a receipt, a screenshot, notes. Ask about it later from ${mode === 'cloud' ? 'any of your devices' : 'here'}.`)
      + (originals ? ' Originals are stored with this page, so anyone you give edit access to it could open them.' : '');
    const list = $('vaultList');
    list.textContent = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'vault-item';
      const h = document.createElement('h4');
      h.textContent = it.title;
      const meta = document.createElement('div');
      meta.className = 'vault-meta';
      meta.textContent = `${it.name} \u00b7 ${sizeOf(it.size)} \u00b7 ${new Date(it.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} \u00b7 from ${it.device}${it.note ? ` \u00b7 ${it.note}` : ''}`;
      const p = document.createElement('p');
      p.textContent = it.summary;
      li.append(h, meta, p);
      if (it.facts && it.facts.length) {
        const d = document.createElement('details');
        const s = document.createElement('summary');
        s.textContent = 'Key facts';
        const ul = document.createElement('ul');
        for (const f of it.facts) {
          const fi = document.createElement('li');
          fi.textContent = f;
          ul.append(fi);
        }
        d.append(s, ul);
        li.append(d);
      }
      const actions = document.createElement('div');
      actions.className = 'vault-actions';
      if (it.assetId) {
        const a = document.createElement('a');
        a.href = `/_blob/${it.assetId}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Open original';
        actions.append(a);
      }
      const ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'btn ghost';
      ask.textContent = 'Ask about it';
      ask.onclick = () => {
        closeVault();
        msg.value = `What's in "${it.title}"?`;
        msg.focus();
      };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn ghost danger';
      del.textContent = 'Forget';
      let armed = 0;
      del.onclick = async () => {
        if (!armed) {
          del.textContent = 'Tap again to forget';
          armed = setTimeout(() => {
            armed = 0;
            del.textContent = 'Forget';
          }, 4000);
          return;
        }
        clearTimeout(armed);
        del.disabled = true;
        try {
          await vault.remove(it);
          toast(`Forgot ${it.title}`);
        } catch (e) {
          del.disabled = false;
          toast('Couldn\u2019t forget that right now. Try again in a bit.', true);
        }
      };
      actions.append(ask, del);
      li.append(actions);
      list.append(li);
    }
  }

  // ---------- talking ----------
  // Notes from the app (a file just landed) never cut ZB off: they wait for a quiet moment and go out together.
  let notes = [];
  const quiet = () => !current && !busy && !speaker.speaking && listener.mode !== 'command';
  function sendNote({ justAdded = [], image = null } = {}) {
    if (!justAdded.length) return;
    notes.push({ justAdded, image });
    flushNotes();
  }
  function flushNotes() {
    if (!notes.length || !quiet()) return;
    const batch = notes;
    notes = [];
    const ids = [...new Set(batch.flatMap((n) => n.justAdded))];
    const items = store.vault.filter((i) => ids.includes(i.id));
    if (!items.length) return;
    const image = items.length === 1 ? batch.find((n) => n.image)?.image || null : null;
    send('', { hidden: true, note: noteFor(items), justAdded: ids, image });
  }
  const whenAborted = (signal) => new Promise((res) => signal.addEventListener('abort', () => res(null), { once: true }));
  // The most recent turns that fit in about 24k characters, 30 at most.
  function recentHistory(budget = 24000, max = 30) {
    const out = [];
    for (let i = store.chat.length - 1; i >= 0 && out.length < max; i--) {
      const t = store.chat[i];
      const content = t.raw || t.t;
      if (!content) continue;
      if (content.length > budget) break;
      budget -= content.length;
      out.unshift({ role: t.r === 'u' ? 'user' : 'assistant', content });
    }
    return out;
  }

  let current = null;
  async function send(text, { hidden = false, note = '', justAdded = [], image = null } = {}) {
    text = String(text || '').trim();
    const pf = hidden ? null : pending;
    if (!hidden && !text && !pf) return;
    // claim the turn before anything async, so the newest message always wins
    if (current) current.abort();
    const ctl = new AbortController();
    current = ctl;
    busy = true;
    const mine = () => current === ctl && !ctl.signal.aborted;
    unlock();
    noteActivity();
    speaker.stop();
    if (listener.mode === 'command') listener.stop();
    face.setState('thinking');
    face.setMood('thinking');
    setStatus('thinking');

    const p = store.profile;
    let fileNames = [];
    let line = null;
    let shown = '';
    const userTurn = () => (!text
      ? `(added ${fileNames.length ? fileNames.join(', ') : 'files'} to the Vault)`
      : fileNames.length ? `${text} [file: ${fileNames.join(', ')}]` : text);
    // a newer message (or the mic) cut this one off: keep what was said so far and touch nothing else
    const stopped = () => {
      const partial = tidy(shown).trim();
      if (line) {
        line.el.classList.remove('pending');
        if (partial) line.set(`${partial} …`);
        else line.el.remove();
      }
      const turns = [{ r: 'u', t: userTurn(), at: Date.now() }];
      if (partial) turns.push({ r: 'a', t: `${partial} …`, at: Date.now() });
      store.appendTurns(turns);
      renderedKey = chatKey();
    };
    const release = () => {
      if (current !== ctl) return;
      current = null;
      busy = false;
    };

    if (!hidden) msg.value = '';
    let photoNote = '';
    if (pf) {
      // the message is about the file they just attached: wait until it's filed
      clearPending();
      fileNames = [pf.file.name];
      addLine('u', text || (pf.isImg ? '' : `\u{1F4CE} ${pf.file.name}`), pf.isImg ? { pic: pf.thumbUrl } : { file: pf.file.name });
      const item = pf.item || (await Promise.race([pf.job.catch(() => null), whenAborted(ctl.signal)]));
      if (!mine()) return stopped();
      if (item) justAdded = [...justAdded, item.id];
      if (pf.isImg) {
        image = (item && item.jpeg) || null;
        if (item && !image) photoNote = '\n\n(They sent a photo, but photos can’t be shown to you in this view. If it matters, say you can’t see it from here.)';
      }
      if (!text) {
        hidden = true;
        note = item ? noteFor([item]) : `${p.userName} tried to send you "${pf.file.name}" but it couldn't be read. Say so briefly.`;
      }
    } else if (!hidden) addLine('u', text);

    if (mode === 'web' && !dev.apiKey) {
      release();
      sayLocal(`I need a Claude API key before I can think, ${p.userName}. Tap the gear up top and paste it under Brain.`, 'concerned');
      openSettings('setKey');
      return;
    }

    const message = hidden ? `(Note from the app, not typed by ${p.userName}: ${note})` : text + photoNote;
    if (!fileNames.length && justAdded.length) fileNames = store.vault.filter((i) => justAdded.includes(i.id)).map((i) => i.name);
    if (image) await imagesReady;
    const sendPic = !!image && (mode === 'web' || imagesOk);
    const files = await Promise.race([vault.contextFor(hidden ? note : text, justAdded).catch(() => ''), whenAborted(ctl.signal)]);
    if (!mine()) return stopped();
    const system = buildSystem({
      assistantName: p.assistantName, userName: p.userName, personality: p.personality,
      memories: store.memory, webSearch: mode === 'web' && dev.web, mirror: store.mirror, files: files || '',
      lastReply: [...store.chat].reverse().find((t) => t.r === 'a')?.t || '',
    });
    // every message is a sample of how they talk
    if (!hidden && text && store.mirror.learn && isGoodSample(text)) store.addSample(text, 'chat');
    const history = recentHistory();

    line = addLine('a', '');
    line.el.classList.add('pending');
    const tags = new TagStream();
    const sentences = new Sentences();
    let mood = 'neutral';
    let saved = 0;
    const handle = (parts) => {
      for (const part of parts) {
        if (part.type === 'tag') {
          if (part.name === 'mood') {
            mood = normalizeMood(part.value);
            if (!speaker.speaking) face.setMood(mood);
          } else if (part.name === 'remember') {
            if (store.addMemory(part.value)) saved++;
          } else if (part.name === 'forget') {
            const n = store.forgetMemory(part.value);
            if (n) toast(`Forgot ${n} ${n === 1 ? 'memory' : 'memories'}`);
          } else if (part.name === 'timer') addTimer(part.value);
        } else {
          shown += part.text;
          line.set(tidy(shown));
          for (const s of sentences.push(part.text)) speaker.say(s, { mood });
        }
      }
    };
    const onText = ({ delta }) => {
      if (!mine()) return;
      handle(tags.push(delta));
    };

    let raw = '';
    let failed = null;
    try {
      if (mode === 'cloud') {
        const sample = await getSample();
        if (!sample) throw { code: 'unavailable' };
        const r = await askViaPage(sample, {
          system, history,
          message: sendPic ? `${message}\n\n(The photo is attached.)` : message,
          images: sendPic ? [image] : null,
          deep: p.deep, signal: ctl.signal, onText,
        });
        raw = r.text;
      } else {
        const r = await apiAsk({
          apiKey: dev.apiKey, model: dev.model, deep: p.deep, webSearch: dev.web,
          system, history, message, image: sendPic ? await jpegBase64(image) : null, signal: ctl.signal, onText,
        });
        raw = r.text;
      }
    } catch (e) {
      failed = e || { code: 'upstream_error' };
      raw = (e && e.text) || '';
    }
    if (!mine()) return stopped();
    handle(tags.end());
    for (const s of sentences.flush()) speaker.say(s, { mood });
    line.el.classList.remove('pending');
    release();

    if (failed && failed.code !== 'cancelled') {
      if (failed.code === 'refused') shown = '';
      const why = mode === 'cloud' ? pageErrorText(failed) : apiErrorText ? apiErrorText(failed) : 'Something went wrong.';
      if (failed.code === 'bad_key') openSettings('setKey');
      if (shown.trim()) {
        line.set(`${tidy(shown)} …`);
        toast(why, true);
      } else {
        line.el.remove();
        sayLocal(why, 'concerned');
      }
      setStatus('error');
      setTimeout(() => {
        if (!busy && !speaker.speaking) setStatus('idle');
      }, 4000);
    }
    if (shown.trim()) {
      log.querySelector('.line.intro')?.remove();
      store.appendTurns([
        { r: 'u', t: userTurn(), at: Date.now() },
        { r: 'a', t: tidy(shown), raw: raw || tidy(shown), at: Date.now() },
      ]);
      renderedKey = chatKey();
      if (!failed) announce(`${p.assistantName}: ${tidy(shown)}`);
    }
    if (saved) toast(saved === 1 ? 'Saved to memory' : `Saved ${saved} things to memory`);
    if (!failed && store.mirror.learn && (store.mirror.since || 0) >= STUDY_EVERY) setTimeout(() => studyNow({ quiet: true }), 2000);
    if (!speaker.speaking) {
      face.setState('idle');
      if (!failed) setStatus(listener.wakeOn ? 'ears' : 'idle');
      listener.resume();
    }
    flushNotes();
  }

  // ---------- the mirror: learning how the user talks ----------
  let studying = false;
  async function studyNow({ quiet = false } = {}) {
    if (studying) return false;
    if (mode === 'web' && !dev.apiKey) {
      if (!quiet) toast('Add your Claude API key under Brain first.', true);
      return false;
    }
    studying = true;
    fillMirror();
    try {
      const input = studyInput({ user: store.profile.userName, mirror: store.mirror });
      let raw;
      if (mode === 'cloud') {
        const sample = await getSample();
        if (!sample) throw { code: 'unavailable' };
        raw = await sample.json(input, { modelTier: 'default', cache: false });
      } else {
        const r = await apiAsk({
          apiKey: dev.apiKey, model: dev.model, deep: true, webSearch: false,
          system: { stable: 'You study how one specific person talks so their AI twin can sound exactly like them.', dynamic: 'Reply with the JSON object only.' },
          history: [], message: input, onText: () => {},
        });
        raw = r.text;
      }
      const res = parseStudy(raw);
      if (!res) throw { code: 'invalid_json' };
      await store.setMirror({ profile: res.profile, phrases: res.phrases.length ? res.phrases : store.mirror.phrases, since: 0, studiedAt: Date.now() });
      if (!quiet) toast(`${store.profile.assistantName} studied how you talk`);
      return true;
    } catch (e) {
      if (!quiet) toast(e && e.code === 'not_granted' ? pageErrorText(e) : 'Couldn\u2019t study right now. Try again in a bit.', true);
      return false;
    } finally {
      studying = false;
      fillMirror();
    }
  }
  function fillMirror(fromSync = false) {
    const m = store.mirror;
    const learned = m.samples.filter((s) => s.src !== 'seed').length;
    const when = m.studiedAt ? new Date(m.studiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    $('mirrorNote').textContent = studying
      ? 'Studying how you talk\u2026'
      : `${store.profile.assistantName} learns your voice from what you say to it. ${learned ? `${learned} of your messages so far` : 'Starting from your first chats with Claude'}${when ? `, last studied ${when}` : ''}.`;
    $('setLearn').checked = m.learn !== false;
    const ta = $('setMirror');
    if (!(fromSync && document.activeElement === ta)) ta.value = mirrorProfileOf(m, store.profile.userName);
    $('studyBtn').disabled = $('teachBtn').disabled = studying;
  }
  $('setLearn').addEventListener('change', () => store.setMirror({ learn: $('setLearn').checked }));
  {
    let t = 0;
    $('setMirror').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = $('setMirror').value.trim();
        if (v.length >= 40 && v !== mirrorProfileOf({ profile: '' }, store.profile.userName)) store.setMirror({ profile: v });
      }, 600);
    });
  }
  $('teachBtn').addEventListener('click', () => {
    const lines = $('teachBox').value.split(/\n+/).map((s) => s.trim()).filter(isGoodSample);
    if (!lines.length) {
      toast('Paste a few full messages first, one per line.', true);
      return;
    }
    for (const l of lines) store.addSample(l, 'pasted');
    $('teachBox').value = '';
    toast(`Added ${lines.length} sample${lines.length === 1 ? '' : 's'}`);
    studyNow();
  });
  $('studyBtn').addEventListener('click', () => studyNow());
  let mirrorArmed = 0;
  $('resetMirror').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (!mirrorArmed) {
      b.textContent = 'Tap again to reset';
      mirrorArmed = setTimeout(() => {
        mirrorArmed = 0;
        b.textContent = 'Reset the mirror';
      }, 4000);
      return;
    }
    clearTimeout(mirrorArmed);
    mirrorArmed = 0;
    b.textContent = 'Reset the mirror';
    store.resetMirror();
    toast('Mirror reset to the starting profile');
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    send(msg.value);
  });
  msg.addEventListener('focus', noteActivity);

  function toggleMic() {
    unlock();
    noteActivity();
    if (listener.mode === 'command') {
      listener.stop();
      return;
    }
    speaker.stop();
    if (current) {
      current.abort();
      current = null;
      busy = false;
    }
    listener.listenOnce();
  }
  micBtn.addEventListener('click', toggleMic);

  // ---------- settings ----------
  const panel = $('panel');
  const settingsBtn = $('btnSettings');
  function openSettings(focusId) {
    if (!$('vaultPanel').hidden) closeVault();
    fillSettings();
    panel.hidden = false;
    settingsBtn.setAttribute('aria-expanded', 'true');
    coverCheck();
    const el = focusId ? $(focusId) : $('setName');
    setTimeout(() => el && el.focus(), 30);
  }
  function closeSettings() {
    panel.hidden = true;
    settingsBtn.setAttribute('aria-expanded', 'false');
    coverCheck();
    settingsBtn.focus();
    setHint();
  }
  settingsBtn.addEventListener('click', () => (panel.hidden ? openSettings() : closeSettings()));
  $('btnClose').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!panel.hidden) closeSettings();
    else if (!$('vaultPanel').hidden) closeVault();
  });

  function fillVoices() {
    const sel = $('setVoice');
    sel.textContent = '';
    const voices = speaker.sortedVoices();
    if (!voices.length) {
      sel.append(new Option('Default voice', ''));
    }
    for (const v of voices) sel.append(new Option(`${v.name} (${v.lang})`, v.voiceURI));
    sel.value = dev.voiceURI && voices.some((v) => v.voiceURI === dev.voiceURI) ? dev.voiceURI : voices[0]?.voiceURI || '';
  }
  function fillMemory() {
    const list = $('memList');
    list.textContent = '';
    $('memNote').textContent = store.memory.length
      ? `${store.memory.length} thing${store.memory.length === 1 ? '' : 's'} remembered${mode === 'cloud' ? ', synced across your devices' : ' on this device'}.`
      : `Nothing yet. Tell ${store.profile.assistantName} to remember something.`;
    for (const m of store.memory) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = m.text;
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `Forget: ${m.text}`);
      b.textContent = '×';
      b.onclick = () => store.removeMemory(m.id);
      li.append(span, b);
      list.append(li);
    }
  }
  function fillSettings(fromSync = false) {
    const p = store.profile;
    const keep = (id, v) => {
      const el = $(id);
      if (fromSync && document.activeElement === el) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    };
    keep('setName', p.assistantName);
    keep('setUser', p.userName);
    keep('setPersona', p.personality || fillUser(DEFAULT_PERSONALITY, p.userName));
    keep('setDeep', p.deep);
    keep('setBeard', p.beard !== false);
    keep('setHair', p.hair !== false);
    keep('setMute', dev.muted);
    keep('setEngine', dev.engine);
    keep('setPitch', dev.pitch);
    keep('setRate', dev.rate);
    keep('setElKey', dev.elevenKey);
    keep('setElVoice', dev.elevenVoice);
    keep('setElModel', dev.elevenModel);
    keep('setKey', dev.apiKey);
    keep('setWeb', dev.web);
    keep('setWake', dev.wake);
    $('listenGroup').hidden = !canListen;
    const modelSel = $('setModel');
    if (!modelSel.options.length) for (const m of models) modelSel.append(new Option(m.label, m.id));
    modelSel.value = dev.model;
    fillVoices();
    showEngine();
    keep('setLook', face.look);
    $('faceOpts').hidden = face.look !== 'face';
    const sw = $('setPalette');
    sw.textContent = '';
    const current = PALETTES[p.palette] ? p.palette : DEFAULT_PALETTE;
    for (const [key, pal] of Object.entries(PALETTES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(current === key));
      b.textContent = pal.label;
      b.style.background = `linear-gradient(160deg, ${pal.stops.join(', ')})`;
      b.onclick = () => store.setProfile({ palette: key });
      sw.append(b);
    }
    fillMemory();
    fillMirror(fromSync);
  }
  function showEngine() {
    const eleven = mode === 'web' && dev.engine === 'eleven';
    $('elevenVoice').hidden = !eleven;
    $('deviceVoice').hidden = eleven;
  }

  const onProfileInput = (id, key, transform = (v) => v) => {
    let t = 0;
    $(id).addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = transform($(id).value);
        if (v !== null) store.setProfile({ [key]: v });
      }, 500);
    });
  };
  onProfileInput('setName', 'assistantName', (v) => v.trim().slice(0, 24) || null);
  onProfileInput('setUser', 'userName', (v) => v.trim().slice(0, 40) || null);
  onProfileInput('setPersona', 'personality', (v) => {
    const t = v.trim();
    return t && t !== fillUser(DEFAULT_PERSONALITY, store.profile.userName) ? t : null;
  });
  $('resetPersona').addEventListener('click', () => {
    $('setPersona').value = fillUser(DEFAULT_PERSONALITY, store.profile.userName);
    store.setProfile({ personality: '' });
  });
  $('setLook').addEventListener('change', () => {
    const look = $('setLook').value;
    store.setProfile({ look });
    if (face.orbFailed && look === 'orb') toast('This device can\u2019t show the 3D orb, so it\u2019s using the hologram head.', true);
  });
  for (const [id, key] of [['setDeep', 'deep'], ['setBeard', 'beard'], ['setHair', 'hair']]) {
    $(id).addEventListener('change', () => store.setProfile({ [key]: $(id).checked }));
  }
  const devInput = (id, key, ev = 'input', parse = (el) => el.value) => {
    $(id).addEventListener(ev, () => {
      dev[key] = parse($(id));
      saveDev();
      applyVoice();
      setHint();
    });
  };
  devInput('setMute', 'muted', 'change', (el) => el.checked);
  devInput('setEngine', 'engine', 'change');
  devInput('setVoice', 'voiceURI', 'change');
  devInput('setPitch', 'pitch', 'input', (el) => parseFloat(el.value));
  devInput('setRate', 'rate', 'input', (el) => parseFloat(el.value));
  devInput('setElKey', 'elevenKey', 'change', (el) => el.value.trim());
  devInput('setElVoice', 'elevenVoice', 'change', (el) => el.value.trim());
  devInput('setElModel', 'elevenModel', 'change');
  devInput('setKey', 'apiKey', 'change', (el) => el.value.trim());
  devInput('setModel', 'model', 'change');
  devInput('setWeb', 'web', 'change', (el) => el.checked);
  devInput('setWake', 'wake', 'change', (el) => el.checked);
  $('setEngine').addEventListener('change', showEngine);
  $('setWake').addEventListener('change', () => {
    unlock();
    listener.setWake(dev.wake);
    setStatus(dev.wake ? 'ears' : 'idle');
  });
  // ---------- voice design (ElevenLabs) ----------
  $('vdDesc').value = local.get('vdDesc', ZB_VOICE_DESCRIPTION);
  $('vdText').value = local.get('vdText', ZB_VOICE_SAMPLE);
  $('vdDesc').addEventListener('change', () => local.set('vdDesc', $('vdDesc').value));
  $('vdText').addEventListener('change', () => local.set('vdText', $('vdText').value));
  let previewAudio = null;
  $('vdMake').addEventListener('click', async () => {
    const b = $('vdMake');
    const key = $('setElKey').value.trim() || dev.elevenKey;
    const description = $('vdDesc').value.trim();
    let text = $('vdText').value.trim();
    if (!key) {
      toast('Paste your ElevenLabs API key above first.', true);
      $('setElKey').focus();
      return;
    }
    if (description.length < 20) {
      toast('Describe the voice in a sentence or two.', true);
      return;
    }
    if (text.length < 100) text = `${text} ${ZB_VOICE_SAMPLE}`.trim().slice(0, 1000);
    b.disabled = true;
    b.textContent = 'Designing\u2026';
    const list = $('vdList');
    list.textContent = '';
    try {
      const previews = await designVoices({ key, description, text });
      if (!previews.length) throw new Error('ElevenLabs returned no voices. Try again.');
      const played = new Set();
      previews.forEach((p, i) => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `Voice ${i + 1}${p.seconds ? ` \u00b7 ${Math.round(p.seconds)}s` : ''}`;
        const row = document.createElement('div');
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'btn ghost';
        play.textContent = 'Play';
        play.onclick = () => {
          unlock();
          speaker.stop();
          previewAudio?.pause();
          previewAudio = new Audio(p.audio);
          previewAudio.play().catch(() => toast('Tap Play again to hear it.', true));
          played.add(p.id);
        };
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'btn';
        use.textContent = 'Use this one';
        use.onclick = async () => {
          use.disabled = true;
          use.textContent = 'Saving\u2026';
          try {
            const voiceId = await saveDesignedVoice({
              key, name: store.profile.assistantName || 'ZB', description, id: p.id,
              others: [...played].filter((x) => x !== p.id),
            });
            Object.assign(dev, { engine: 'eleven', elevenKey: key, elevenVoice: voiceId, elevenModel: 'eleven_v3' });
            saveDev();
            applyVoice();
            fillSettings(true);
            list.textContent = '';
            toast(`${store.profile.assistantName}'s voice is set`);
            sayLocal(`Sak pase, ${store.profile.userName}! This my voice now. How I sound?`, 'happy');
          } catch (e) {
            toast(e.message || 'Couldn\u2019t save that voice.', true);
            use.disabled = false;
            use.textContent = 'Use this one';
          }
        };
        row.append(play, use);
        li.append(label, row);
        list.append(li);
      });
    } catch (e) {
      toast(e.message || 'Voice design failed. Try again.', true);
    } finally {
      b.disabled = false;
      b.textContent = 'Make 3 voices';
    }
  });

  $('previewVoice').addEventListener('click', () => {
    unlock();
    speaker.stop();
    const p = store.profile;
    sayLocal(`Hey ${p.userName}, it's ${p.assistantName}. This is what I sound like.`, 'confident');
  });
  $('clearChat').addEventListener('click', () => {
    store.clearChat();
    toast('Chat history cleared');
  });
  let eraseArmed = 0;
  $('clearMem').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (!eraseArmed) {
      b.textContent = 'Tap again to erase';
      eraseArmed = setTimeout(() => {
        eraseArmed = 0;
        b.textContent = 'Erase all memories';
      }, 4000);
      return;
    }
    clearTimeout(eraseArmed);
    eraseArmed = 0;
    b.textContent = 'Erase all memories';
    store.clearMemory();
    toast('All memories erased');
  });

  // ---------- clock ----------
  const tick = () => {
    $('roTime').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 10000);

  face.setMood('neutral');
  setStatus('idle');
  return { face, speaker, listener, store, send };
}
