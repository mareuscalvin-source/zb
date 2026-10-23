// HoloFace: a 3D holographic head drawn on a 2D canvas.
// The head is a parametric surface (dot matrix) with facial features laid on its
// front as curves in "face space" (x right, y up, head ~2 units tall), then rotated
// and projected every frame. Expressions are a small rig of params eased toward targets.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------- head shape ----------
const RX = 0.74; // half width
const RY = 1.0; // half height (top of skull to chin)
const RZF = 0.84; // depth toward the face
const RZB = 1.02; // depth toward the back of the skull
const EYE_Y = 0.02;
const NOSE_Y = -0.39;
const MOUTH_Y = -0.6;

function widthAt(s) {
  if (s > -0.1) return 1;
  const t = clamp((-0.1 - s) / 0.9, 0, 1);
  return 1 - 0.32 * Math.pow(t, 1.3);
}
function ringAt(s) {
  const p = s < 0 ? 3 : 2.55;
  return Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), p)), 1 / p);
}

// Extra relief on the front of the face (nose, brow ridge, lips, chin, sockets).
function relief(x, y) {
  let z = 0;
  // nose: rises from the bridge to the tip, then tucks under
  const ny = clamp((0.12 - y) / (0.12 - (NOSE_Y + 0.12)), 0, 1);
  const tuck = y < NOSE_Y + 0.12 ? sstep(NOSE_Y - 0.02, NOSE_Y + 0.12, y) : 1;
  const nw = lerp(0.05, 0.095, ny);
  z += (0.025 + 0.2 * Math.pow(ny, 1.6)) * tuck * Math.exp(-(x * x) / (nw * nw)) * (y < 0.16 ? 1 : 0);
  // brow ridge
  z += 0.035 * Math.exp(-((y - 0.17) ** 2) / 0.004) * sstep(0.5, 0.2, Math.abs(x));
  // eye sockets
  for (const sx of [-0.27, 0.27]) z -= 0.04 * Math.exp(-((x - sx) ** 2) / 0.012 - ((y - EYE_Y) ** 2) / 0.006);
  // lips and chin
  z += 0.045 * Math.exp(-(x * x) / 0.05 - ((y - MOUTH_Y) ** 2) / 0.006);
  z += 0.04 * Math.exp(-(x * x) / 0.05 - ((y + 0.9) ** 2) / 0.012);
  // cheekbones
  for (const sx of [-0.4, 0.4]) z += 0.025 * Math.exp(-((x - sx) ** 2) / 0.02 - ((y + 0.12) ** 2) / 0.02);
  return z;
}

function faceZ(x, y) {
  const s = clamp(y / RY, -0.999, 0.999);
  const r = ringAt(s);
  const w = RX * r * widthAt(s);
  if (w <= 0.001) return 0;
  const sp = clamp(x / w, -1, 1);
  return r * RZF * Math.sqrt(1 - sp * sp) + relief(x, y);
}

// How much a point follows the jaw when the mouth opens.
function jawWeight(x, y) {
  if (y > MOUTH_Y + 0.01) return 0;
  const wy = sstep(0, 0.07, MOUTH_Y + 0.01 - y);
  const wx = clamp(1 - (Math.abs(x) - 0.12) / 0.55, 0, 1);
  return wy * wx;
}

// Hairline height (as s = y/RY) by longitude: crisp line-up at the forehead and temples.
const HAIRLINE = [
  [0, 0.8], [0.35, 0.81], [0.55, 0.84], [0.72, 0.8], [0.9, 0.56], [1.08, 0.38],
  [1.25, 0.12], [1.36, 0.08], [1.5, 0.3], [1.9, 0.18], [2.4, -0.2], [Math.PI, -0.42],
];
function hairlineAt(phi) {
  const a = Math.abs(phi);
  for (let i = 1; i < HAIRLINE.length; i++) {
    if (a <= HAIRLINE[i][0]) {
      const [a0, s0] = HAIRLINE[i - 1];
      const [a1, s1] = HAIRLINE[i];
      return lerp(s0, s1, (a - a0) / (a1 - a0));
    }
  }
  return -0.42;
}

// Short boxed beard + mustache in face space.
function inBeard(x, y) {
  const ax = Math.abs(x);
  // cheek line: from the sideburn down to just outside the mouth corners
  const cheekY = lerp(-0.52, -0.06, sstep(0.25, 0.66, ax));
  if (y > cheekY) {
    // mustache band
    return y < NOSE_Y - 0.05 && y > MOUTH_Y + 0.045 && ax < 0.24 - (y - (MOUTH_Y + 0.05)) * 0.4;
  }
  // keep the lips clear
  if ((x / 0.25) ** 2 + ((y - MOUTH_Y + 0.005) / 0.075) ** 2 < 1) return false;
  return y > -1.0;
}

// ---------- spline + expression tables ----------
// Catmull-Rom through control points of any dimension.
function spline(pts, seg = 5) {
  const out = [];
  const n = pts.length;
  const dim = pts[0].length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || pts[i + 1];
    for (let j = 0; j < seg; j++) {
      const t = j / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      const q = new Array(dim);
      for (let d = 0; d < dim; d++) {
        q[d] = 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3);
      }
      out.push(q);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

const REST = {
  lid: 1, cheek: 0, browL: 0, browR: 0, browInner: 0, browFurrow: 0,
  smile: 0, smirk: 0, wide: 0, open: 0,
  yawB: 0, pitchB: 0, rollB: 0, gazeBX: 0, gazeBY: 0,
};

export const MOODS = {
  neutral: {},
  happy: { smile: 0.85, cheek: 0.55, lid: 0.86, browL: 0.14, browR: 0.14, pitchB: -0.03 },
  amused: { smile: 0.5, smirk: 0.6, cheek: 0.35, lid: 0.88, browL: 0.32, browR: 0.02, rollB: -0.07 },
  laughing: { smile: 1, cheek: 0.85, lid: 0.5, browL: 0.25, browR: 0.25, open: 0.32, pitchB: -0.1 },
  thinking: { browFurrow: 0.25, browR: 0.35, smirk: 0.3, smile: -0.05, gazeBX: 0.55, gazeBY: 0.6, rollB: 0.07, yawB: 0.12, lid: 0.92 },
  surprised: { browL: 0.95, browR: 0.95, lid: 1.35, open: 0.3, wide: -0.5 },
  concerned: { browInner: 0.9, smile: -0.35, lid: 0.95, pitchB: 0.05 },
  serious: { browFurrow: 0.65, lid: 0.82, smile: -0.12, pitchB: 0.03 },
  confident: { smile: 0.4, smirk: 0.35, lid: 0.86, pitchB: -0.07, browL: 0.1 },
  listening: { browL: 0.2, browR: 0.24, lid: 1.06, rollB: 0.08 },
  sad: { browInner: 1, smile: -0.55, lid: 0.72, pitchB: 0.11, gazeBY: -0.45 },
  sleeping: { lid: 0, pitchB: 0.16, smile: 0.06 },
};

// ---------- the renderer ----------
export class HoloFace {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { beard: true, hair: true, ...opts };
    this.reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.setColor(opts.color || [111, 227, 255]);
    this.accent = [255, 179, 71];
    this.cur = { ...REST };
    this.tgt = { ...REST };
    this.mood = 'neutral';
    this.state = 'idle';
    this.mouthSource = null;
    this.level = 0; // external energy, e.g. listening pulse
    this.pointer = { x: 0, y: 0, until: 0 };
    this.view = { top: 0, bottom: 0 };
    this.time = 0;
    this.motion = { yaw: 0, pitch: 0, roll: 0, gx: 0, gy: 0, open: 0, wide: 0 };
    this.sacc = { x: 0, y: 0, next: 1 };
    this.blink = { next: 2, t: -1, double: false };
    this.browFlash = 0;
    this.nodKick = 0;
    this.glitch = { next: 8, t: -1 };
    this.wake = 1;
    this.motes = [];
    this._build();
    this._resize();
    if (window.ResizeObserver) new ResizeObserver(() => this._resize()).observe(canvas);
    else addEventListener('resize', () => this._resize());
    this._last = performance.now();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // ----- public API -----
  setColor(rgb) {
    this.color = rgb;
    this.rgb = `${rgb[0]},${rgb[1]},${rgb[2]}`;
    const w = rgb.map((c) => Math.round(lerp(c, 255, 0.55)));
    this.rgbHi = `${w[0]},${w[1]},${w[2]}`;
  }
  setOptions(o) {
    Object.assign(this.opts, o);
  }
  setMood(name) {
    if (!MOODS[name]) name = 'neutral';
    this.mood = name;
    this.tgt = { ...REST, ...MOODS[name] };
    if (name === 'surprised') this.browFlash = 1;
  }
  setState(state) {
    this.state = state;
    if (state === 'sleeping') this.setMood('sleeping');
    else if (this.mood === 'sleeping') this.setMood('neutral');
  }
  setViewport(top, bottom) {
    this.view = { top, bottom };
    this._layout();
  }
  lookAt(nx, ny, holdSec = 2.5) {
    this.pointer = { x: clamp(nx, -1, 1), y: clamp(ny, -1, 1), until: this.time + holdSec };
  }
  flashBrows() {
    this.browFlash = 1;
  }
  nod() {
    this.nodKick = 1;
  }

  // ----- geometry -----
  _build() {
    const R = rng(7);
    const grid = [];
    const hair = [];
    const beard = [];
    const LAT = 46;
    for (let i = 0; i <= LAT; i++) {
      const th = lerp(-Math.PI / 2 + 0.05, Math.PI / 2 - 0.04, i / LAT);
      const s = Math.sin(th);
      const ring = ringAt(s);
      const n = Math.max(8, Math.round(78 * ring));
      for (let j = 0; j < n; j++) {
        const phi = -Math.PI + (TAU * (j + (i % 2) * 0.5)) / n;
        const pt = this._surf(s, phi);
        const isHair = s > hairlineAt(phi);
        // keep the eye openings and mouth clean
        const front = Math.cos(phi) > 0.2;
        if (front) {
          const ex = Math.abs(pt.x) - 0.28;
          if ((ex / 0.17) ** 2 + ((pt.y - EYE_Y) / 0.075) ** 2 < 1) continue;
          if ((pt.x / 0.25) ** 2 + ((pt.y - MOUTH_Y) / 0.06) ** 2 < 1) continue;
        }
        const nrm = this._normal(s, phi, pt);
        grid.push([pt.x, pt.y, pt.z, isHair ? 1 : 0, front ? jawWeight(pt.x, pt.y) : 0, nrm[0], nrm[1], nrm[2]]);
      }
    }
    // hair: short cropped texture, random stipple over the scalp
    for (let k = 0; k < 4200; k++) {
      const s = lerp(-0.45, 0.995, Math.sqrt(R()));
      const phi = -Math.PI + TAU * R();
      if (s <= hairlineAt(phi) + 0.005) continue;
      const pt = this._surf(s, phi, 1.018 + R() * 0.03);
      hair.push([pt.x, pt.y, pt.z, R()]);
    }
    // beard: stipple on the lower face
    for (let k = 0; k < 4200 && beard.length < 850; k++) {
      const x = (R() * 2 - 1) * 0.7;
      const y = lerp(-1.0, -0.25, R());
      if (!inBeard(x, y)) continue;
      const s = y / RY;
      const w = RX * ringAt(s) * widthAt(s);
      if (Math.abs(x) > w * 0.97) continue;
      const z = faceZ(x, y) + 0.012 + R() * 0.012;
      beard.push([x, y, z, R(), jawWeight(x, y)]);
    }
    // neck, fading into motes
    const neck = [];
    for (let i = 0; i < 16; i++) {
      const y = lerp(-0.72, -1.75, i / 15);
      const n = 40;
      for (let j = 0; j < n; j++) {
        const a = (TAU * (j + (i % 2) * 0.5)) / n;
        neck.push([Math.sin(a) * 0.36, y, Math.cos(a) * 0.38 - 0.16, i / 15]);
      }
    }
    this.grid = grid;
    this.hair = hair;
    this.beard = beard;
    this.neck = neck;
    this.gridBuf = new Float32Array(grid.length * 3);
  }

  // outward surface normal by finite differences (includes facial relief)
  _normal(s, phi, p) {
    const e = 0.004;
    const a = this._surf(Math.min(0.999, s + e), phi);
    const b = this._surf(Math.max(-0.999, s - e), phi);
    const c = this._surf(s, phi + e);
    const d = this._surf(s, phi - e);
    const u = [a.x - b.x, a.y - b.y, a.z - b.z];
    const v = [c.x - d.x, c.y - d.y, c.z - d.z];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * p.x + n[1] * p.y + n[2] * p.z < 0) n = n.map((q) => -q);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  }

  _surf(s, phi, scale = 1) {
    const r = ringAt(s);
    const c = Math.cos(phi);
    const x = RX * r * widthAt(s) * Math.sin(phi) * scale;
    const y = s * RY * scale;
    let z = r * c * (c > 0 ? RZF : RZB) * scale;
    if (c > 0) z += relief(x, y) * clamp(c * 1.6, 0, 1);
    return { x, y, z };
  }

  _resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.cv.getBoundingClientRect();
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.cv.width = Math.round(this.W * dpr);
    this.cv.height = Math.round(this.H * dpr);
    this.dpr = dpr;
    this._layout();
  }

  _layout() {
    const top = this.view.top || 0;
    const bottom = this.view.bottom || 0;
    const free = Math.max(120, this.H - top - bottom);
    this.scale = Math.min(this.W * 0.3, free * 0.27);
    this.cx = this.W / 2;
    this.cy = top + free * 0.47;
  }

  // ----- animation -----
  _frame(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    if (!document.hidden && !this.paused) {
      this.time += dt;
      this._update(dt);
      this._draw();
    }
    requestAnimationFrame(this._frame);
  }

  _update(dt) {
    const t = this.time;
    const c = this.cur;
    const g = this.tgt;
    const ease = (k) => 1 - Math.exp(-dt * k);
    for (const k in c) c[k] += (g[k] - c[k]) * ease(k.endsWith('B') ? 3 : 7);

    const calm = this.reduced ? 0.35 : 1;
    const asleep = this.state === 'sleeping';
    this.wake += ((asleep ? 0.55 : 1) - this.wake) * ease(2);

    // mouth: speech source wins over the mood's resting shape
    const src = this.mouthSource ? this.mouthSource() : null;
    const speaking = !!src;
    const mOpen = speaking ? Math.max(c.open * 0.4, src.open) : c.open;
    const mWide = speaking ? lerp(c.wide, src.wide, 0.85) : c.wide;
    const energy = speaking ? src.energy || src.open : 0;
    this.motion.open += (mOpen - this.motion.open) * ease(speaking ? 26 : 10);
    this.motion.wide += (mWide - this.motion.wide) * ease(18);

    // head motion: idle drift + pointer + mood bias + speech beats
    const look = t < this.pointer.until;
    let yaw = calm * (0.09 * Math.sin(t * 0.31) + 0.05 * Math.sin(t * 0.73 + 1.3)) + c.yawB;
    let pitch = calm * (0.035 * Math.sin(t * 0.42 + 0.5) + 0.02 * Math.sin(t * 1.1)) + c.pitchB;
    let roll = calm * 0.03 * Math.sin(t * 0.27 + 2) + c.rollB;
    if (look) {
      yaw += this.pointer.x * 0.3;
      pitch -= this.pointer.y * 0.16;
    }
    if (speaking) {
      pitch += calm * energy * 0.035 * Math.sin(t * 5.3);
      yaw += calm * energy * 0.02 * Math.sin(t * 2.1 + 0.7);
    }
    if (this.state === 'thinking') {
      yaw += calm * 0.05 * Math.sin(t * 0.9);
      pitch -= 0.03;
    }
    this.nodKick = Math.max(0, this.nodKick - dt * 2.2);
    pitch += Math.sin((1 - this.nodKick) * Math.PI) * this.nodKick * 0.09;
    if (asleep) pitch += 0.015 * Math.sin(t * 1.3);
    const m = this.motion;
    m.yaw += (yaw - m.yaw) * ease(4);
    m.pitch += (pitch - m.pitch) * ease(4);
    m.roll += (roll - m.roll) * ease(3);

    // eyes: saccades, pointer tracking, thinking glance
    if (t > this.sacc.next) {
      this.sacc.x = (Math.random() * 2 - 1) * 0.35;
      this.sacc.y = (Math.random() * 2 - 1) * 0.2;
      this.sacc.next = t + 0.6 + Math.random() * 2.4;
      if (Math.random() < 0.4) this.sacc.x = this.sacc.y = 0;
    }
    let gx = c.gazeBX + this.sacc.x * (this.state === 'thinking' ? 0.3 : 1);
    let gy = c.gazeBY + this.sacc.y * 0.6;
    if (look && this.state !== 'thinking') {
      gx = this.pointer.x * 0.9;
      gy = this.pointer.y * 0.8;
    }
    if (this.state === 'listening' || speaking) {
      gx *= 0.4;
      gy *= 0.4;
    }
    m.gx += (gx - m.gx) * ease(16);
    m.gy += (gy - m.gy) * ease(16);

    // blinks
    let blinkClose = 0;
    if (t > this.blink.next && this.blink.t < 0) {
      this.blink.t = 0;
      this.blink.double = Math.random() < 0.15;
    }
    if (this.blink.t >= 0) {
      this.blink.t += dt;
      const d = 0.17;
      const p = this.blink.t / d;
      blinkClose = p < 1 ? Math.sin(p * Math.PI) : 0;
      if (p >= 1) {
        if (this.blink.double) {
          this.blink.double = false;
          this.blink.t = -0.0001;
          this.blink.next = t + 0.12;
        } else {
          this.blink.t = -1;
          this.blink.next = t + 2 + Math.random() * 3.8;
        }
      }
    }
    m.lid = asleep ? c.lid : c.lid * (1 - blinkClose);
    this.browFlash = Math.max(0, this.browFlash - dt * 1.8);

    // glitch scheduling
    if (!this.reduced) {
      if (t > this.glitch.next && this.glitch.t < 0) this.glitch.t = 0;
      if (this.glitch.t >= 0) {
        this.glitch.t += dt;
        if (this.glitch.t > 0.14) {
          this.glitch.t = -1;
          this.glitch.next = t + 7 + Math.random() * 10;
        }
      }
    }
    this.energy = energy;
  }

  // ----- drawing -----
  _matrix() {
    const { yaw, pitch, roll } = this.motion;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Ry(yaw) * Rx(pitch) * Rz(roll)
    this.M = [
      cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp,
      cp * sr, cp * cr, -sp,
      -sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp,
    ];
  }

  // project a model point; returns [sx, sy, zRot]
  _p(x, y, z, out) {
    const M = this.M;
    const X = M[0] * x + M[1] * y + M[2] * z;
    const Y = M[3] * x + M[4] * y + M[5] * z;
    const Z = M[6] * x + M[7] * y + M[8] * z;
    const D = 6;
    const f = this.scale * (D / (D - Z));
    out[0] = this.cx + X * f;
    out[1] = this.headY - Y * f;
    out[2] = Z;
    return out;
  }

  // facing (rotated normal z) of an ellipsoid-ish normal at a model point
  _facing(x, y, z) {
    const nx = x / (RX * RX);
    const ny = y / (RY * RY) * 0.6;
    const nz = z / (RZF * RZF);
    const l = Math.hypot(nx, ny, nz) || 1;
    const M = this.M;
    return (M[6] * nx + M[7] * ny + M[8] * nz) / l;
  }

  // face-space curve -> screen polyline (applies jaw drop when asked)
  _curve(pts, dz = 0, jaw = 0) {
    const out = [];
    const tmp = [0, 0, 0];
    for (const [x, y] of pts) {
      const yy = y - jaw * jawWeight(x, y);
      this._p(x, yy, faceZ(x, y) + dz, tmp);
      out.push([tmp[0], tmp[1]]);
    }
    return out;
  }

  _path(pts, close = false) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (close) ctx.closePath();
  }

  _glow(pts, width, alpha, close = false, hi = false) {
    if (alpha <= 0.01) return;
    const ctx = this.ctx;
    const rgb = hi ? this.rgbHi : this.rgb;
    this._path(pts, close);
    ctx.lineWidth = width * 3.2;
    ctx.strokeStyle = `rgba(${this.rgb},${alpha * 0.16})`;
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(${rgb},${alpha})`;
    ctx.stroke();
  }

  _draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const t = this.time;
    const float = (this.reduced ? 2 : 7) * Math.sin(t * 0.8);
    this.headY = this.cy + float;
    this._matrix();
    const S = this.scale;
    const wake = this.wake;
    const thinking = this.state === 'thinking';

    this._drawProjector(t);
    this._drawRings(t, thinking, 'back');

    ctx.globalCompositeOperation = 'lighter';
    const tmp = [0, 0, 0];
    const jaw = this.motion.open * 0.15;

    // neck
    for (const [x, y, z, fade] of this.neck) {
      this._p(x, y, z, tmp);
      const facing = this._facing(x, 0, z + 0.16);
      if (facing < -0.1) continue;
      const a = (0.06 + 0.3 * (1 - Math.abs(facing)) ** 2) * (1 - fade) * wake;
      ctx.fillStyle = `rgba(${this.rgb},${a})`;
      ctx.fillRect(tmp[0] - 0.7, tmp[1] - 0.7, 1.4, 1.4);
    }

    // scan band sweeping down the head
    const scanY = 1.15 - ((t * 0.32) % 1) * 2.6;

    // head dot matrix
    const hairOn = this.opts.hair;
    const M = this.M;
    // key light from upper left, in view space
    const LX = -0.45, LY = 0.55, LZ = 0.7;
    for (const [x, y0, z, isHair, jw, nx, ny, nz] of this.grid) {
      const y = y0 - jaw * jw;
      const facing = M[6] * nx + M[7] * ny + M[8] * nz;
      if (facing < -0.05) continue;
      this._p(x, y, z, tmp);
      const lum = Math.max(0, (M[0] * nx + M[1] * ny + M[2] * nz) * LX + (M[3] * nx + M[4] * ny + M[5] * nz) * LY + facing * LZ);
      const rim = Math.pow(1 - clamp(facing, 0, 1), 2.6);
      let a = 0.05 + 0.5 * rim + 0.38 * lum * lum;
      const band = Math.exp(-((y0 - scanY) ** 2) / 0.006);
      a += band * 0.4;
      if (isHair && hairOn) a *= 0.4;
      a *= wake;
      const sz = 1 + rim * 0.8 + lum * 0.6 + band * 0.8;
      ctx.fillStyle = `rgba(${band > 0.3 ? this.rgbHi : this.rgb},${a})`;
      ctx.fillRect(tmp[0] - sz / 2, tmp[1] - sz / 2, sz, sz);
    }

    // hair texture
    if (hairOn) {
      for (const [x, y, z, r] of this.hair) {
        const facing = this._facing(x, y, z);
        if (facing < -0.02) continue;
        this._p(x, y, z, tmp);
        const a = (0.16 + 0.34 * r) * (0.45 + 0.55 * clamp(facing + 0.3, 0, 1)) * wake;
        ctx.fillStyle = `rgba(${this.rgb},${a})`;
        ctx.fillRect(tmp[0] - 0.75, tmp[1] - 0.75, 1.5, 1.5);
      }
    }
    // beard texture
    if (this.opts.beard) {
      for (const [x, y0, z, r, jw] of this.beard) {
        const facing = this._facing(x, y0, z);
        if (facing < -0.02) continue;
        this._p(x, y0 - jaw * jw, z, tmp);
        const a = (0.2 + 0.4 * r) * (0.5 + 0.5 * clamp(facing + 0.2, 0, 1)) * wake;
        ctx.fillStyle = `rgba(${this.rgb},${a})`;
        ctx.fillRect(tmp[0] - 0.7, tmp[1] - 0.7, 1.4, 1.4);
      }
    }

    // outline / silhouette contour + hairline
    this._drawSilhouette(jaw, wake);
    this._drawContours(t, jaw, wake);

    // features
    this._drawEars(wake);
    this._drawEyes(t, wake);
    this._drawBrows(wake);
    this._drawNose(wake);
    this._drawMouth(jaw, wake);

    ctx.globalCompositeOperation = 'source-over';
    this._drawRings(t, thinking, 'front');
    this._drawMotes(t);
    if (this.glitch.t >= 0) this._drawGlitch();
    // keep a reference size for hit testing
    this.headRect = { x: this.cx - S * 0.9, y: this.headY - S * 1.15, w: S * 1.8, h: S * 2.3 };
  }

  // the head's outline: where the surface turns away from the camera
  _drawSilhouette(jaw, wake) {
    const tmp = [0, 0, 0];
    const sides = [[], []];
    const STEPS = 40;
    for (let i = 0; i <= 44; i++) {
      const s = lerp(0.985, -0.985, i / 44);
      for (let k = 0; k < 2; k++) {
        const dir = k ? 1 : -1;
        let prev = null;
        for (let j = 0; j <= STEPS; j++) {
          const phi = dir * (j / STEPS) * Math.PI;
          const p = this._surf(s, phi);
          const f = this._facing(p.x, p.y, p.z);
          if (prev && prev.f > 0 && f <= 0) {
            const u = prev.f / (prev.f - f);
            const x = lerp(prev.p.x, p.x, u);
            const y = lerp(prev.p.y, p.y, u);
            const z = lerp(prev.p.z, p.z, u);
            this._p(x, y - (z > 0 ? jaw * jawWeight(x, y) : 0), z, tmp);
            sides[k].push([tmp[0], tmp[1]]);
            break;
          }
          prev = { f, p };
        }
      }
    }
    const outline = sides[0].concat(sides[1].reverse());
    if (outline.length > 4) this._glow(outline, 1.1, 0.5 * wake, true);
  }

  _drawContours(t, jaw, wake) {
    const ctx = this.ctx;
    const tmp = [0, 0, 0];
    // a few latitude contour lines give the wireframe some structure
    for (const s of [0.55, 0.3, -0.2, -0.75]) {
      const pts = [];
      let segs = [];
      for (let j = 0; j <= 64; j++) {
        const phi = -Math.PI + (TAU * j) / 64;
        const p = this._surf(s, phi);
        const f = this._facing(p.x, p.y, p.z);
        if (f > 0.02) {
          this._p(p.x, p.y - (Math.cos(phi) > 0.2 ? jaw * jawWeight(p.x, p.y) : 0), p.z, tmp);
          segs.push([tmp[0], tmp[1]]);
        } else if (segs.length) {
          pts.push(segs);
          segs = [];
        }
      }
      if (segs.length) pts.push(segs);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = `rgba(${this.rgb},${0.09 * wake})`;
      for (const seg of pts) if (seg.length > 1) {
        this._path(seg);
        ctx.stroke();
      }
    }
    // hairline line-up
    if (this.opts.hair) {
      const pts = [];
      for (let j = -40; j <= 40; j++) {
        const phi = (j / 40) * 0.92;
        const s = hairlineAt(phi);
        const p = this._surf(s, phi, 1.01);
        const f = this._facing(p.x, p.y, p.z);
        if (f < 0.03) continue;
        this._p(p.x, p.y, p.z, tmp);
        pts.push([tmp[0], tmp[1]]);
      }
      if (pts.length > 2) this._glow(pts, 1.1, 0.42 * wake);
    }
  }

  _drawEars(wake) {
    const tmp = [0, 0, 0];
    for (const side of [-1, 1]) {
      const pts3 = [
        [0.0, 0.14, -0.02], [0.05, 0.18, -0.1], [0.085, 0.07, -0.19], [0.075, -0.12, -0.2],
        [0.05, -0.3, -0.13], [0.01, -0.34, -0.06], [-0.01, -0.26, -0.03],
      ];
      const nf = this._facingVec(side, 0, -0.25);
      const a = clamp(nf * 1.6 + 0.15, 0, 1) * 0.55 * wake;
      if (a < 0.03) continue;
      const pts = spline(pts3, 4).map(([dx, y, z]) => {
        const xw = RX * widthAt(y) * Math.sqrt(Math.max(0, 1 - (z / RZB) ** 2));
        this._p(side * (xw - 0.01 + dx), y, z, tmp);
        return [tmp[0], tmp[1]];
      });
      this._glow(pts, 1.2, a);
    }
  }

  _facingVec(nx, ny, nz) {
    const l = Math.hypot(nx, ny, nz) || 1;
    const M = this.M;
    return (M[6] * nx + M[7] * ny + M[8] * nz) / l;
  }

  _eyeShape(side) {
    const m = this.motion;
    const c = this.cur;
    const o = clamp(m.lid, 0, 1.45);
    const cheek = clamp(c.cheek, 0, 1);
    const ix = side * 0.14;
    const ox = side * 0.415;
    const iy = EYE_Y - 0.006;
    const oy = EYE_Y + 0.014;
    const lowerAt = (k) => lerp(iy, oy, k) - (0.034 - 0.02 * cheek) * Math.sin(k * Math.PI) * (0.85 + 0.15 * k);
    const closedAt = (k) => lowerAt(k) + 0.004;
    const openAt = (k) => lerp(iy, oy, k) + 0.058 * Math.sin(Math.pow(k, 0.85) * Math.PI) * (1 - 0.15 * k);
    const upper = [];
    const lower = [];
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const k = i / N;
      const x = lerp(ix, ox, k);
      upper.push([x, lerp(closedAt(k), openAt(k), o)]);
      lower.push([x, lowerAt(k)]);
    }
    return { upper, lower, center: [side * 0.278, EYE_Y + 0.004] };
  }

  _drawEyes(t, wake) {
    const ctx = this.ctx;
    const m = this.motion;
    for (const side of [-1, 1]) {
      const { upper, lower, center } = this._eyeShape(side);
      const f = this._facing(center[0], center[1], faceZ(center[0], center[1]));
      const a = clamp(f * 2.2, 0, 1) * wake;
      if (a < 0.03) continue;
      const U = this._curve(upper, 0.004);
      const L = this._curve(lower, 0.004);
      const opening = U.concat(L.slice().reverse());
      // darken the opening so the dot grid doesn't show through
      ctx.globalCompositeOperation = 'source-over';
      this._path(opening, true);
      ctx.fillStyle = `rgba(1,6,12,${0.82 * a})`;
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      // iris + pupil, clipped by the lids
      if (m.lid > 0.08) {
        ctx.save();
        this._path(opening, true);
        ctx.clip();
        const ix = center[0] + m.gx * 0.05;
        const iy = center[1] + m.gy * 0.026;
        const ring = [];
        for (let i = 0; i <= 28; i++) {
          const ang = (i / 28) * TAU;
          ring.push([ix + Math.cos(ang) * 0.044, iy + Math.sin(ang) * 0.044]);
        }
        const R = this._curve(ring, 0.012);
        this._path(R, true);
        ctx.fillStyle = `rgba(${this.rgb},${0.18 * a})`;
        ctx.fill();
        this._glow(R, 1.3, 0.85 * a, true);
        // iris spokes
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = `rgba(${this.rgb},${0.35 * a})`;
        ctx.beginPath();
        const tmp = [0, 0, 0];
        for (let i = 0; i < 12; i++) {
          const ang = (i / 12) * TAU + t * 0.15;
          const z = faceZ(ix, iy) + 0.012;
          this._p(ix + Math.cos(ang) * 0.02, iy + Math.sin(ang) * 0.02, z, tmp);
          ctx.moveTo(tmp[0], tmp[1]);
          this._p(ix + Math.cos(ang) * 0.04, iy + Math.sin(ang) * 0.04, z, tmp);
          ctx.lineTo(tmp[0], tmp[1]);
        }
        ctx.stroke();
        // pupil
        const P = this._curve([[ix, iy]], 0.014)[0];
        const pr = this.scale * 0.017;
        const grd = ctx.createRadialGradient(P[0], P[1], 0, P[0], P[1], pr * 2.6);
        grd.addColorStop(0, `rgba(${this.rgbHi},${0.95 * a})`);
        grd.addColorStop(0.35, `rgba(${this.rgb},${0.55 * a})`);
        grd.addColorStop(1, `rgba(${this.rgb},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(P[0], P[1], pr * 2.6, 0, TAU);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.8 * a})`;
        ctx.fillRect(P[0] - pr * 0.9, P[1] - pr * 0.95, Math.max(1.2, pr * 0.45), Math.max(1.2, pr * 0.45));
        ctx.restore();
      }
      // lids
      this._glow(U, 1.6, 0.95 * a, false, true);
      this._glow(L, 1.0, 0.5 * a);
      // crease above the lid
      const crease = upper.map(([x, y], i) => [x, y + 0.026 + 0.008 * Math.sin((i / 10) * Math.PI)]).slice(1, -1);
      this._glow(this._curve(crease, 0.006), 0.8, 0.22 * a);
      // under-eye line
      const under = lower.map(([x, y]) => [x, y - 0.035]).slice(2, -1);
      this._glow(this._curve(under, 0.002), 0.7, 0.12 * a);
    }
  }

  _drawBrows(wake) {
    const ctx = this.ctx;
    const c = this.cur;
    const flash = this.browFlash * 0.35 * Math.sin((1 - this.browFlash) * Math.PI);
    for (const side of [-1, 1]) {
      const raise = (side < 0 ? c.browR : c.browL) + flash + (this.state === 'listening' ? 0.05 : 0);
      const base = [
        [0.115, 0.175], [0.2, 0.205], [0.3, 0.218], [0.39, 0.207], [0.465, 0.175],
      ];
      const pts = base.map(([x, y], i) => {
        const inner = 1 - i / (base.length - 1);
        let yy = y + 0.065 * raise + 0.055 * c.browInner * inner - 0.04 * c.browFurrow * inner;
        if (c.browInner > 0) yy -= 0.012 * c.browInner * (1 - inner);
        const xx = x - 0.018 * c.browFurrow * inner;
        return [side * xx, yy];
      });
      const sp = spline(pts, 4);
      const top = sp.map(([x, y], i) => [x, y + lerp(0.02, 0.009, i / (sp.length - 1))]);
      const bot = sp.map(([x, y], i) => [x, y - lerp(0.016, 0.008, i / (sp.length - 1))]);
      const f = this._facing(pts[2][0], pts[2][1], faceZ(pts[2][0], pts[2][1]));
      const a = clamp(f * 2.2, 0, 1) * wake;
      const T = this._curve(top, 0.01);
      const B = this._curve(bot, 0.01);
      const shape = T.concat(B.reverse());
      this._path(shape, true);
      ctx.fillStyle = `rgba(${this.rgb},${0.3 * a})`;
      ctx.fill();
      this._glow(shape, 0.9, 0.7 * a, true);
    }
  }

  _drawNose(wake) {
    const a = clamp(this._facingVec(0, 0, 1) * 1.4, 0, 1) * wake;
    const ny = NOSE_Y;
    for (const side of [-1, 1]) {
      // bridge
      this._glow(this._curve(spline([[side * 0.05, 0.1], [side * 0.052, -0.05], [side * 0.06, -0.2]], 5), 0.004), 0.8, 0.22 * a);
      // wing
      const wing = spline([
        [side * 0.058, ny + 0.1], [side * 0.105, ny + 0.06], [side * 0.118, ny + 0.015],
        [side * 0.09, ny - 0.008], [side * 0.045, ny + 0.002],
      ], 5);
      this._glow(this._curve(wing, 0.004), 1.1, 0.6 * a);
    }
    // tip and columella
    this._glow(this._curve(spline([[-0.045, ny + 0.045], [0, ny + 0.07], [0.045, ny + 0.045]], 5), 0.006), 0.9, 0.35 * a);
    this._glow(this._curve(spline([[-0.045, ny + 0.002], [0, ny - 0.006], [0.045, ny + 0.002]], 5), 0.004), 1, 0.5 * a);
    // philtrum
    for (const side of [-1, 1]) {
      this._glow(this._curve([[side * 0.022, ny - 0.03], [side * 0.03, MOUTH_Y + 0.05]], 0.004), 0.7, 0.16 * a);
    }
  }

  _drawMouth(jaw, wake) {
    const ctx = this.ctx;
    const c = this.cur;
    const m = this.motion;
    const open = clamp(m.open, 0, 1.2);
    const wide = clamp(m.wide, -1, 1);
    const smile = c.smile;
    const smirk = c.smirk;
    const h = 0.205 * (1 + 0.16 * wide + 0.1 * Math.max(0, smile)) * (1 - 0.06 * open);
    const cornerY = (side) => MOUTH_Y + 0.045 * smile + (side > 0 ? 0.042 * smirk : -0.004 * smirk);
    const pucker = Math.max(0, -wide);
    const drop = (x) => jaw * Math.pow(Math.max(0, 1 - (x / h) ** 2), 0.55) * (1 + 0.25 * pucker);
    const lift = (x) => 0.022 * open * Math.pow(Math.max(0, 1 - (x / h) ** 2), 0.6);
    const N = 14;
    const upperOuter = [];
    const upperInner = [];
    const lowerInner = [];
    const lowerOuter = [];
    for (let i = 0; i <= N; i++) {
      const k = i / N;
      const x = lerp(-h, h, k);
      const cy = lerp(cornerY(-1), cornerY(1), k);
      const mid = Math.sin(k * Math.PI);
      const bow = 0.008 * Math.exp(-((Math.abs(x) - 0.05) ** 2) / 0.0012) - 0.006 * Math.exp(-(x * x) / 0.0006);
      const smileCurve = -0.018 * smile * mid; // corners up = center relatively down
      upperOuter.push([x, cy + (0.034 + 0.01 * pucker) * Math.pow(mid, 0.7) + bow + smileCurve * 0.6 + lift(x)]);
      upperInner.push([x, cy + 0.002 * mid + smileCurve + lift(x)]);
      lowerInner.push([x, cy - 0.002 * mid + smileCurve - drop(x)]);
      lowerOuter.push([x, cy - (0.05 + 0.01 * pucker) * Math.pow(mid, 0.8) + smileCurve * 0.4 - drop(x) * 1.02]);
    }
    const f = this._facing(0, MOUTH_Y, faceZ(0, MOUTH_Y));
    const a = clamp(f * 1.8, 0, 1) * wake;
    const UO = this._curve(upperOuter, 0.006);
    const UI = this._curve(upperInner, 0.004);
    const LI = this._curve(lowerInner, 0.004);
    const LO = this._curve(lowerOuter, 0.006);

    // mouth cavity
    const cavity = UI.concat(LI.slice().reverse());
    ctx.globalCompositeOperation = 'source-over';
    this._path(cavity, true);
    ctx.fillStyle = `rgba(1,5,10,${0.9 * a})`;
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    if (open > 0.12) {
      ctx.save();
      this._path(cavity, true);
      ctx.clip();
      // upper teeth and a hint of tongue
      const teeth = upperInner.map(([x, y]) => [x * 0.86, y - 0.022]).slice(2, -2);
      const T = this._curve(upperInner.slice(2, -2), 0.0).concat(this._curve(teeth, 0).reverse());
      this._path(T, true);
      ctx.fillStyle = `rgba(${this.rgbHi},${0.28 * a * clamp((open - 0.12) * 3, 0, 1)})`;
      ctx.fill();
      const tongue = lowerInner.map(([x, y]) => [x * 0.6, y + 0.02 + 0.03 * open]).slice(3, -3);
      this._glow(this._curve(tongue, -0.01), 1, 0.2 * a * clamp(open * 2, 0, 1));
      ctx.restore();
    }
    // lips
    const upperLip = UO.concat(UI.slice().reverse());
    const lowerLip = LI.concat(LO.slice().reverse());
    this._path(upperLip, true);
    ctx.fillStyle = `rgba(${this.rgb},${0.13 * a})`;
    ctx.fill();
    this._path(lowerLip, true);
    ctx.fillStyle = `rgba(${this.rgb},${0.15 * a})`;
    ctx.fill();
    this._glow(UO, 1.1, 0.7 * a);
    this._glow(LO, 1.1, 0.62 * a);
    this._glow(UI, 1.4, 0.9 * a, false, true);
    if (open > 0.04) this._glow(LI, 1.1, 0.75 * a, false, true);
    // corner dimples on a smile
    if (smile > 0.25) {
      for (const side of [-1, 1]) {
        const cx = side * (h + 0.025);
        const cy = cornerY(side);
        this._glow(this._curve([[cx, cy + 0.03], [cx + side * 0.012, cy], [cx, cy - 0.025]], 0.002), 0.8, 0.25 * a * smile);
      }
    }
    // chin crease
    this._glow(this._curve(spline([[-0.09, MOUTH_Y - 0.12], [0, MOUTH_Y - 0.135], [0.09, MOUTH_Y - 0.12]], 4), 0.004, jaw), 0.7, 0.14 * a);
  }

  _drawRings(t, thinking, layer) {
    const ctx = this.ctx;
    const S = this.scale;
    const cx = this.cx;
    const cy = this.headY;
    const col = thinking ? this.accent : this.color;
    const rgb = `${col[0]},${col[1]},${col[2]}`;
    const spin = thinking ? 1.6 : this.state === 'listening' ? 0.6 : 0.18;
    if (layer === 'back') {
      ctx.globalCompositeOperation = 'lighter';
      // HUD arcs
      const R1 = S * 1.48;
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const a0 = t * spin * (i % 2 ? -1 : 1) + i * 2.1;
        ctx.strokeStyle = `rgba(${rgb},${0.22 * this.wake})`;
        ctx.beginPath();
        ctx.arc(cx, cy, R1 + i * 7, a0, a0 + 1.1 + i * 0.35);
        ctx.stroke();
      }
      // tick ring
      const R2 = S * 1.62;
      ctx.strokeStyle = `rgba(${rgb},${0.16 * this.wake})`;
      ctx.beginPath();
      for (let i = 0; i < 72; i++) {
        const ang = (i / 72) * TAU - t * spin * 0.25;
        const len = i % 6 === 0 ? 7 : 3;
        ctx.moveTo(cx + Math.cos(ang) * R2, cy + Math.sin(ang) * R2);
        ctx.lineTo(cx + Math.cos(ang) * (R2 + len), cy + Math.sin(ang) * (R2 + len));
      }
      ctx.stroke();
      // listening pulse
      if (this.state === 'listening') {
        const p = (t * 0.9) % 1;
        ctx.strokeStyle = `rgba(${this.rgb},${0.35 * (1 - p)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, S * (1.25 + p * 0.5), 0, TAU);
        ctx.stroke();
      }
    }
    // orbit ring of dots around the head, tilted in 3D
    const ry = -1.08;
    const n = 90;
    const tmp = [0, 0];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + t * spin * 0.5;
      const x = Math.cos(ang) * 1.05;
      const z = Math.sin(ang) * 1.05;
      const y = ry - z * 0.3;
      if ((layer === 'back') !== (z < 0)) continue;
      const D = 6;
      const f = S * (D / (D - z));
      tmp[0] = cx + x * f;
      tmp[1] = cy - y * f;
      const a = (z < 0 ? 0.1 : 0.35) * this.wake * (i % 3 === 0 ? 1.4 : 0.7);
      ctx.fillStyle = `rgba(${rgb},${a})`;
      const sz = z < 0 ? 1.2 : 1.8;
      ctx.fillRect(tmp[0] - sz / 2, tmp[1] - sz / 2, sz, sz);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawProjector(t) {
    const ctx = this.ctx;
    const S = this.scale;
    const cx = this.cx;
    const by = this.cy + S * 2.05;
    ctx.globalCompositeOperation = 'lighter';
    // beam
    const beam = ctx.createLinearGradient(0, by, 0, this.cy - S * 0.6);
    beam.addColorStop(0, `rgba(${this.rgb},${0.14 * this.wake})`);
    beam.addColorStop(1, `rgba(${this.rgb},0)`);
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(cx - S * 0.42, by);
    ctx.lineTo(cx + S * 0.42, by);
    ctx.lineTo(cx + S * 1.05, this.cy - S * 0.6);
    ctx.lineTo(cx - S * 1.05, this.cy - S * 0.6);
    ctx.closePath();
    ctx.fill();
    // emitter rings
    for (let i = 0; i < 4; i++) {
      const r = S * (0.28 + i * 0.16);
      const pulse = 0.5 + 0.5 * Math.sin(t * 2 - i * 0.8);
      ctx.strokeStyle = `rgba(${this.rgb},${(0.28 - i * 0.05) * (0.6 + 0.4 * pulse) * this.wake})`;
      ctx.lineWidth = i === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.ellipse(cx, by, r, r * 0.16, 0, 0, TAU);
      ctx.stroke();
    }
    const core = ctx.createRadialGradient(cx, by, 0, cx, by, S * 0.5);
    core.addColorStop(0, `rgba(${this.rgbHi},${0.35 * this.wake})`);
    core.addColorStop(1, `rgba(${this.rgb},0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(cx, by, S * 0.5, S * 0.1, 0, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    this.baseY = by;
  }

  _drawMotes(t) {
    if (this.reduced) return;
    const ctx = this.ctx;
    const S = this.scale;
    if (this.motes.length < 40 && Math.random() < 0.5) {
      this.motes.push({ x: (Math.random() * 2 - 1) * 0.45, y: 0, v: 0.25 + Math.random() * 0.4, life: 0 });
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const m of this.motes) {
      m.life += 1 / 60;
      m.y += m.v / 60;
      const px = this.cx + m.x * S * (1 + m.y * 0.6);
      const py = this.baseY - m.y * S;
      const a = Math.max(0, 0.5 * (1 - m.y / 1.6)) * this.wake;
      ctx.fillStyle = `rgba(${this.rgb},${a})`;
      ctx.fillRect(px - 0.8, py - 0.8, 1.6, 1.6);
    }
    this.motes = this.motes.filter((m) => m.y < 1.6);
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawGlitch() {
    const ctx = this.ctx;
    const cv = this.cv;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < 3; i++) {
      const h = Math.round((4 + Math.random() * 14) * dpr);
      const y = Math.round((this.headY - this.scale + Math.random() * this.scale * 2) * dpr);
      const dx = Math.round((Math.random() * 2 - 1) * 9 * dpr);
      try {
        ctx.drawImage(cv, 0, y, cv.width, h, dx, y, cv.width, h);
      } catch (e) {
        /* canvas might be zero-sized */
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  hit(x, y) {
    const r = this.headRect;
    return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
}
