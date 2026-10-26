// Runs ZB's voice model off the main thread so the orb never stutters while he talks.
// Messages in:  init {manifest, half, wasm} · say {id, text, speaker, accent, rate} · cancel {upTo}
// Messages out: ready · failed {message} · audio {id, pcm, sampleRate} · skipped {id} · error {id, message}
import * as ort from 'onnxruntime-web/wasm';
import { phonemize } from 'phonemizer';
import { toPhonemes, toIds } from './zbspeech.js';

let session = null;
let manifest = null;
let cancelThrough = 0;
const jobs = [];
let working = false;

// float16 -> float32 for every possible 16-bit pattern
function halfTable() {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    t[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return t;
}

async function init(m) {
  manifest = m.manifest;
  // the weights arrive float16 with high bytes first, then low bytes; lay them out as the graph expects
  const half = m.half;
  const n = half.length / 2;
  const table = halfTable();
  const data = new Float32Array(manifest.dataBytes / 4);
  let k = 0;
  for (const [offset, count] of manifest.tensors) {
    const base = offset / 4;
    for (let i = 0; i < count; i++, k++) data[base + i] = table[(half[k] << 8) | half[n + k]];
  }
  const bin = atob(manifest.graph);
  const graph = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) graph[i] = bin.charCodeAt(i);

  ort.env.wasm.numThreads = 1; // pages here aren't cross-origin isolated, so no threads
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = m.wasm;
  ort.env.wasm.wasmPaths = { mjs: new URL('ort-wasm-simd-threaded.js', self.location.href).href };
  session = await ort.InferenceSession.create(graph, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: 'zb.data', data: new Uint8Array(data.buffer) }],
  });
}

async function synth({ text, speaker, accent, rate }) {
  const ipa = await toPhonemes(text, { espeak: (t) => phonemize(t, 'en-us'), accent });
  const ids = toIds(ipa, manifest.phonemeIds);
  if (ids.length < 4) return new Float32Array(0);
  const inf = manifest.inference;
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', new Float32Array([inf.noise_scale, inf.length_scale / (rate || 1), inf.noise_w]), [3]),
  };
  if (manifest.speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker || 0)]), [1]);
  const out = await session.run(feeds);
  const audio = out[session.outputNames[0]].data;
  return trimSilence(audio);
}

// The model pads a little silence at both ends; keep a few milliseconds so words don't clip.
function trimSilence(a) {
  const th = 0.008;
  let s = 0;
  let e = a.length;
  while (s < e && Math.abs(a[s]) < th) s++;
  while (e > s && Math.abs(a[e - 1]) < th) e--;
  const pad = 600;
  return a.slice(Math.max(0, s - pad), Math.min(a.length, e + pad));
}

async function pump() {
  if (working) return;
  working = true;
  while (jobs.length) {
    const job = jobs.shift();
    if (job.id <= cancelThrough) {
      postMessage({ type: 'skipped', id: job.id });
      continue;
    }
    try {
      const pcm = await synth(job);
      postMessage({ type: 'audio', id: job.id, pcm, sampleRate: manifest.sampleRate }, [pcm.buffer]);
    } catch (e) {
      postMessage({ type: 'error', id: job.id, message: String(e?.message || e) });
    }
  }
  working = false;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      await init(m);
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'failed', message: String(err?.message || err) });
    }
  } else if (m.type === 'say') {
    jobs.push(m);
    pump();
  } else if (m.type === 'cancel') {
    cancelThrough = Math.max(cancelThrough, m.upTo);
  }
};
