// Voice: speaking (device voice or ElevenLabs) with a lip-sync timeline, and listening.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => performance.now() / 1000;

// ---------- visemes: mouth shapes per letter ----------
const V = (open, wide) => ({ open, wide });
const REST_V = V(0.04, 0);
const VIS = {
  a: V(0.8, 0.25), e: V(0.5, 0.6), i: V(0.32, 0.75), y: V(0.3, 0.7),
  o: V(0.62, -0.7), u: V(0.3, -0.95), w: V(0.2, -0.9), q: V(0.25, -0.8),
  m: V(0, 0.05), b: V(0, 0.05), p: V(0, 0.05),
  f: V(0.1, 0.25), v: V(0.12, 0.25),
  l: V(0.35, 0.3), n: V(0.28, 0.3), t: V(0.26, 0.35), d: V(0.3, 0.35),
  s: V(0.16, 0.55), z: V(0.18, 0.55), c: V(0.24, 0.45), k: V(0.32, 0.3), g: V(0.32, 0.3),
  h: V(0.45, 0.2), r: V(0.3, -0.3), j: V(0.28, -0.25), x: V(0.25, 0.45),
};
const PAIRS = { th: V(0.2, 0.3), sh: V(0.24, -0.45), ch: V(0.24, -0.45), oo: VIS.u, ee: VIS.i, ou: V(0.5, -0.6), ow: V(0.6, -0.5) };

function visemeOf(ch) {
  if (!ch) return REST_V;
  const c = ch.toLowerCase();
  if (VIS[c]) return VIS[c];
  if (c >= '0' && c <= '9') return V(0.4, 0.3);
  return REST_V;
}

class Timeline {
  constructor(items) {
    this.items = items;
    this.dur = items.length ? items[items.length - 1].t1 : 0;
    this.k = 0;
  }
  // first item that starts at or after a character index
  byChar(ci) {
    for (const it of this.items) if (it.ci >= ci) return it;
    return null;
  }
  at(t) {
    const items = this.items;
    if (!items.length) return REST_V;
    let k = this.k;
    if (k >= items.length || items[k].t0 > t) k = 0;
    while (k < items.length - 1 && items[k].t1 <= t) k++;
    this.k = k;
    const it = items[k];
    if (t > it.t1) return REST_V;
    // coarticulation: lean into the next shape near the end of this one
    const nx = items[k + 1];
    const p = (t - it.t0) / Math.max(0.001, it.t1 - it.t0);
    if (nx && p > 0.55) {
      const w = (p - 0.55) / 0.45 * 0.6;
      return V(it.v.open + (nx.v.open - it.v.open) * w, it.v.wide + (nx.v.wide - it.v.wide) * w);
    }
    return it.v;
  }
}

function charsToItems(chars, timeOf) {
  const items = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const pair = (ch + (chars[i + 1] || '')).toLowerCase();
    let v = visemeOf(ch);
    let span = 1;
    if (PAIRS[pair]) {
      v = PAIRS[pair];
      span = 2;
    }
    if (ch === ' ') v = V(0.06, 0);
    if (/[,;:.!?—-]/.test(ch)) v = REST_V;
    const [t0, t1] = timeOf(i, span);
    items.push({ t0, t1, v, ci: i });
    i += span - 1;
  }
  return items;
}

function estimateTimeline(text, rate = 1) {
  const base = 0.066 / rate;
  let t = 0;
  const chars = [...text];
  return new Timeline(
    charsToItems(chars, (i, span) => {
      const ch = chars[i];
      let d = base * span * (span > 1 ? 0.8 : 1);
      if (/[aeiou]/i.test(ch)) d *= 1.35;
      if (ch === ' ') d = base * 0.7;
      if (/[,;:—]/.test(ch)) d = 0.22 / rate;
      if (/[.!?]/.test(ch)) d = 0.32 / rate;
      const t0 = t;
      t += d;
      return [t0, t];
    }),
  );
}

function timelineFromAlignment(al) {
  const chars = al.characters || [];
  const st = al.character_start_times_seconds || [];
  const en = al.character_end_times_seconds || [];
  return new Timeline(charsToItems(chars, (i, span) => [st[i] || 0, en[i + span - 1] || en[i] || st[i] || 0]));
}

// Make text pleasant to hear: no markdown, links or emoji.
export function speakable(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_#`>~|]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\p{Extended_Pictographic}/gu, '')
    // Kreyòl short pronouns read as letters ("double-u"), so speak the full forms
    .replace(/(^|[\s(])w(?=[\s,.!?;:)]|$)/gi, '$1ou')
    .replace(/(^|[\s(])m(?=[\s,.!?;:)]|$)/gi, '$1mwen')
    .replace(/(^|[\s(])n(?=[\s,.!?;:)]|$)/gi, '$1nou')
    .replace(/\s+/g, ' ')
    .trim();
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Voices that tend to sound good for this character, best first. Users can pick any.
const PREFERRED = [
  /Andrew.*(Natural|Online)/i, /Brian.*(Natural|Online)/i, /Christopher.*(Natural|Online)/i, /Guy.*(Natural|Online)/i,
  /Davis/i, /Roger/i, /Steffan/i, /Eric/i, /Aaron/i, /Evan/i, /Nathan/i, /Reed/i, /Alex\b/i, /Daniel/i,
  /Google US English/i, /Tom\b/i,
];

export class Speaker {
  constructor(events = {}) {
    this.ev = events;
    this.queue = [];
    this.busy = false;
    this.cur = null;
    this.gen = 0;
    this.cfg = {
      engine: 'device', voiceURI: '', pitch: 0.92, rate: 1, muted: false,
      elevenKey: '', elevenVoice: '', elevenModel: 'eleven_flash_v2_5',
    };
    this.synth = window.speechSynthesis || null;
    this.voices = [];
    this.amp = 0;
    if (this.synth) {
      const load = () => {
        this.voices = this.synth.getVoices().filter((v) => /^en/i.test(v.lang));
        this.ev.onVoices?.(this.voices);
      };
      load();
      this.synth.addEventListener?.('voiceschanged', load);
    }
  }

  configure(cfg) {
    Object.assign(this.cfg, cfg);
  }

  get speaking() {
    return this.busy;
  }

  // Browsers only allow sound after a tap or click: call this from one.
  unlock() {
    this._ensureAudio();
    try {
      this.ac?.resume?.();
    } catch (e) {
      /* ignore */
    }
    if (this.synth && !this._unlocked) {
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        this.synth.speak(u);
      } catch (e) {
        /* ignore */
      }
    }
    this._unlocked = true;
  }

  _ensureAudio() {
    if (this.ac) return this.ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      this.ac = new AC();
      this.analyser = this.ac.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.ac.destination);
      this.ampBuf = new Float32Array(this.analyser.fftSize);
    } catch (e) {
      this.ac = null;
    }
    return this.ac;
  }

  sortedVoices() {
    const score = (v) => {
      // Caribbean English voices first when a device has them, then the preferred list
      if (/en-(JM|TT|BS|BB)/i.test(v.lang) || /Jamaica|Trinidad|Caribbean|Haiti/i.test(v.name)) return -1;
      const i = PREFERRED.findIndex((re) => re.test(v.name));
      return (i < 0 ? 100 : i) + (/en-US/i.test(v.lang) ? 0 : 50);
    };
    return [...this.voices].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  }

  _pickVoice() {
    if (!this.voices.length && this.synth) this.voices = this.synth.getVoices().filter((v) => /^en/i.test(v.lang));
    if (this.cfg.voiceURI) {
      const v = this.voices.find((x) => x.voiceURI === this.cfg.voiceURI);
      if (v) return v;
    }
    return this.sortedVoices()[0] || null;
  }

  say(text, meta = {}) {
    text = speakable(text);
    if (!text) return;
    const item = { text, meta, audio: null };
    const c = this.cfg;
    if (!c.muted && c.engine === 'eleven' && c.elevenKey && c.elevenVoice) {
      item.audio = this._fetchEleven(text).catch((error) => ({ error }));
    }
    this.queue.push(item);
    this._pump();
  }

  stop() {
    this.queue = [];
    this.gen++;
    try {
      this.synth?.cancel();
    } catch (e) {
      /* ignore */
    }
    if (this.src) {
      try {
        this.src.stop();
      } catch (e) {
        /* ignore */
      }
      this.src = null;
    }
    const was = this.busy;
    this.cur = null;
    this.busy = false;
    if (was) this.ev.onIdle?.();
  }

  async _pump() {
    if (this.busy) return;
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    const gen = this.gen;
    this.ev.onStart?.(item);
    try {
      if (this.cfg.muted) await this._silent(item, gen);
      else if (item.audio) {
        const r = await item.audio;
        if (gen !== this.gen) return;
        if (r.error) {
          this.ev.onError?.(r.error);
          await this._device(item, gen);
        } else await this._play(r, gen);
      } else await this._device(item, gen);
    } catch (e) {
      this.ev.onError?.(e);
    }
    if (gen !== this.gen) return;
    this.cur = null;
    this.busy = false;
    if (this.queue.length) this._pump();
    else this.ev.onIdle?.();
  }

  // Mouth moves, no sound (muted mode).
  _silent(item, gen) {
    const tl = estimateTimeline(item.text, this.cfg.rate);
    this.cur = { tl, start: now(), shift: 0, kind: 'device' };
    return new Promise((res) => setTimeout(res, tl.dur * 1000 + 150)).then(() => gen);
  }

  _device(item, gen) {
    if (!this.synth) return this._silent(item, gen);
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(item.text);
      const v = this._pickVoice();
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      }
      u.pitch = this.cfg.pitch;
      u.rate = this.cfg.rate;
      const tl = estimateTimeline(item.text, this.cfg.rate);
      let done = false;
      let guard = 0;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      u.onstart = () => {
        if (gen === this.gen) this.cur = { tl, start: now(), shift: 0, kind: 'device' };
      };
      u.onboundary = (e) => {
        if (!this.cur || gen !== this.gen || (e.name && e.name !== 'word')) return;
        const it = tl.byChar(e.charIndex);
        if (it) this.cur.shift = now() - this.cur.start - it.t0;
        this.ev.onWord?.();
      };
      u.onend = finish;
      u.onerror = finish;
      guard = setTimeout(finish, (tl.dur * 2.5 + 5) * 1000);
      this._utter = u; // Chrome drops events for utterances that get garbage-collected
      try {
        this.synth.resume();
      } catch (e) {
        /* ignore */
      }
      this.synth.speak(u);
      // some engines never fire onstart; start the clock anyway
      setTimeout(() => {
        if (!this.cur && !done && gen === this.gen) this.cur = { tl, start: now(), shift: 0, kind: 'device' };
      }, 300);
    });
  }

  async _fetchEleven(text) {
    const { elevenKey, elevenVoice, elevenModel } = this.cfg;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoice.trim())}/with-timestamps?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey.trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: elevenModel || 'eleven_flash_v2_5',
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.detail?.message || j?.detail?.status || '';
      } catch (e) {
        /* ignore */
      }
      if (res.status === 401) throw new Error('ElevenLabs didn’t accept the API key. Check it in Settings.');
      if (res.status === 404) throw new Error('ElevenLabs couldn’t find that Voice ID. Check it in Settings.');
      throw new Error(`ElevenLabs error ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const j = await res.json();
    const ac = this._ensureAudio();
    if (!ac) throw new Error('This browser can\u2019t play generated audio.');
    let bytes;
    if (j.audio_base64) bytes = b64ToBytes(j.audio_base64);
    else {
      // some models occasionally return timing without audio: fetch the audio on its own
      const plain = await fetch(url.replace('/with-timestamps', ''), {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: elevenModel || 'eleven_flash_v2_5' }),
      });
      if (!plain.ok) throw new Error(`ElevenLabs error ${plain.status}`);
      bytes = new Uint8Array(await plain.arrayBuffer());
    }
    const buffer = await ac.decodeAudioData(bytes.buffer.slice(0));
    const al = j.alignment || j.normalized_alignment;
    return { buffer, tl: al ? timelineFromAlignment(al) : estimateTimeline(text, 1) };
  }

  async _play({ buffer, tl }, gen) {
    const ac = this.ac;
    if (ac.state === 'suspended') await ac.resume().catch(() => {});
    if (gen !== this.gen) return;
    await new Promise((resolve) => {
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      const t0 = ac.currentTime + 0.03;
      src.onended = () => {
        if (this.src === src) this.src = null;
        resolve();
      };
      src.start(t0);
      this.src = src;
      this.cur = { tl, kind: 'audio', acStart: t0 };
    });
  }

  _amp() {
    this.analyser.getFloatTimeDomainData(this.ampBuf);
    let s = 0;
    for (let i = 0; i < this.ampBuf.length; i++) s += this.ampBuf[i] * this.ampBuf[i];
    const rms = Math.sqrt(s / this.ampBuf.length);
    this.amp += (rms - this.amp) * 0.5;
    return this.amp;
  }

  // Current mouth shape for the face, or null when silent.
  mouth() {
    const c = this.cur;
    if (!c || !this.busy) return null;
    let t;
    let amp = null;
    if (c.kind === 'audio') {
      t = this.ac.currentTime - c.acStart;
      amp = this._amp();
    } else t = now() - c.start - c.shift;
    if (t < 0) return { open: 0.02, wide: 0, energy: 0 };
    const v = c.tl.at(t);
    let open = v.open;
    let wide = v.wide;
    if (amp !== null) open *= clamp(0.3 + amp * 6, 0.15, 1.25);
    else if (t > c.tl.dur + 0.2) {
      // the estimate ran out but the voice is still talking: keep the jaw moving
      const b = 0.5 + 0.5 * Math.sin(t * 16.5);
      open = 0.1 + 0.3 * b;
      wide = 0.25 * Math.sin(t * 7);
    }
    return { open, wide, energy: clamp(open * 1.4, 0, 1) };
  }
}

// ---------- listening ----------
function findWake(text, word) {
  const w = word.toLowerCase().trim();
  if (!w) return { i: -1, len: 0 };
  const forms = [w];
  if (w === 'jarvis') forms.push('jervis', 'javis', 'jarvas', 'jarviss');
  if (w === 'zb') forms.push('z b', 'z.b', 'z-b', 'zee bee', 'zeebee', 'z bee', 'zbee', 'zebe', 'zebi', 'zibi');
  for (const f of forms) {
    const i = text.indexOf(f);
    if (i >= 0) return { i, len: f.length };
  }
  return { i: -1, len: 0 };
}

export class Listener {
  constructor(events = {}) {
    this.ev = events;
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.mode = 'off';
    this.wakeOn = false;
    this.paused = false;
    this.wakeWord = 'jarvis';
    this.lang = navigator.language || 'en-US';
  }

  get supported() {
    return !!this.SR;
  }

  listenOnce() {
    this._start('command');
  }

  setWake(on) {
    this.wakeOn = on;
    if (on && this.mode === 'off' && !this.paused) this._start('wake');
    if (!on && this.mode === 'wake') this.stop();
  }

  stop() {
    this.mode = 'off';
    this._kill();
    this.ev.onState?.('off');
  }

  // Stop hearing ourselves while we talk.
  pause() {
    this.paused = true;
    if (this.mode === 'wake') {
      this._kill();
      this.mode = 'off';
    }
  }

  resume() {
    this.paused = false;
    if (this.wakeOn && this.mode === 'off') this._start('wake');
  }

  _kill() {
    const r = this.rec;
    this.rec = null;
    if (!r) return;
    r.onend = r.onresult = r.onerror = null;
    try {
      r.abort();
    } catch (e) {
      /* ignore */
    }
  }

  _start(mode) {
    if (!this.SR) return;
    this._kill();
    this.mode = mode;
    const r = new this.SR();
    this.rec = r;
    r.lang = this.lang;
    r.interimResults = true;
    r.continuous = mode === 'wake';
    r.maxAlternatives = 1;
    let finalText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (mode === 'command') {
        this.ev.onInterim?.((finalText + interim).trim());
        return;
      }
      const heard = `${finalText} ${interim}`;
      const hit = findWake(heard.toLowerCase(), this.wakeWord);
      if (hit.i >= 0 && finalText) {
        const after = heard.slice(hit.i + hit.len).replace(/^[\s,.!?]+/, '').trim();
        this._kill();
        this.mode = 'off';
        if (after.length > 1) this.ev.onFinal?.(after);
        else {
          this.ev.onWake?.();
          this._start('command');
        }
        return;
      }
      if (finalText && hit.i < 0) finalText = '';
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wakeOn = false;
        this.mode = 'off';
        this.ev.onError?.('blocked');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') this.ev.onError?.(e.error);
    };
    r.onend = () => {
      const m = this.mode;
      this.rec = null;
      if (m === 'command') {
        this.mode = 'off';
        this.ev.onState?.('off');
        const text = finalText.trim();
        if (text) this.ev.onFinal?.(text);
        else this.ev.onEmpty?.();
      } else if (m === 'wake') {
        this.mode = 'off';
        setTimeout(() => {
          if (this.wakeOn && !this.paused && this.mode === 'off') this._start('wake');
        }, 350);
      }
    };
    try {
      r.start();
      this.ev.onState?.(mode);
    } catch (e) {
      this.mode = 'off';
      this.ev.onError?.(String(e?.message || e));
    }
  }
}

// ---------- ElevenLabs Voice Design: make an original voice from a description ----------
const EL = 'https://api.elevenlabs.io';

export const ZB_VOICE_DESCRIPTION =
  'Perfect audio quality. English with a Haitian-American accent from North Miami, South Florida. Young Black man in his twenties, Haitian Creole rhythm and vowels blended with South Florida slang. Laid-back, confident and warm, slightly raspy mid-low voice, relaxed melodic cadence. Sounds like a loyal, sharp right-hand man.';
export const ZB_VOICE_SAMPLE =
  "Sak pase, boss! ZB on deck. I already looked at what you got going on today, and basically we good, ya feel me. You got that call at three, so I'ma remind you at two forty-five. Oh and real quick, it's supposed to rain later, so don't leave the window open. N ap boule. What's the move?";

async function elevenError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.detail?.message || j?.detail?.status || (typeof j?.detail === 'string' ? j.detail : '');
  } catch (e) {
    /* ignore */
  }
  if (res.status === 401) return new Error('ElevenLabs didn’t accept the API key.');
  if (res.status === 402 || /quota|credit/i.test(detail)) return new Error('Your ElevenLabs plan is out of credits for this.');
  return new Error(`ElevenLabs error ${res.status}${detail ? `: ${detail}` : ''}`);
}

// Returns [{ id, audio, mediaType, seconds }] previews to audition.
export async function designVoices({ key, description, text }) {
  const res = await fetch(`${EL}/v1/text-to-voice/design?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_description: description.trim(), text: text.trim(), model_id: 'eleven_ttv_v3' }),
  });
  if (!res.ok) throw await elevenError(res);
  const j = await res.json();
  return (j.previews || []).map((p) => ({
    id: p.generated_voice_id,
    audio: `data:${p.media_type || 'audio/mpeg'};base64,${p.audio_base_64}`,
    seconds: p.duration_secs,
  }));
}

// Saves the chosen preview to the user's ElevenLabs account; returns its voice_id.
export async function saveDesignedVoice({ key, name, description, id, others = [] }) {
  const res = await fetch(`${EL}/v1/text-to-voice`, {
    method: 'POST',
    headers: { 'xi-api-key': key.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      voice_name: name,
      voice_description: description.trim(),
      generated_voice_id: id,
      played_not_selected_voice_ids: others,
      labels: { accent: 'Haitian-American', use_case: 'assistant' },
    }),
  });
  if (!res.ok) throw await elevenError(res);
  const v = await res.json();
  if (!v.voice_id) throw new Error('ElevenLabs saved the voice but returned no ID.');
  return v.voice_id;
}
