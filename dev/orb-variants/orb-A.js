// HoloOrb, variant A ("faithful"): a cube-sphere lattice of crisp luminous dots, folded by
// domain-warped simplex fbm, colored with a top-to-bottom palette gradient and lit brighter
// wherever the folded surface turns edge-on. Raw WebGL 1 / GLSL ES 1.00, no dependencies.

const FACE_N = 56;            // dots per cube-face edge -> 6 * 56 * 56 = 18816 points
const CAM_D = 5.0;            // camera distance in orb radii (mild perspective)
const DOT = 0.016;           // dot diameter as a fraction of the orb radius

// ---------------------------------------------------------------- shaders
const NOISE = `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
// Ashima / stegu 3D simplex noise, range about [-1, 1]
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}`;

const VS = `
precision highp float;
attribute vec3 aPos;          // point on the unit sphere (cube-sphere lattice)
attribute float aSeed;        // 0..1 per-dot random
uniform mat3 uRot;            // object -> view rotation
uniform vec2 uRes;            // canvas size, CSS px
uniform vec2 uCenter;         // orb center, CSS px
uniform float uRad;           // orb radius, CSS px
uniform float uDpr;
uniform float uFlow;          // integrated noise time
uniform float uAmp;           // radial fold amplitude
uniform float uWarp;          // tangential fold amplitude (bunches dots into ridges)
uniform float uFreq;          // fold frequency
uniform float uSwirl;         // twist of the noise domain around the vertical axis
uniform float uScale;
uniform vec3 uFront;          // view direction expressed in object space (for voice ripples)
uniform float uRipple;        // ripple amplitude (speaking)
uniform float uRipplePhase;
uniform float uOpen;          // syllable swell toward the viewer
uniform float uBright;
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3;
uniform vec3 uTint; uniform float uTintAmt; uniform float uSat;
uniform float uShift;         // slides the gradient: + warmer (violet/pink end), - cooler
varying vec3 vCol;
varying float vSize;
${NOISE}

// Displaced surface position for sphere direction n. h returns the fold height.
float gRing;                  // ripple value of the last surface() call (for brightness)
vec3 surface(vec3 n, out float h){
  vec3 q = n * uFreq;
  float tw = uSwirl * n.y;
  float c = cos(tw), s = sin(tw);
  q.xz = vec2(c * q.x - s * q.z, s * q.x + c * q.z);
  float t = uFlow;
  // low-frequency warp field: bends the fold pattern and slides dots sideways
  vec3 wq = q * 0.6 + vec3(0.0, t * 0.55, t * 0.3);
  vec3 w = vec3(snoise(wq), snoise(wq + vec3(31.4, 7.1, -12.3)), snoise(wq + vec3(-9.2, 23.7, 5.5)));
  vec3 qq = q + w * 0.45 + vec3(t * 0.21, -t * 0.17, t * 0.26);
  // smooth lobes plus rounded grooves (inverted ridged noise): dents whose walls catch the light
  float r = snoise(qq * 0.85 + vec3(4.7, -2.1, 8.3));
  h = 0.85 * snoise(qq) + 0.35 * (sqrt(r * r + 0.05) - 0.4);
  float f = dot(n, uFront);
  float ring = sin(f * 18.0 - uRipplePhase) * smoothstep(-0.2, 0.75, f);
  gRing = ring;
  float disp = uAmp * h + uRipple * ring + uOpen * 0.11 * smoothstep(0.1, 1.0, f);
  vec3 tang = w - n * dot(w, n);
  return n * (1.0 + disp) + tang * uWarp;
}

void main(){
  vec3 n = normalize(aPos);
  // tangent frame on the sphere, for a finite-difference surface normal
  vec3 up = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  float h, h1, h2;
  const float E = 0.025;
  vec3 P = surface(n, h);
  float ring = gRing;
  vec3 P1 = surface(normalize(n + E * t1), h1);
  vec3 P2 = surface(normalize(n + E * t2), h2);
  vec3 N = normalize(cross(P1 - P, P2 - P));

  vec3 pv = uRot * (P * uScale);
  vec3 nv = uRot * N;
  float facing = nv.z;                       // >0 faces the camera
  float edge = 1.0 - abs(facing);            // 1 where the sheet is seen edge-on

  float persp = ${CAM_D.toFixed(1)} / (${CAM_D.toFixed(1)} - pv.z);
  vec2 sp = uCenter + vec2(pv.x, -pv.y) * uRad * persp;
  // projected area of this dot's lattice cell (1 = undeformed, facing the camera). Where the
  // sheet folds or turns edge-on cells shrink and dots pile up; dimming each dot by the sqrt of
  // the area keeps ridges bright but colored instead of blowing out to white lines.
  vec3 pv1 = uRot * (P1 * uScale), pv2 = uRot * (P2 * uScale);
  vec2 s0 = pv.xy * persp;
  vec2 s1 = pv1.xy * (${CAM_D.toFixed(1)} / (${CAM_D.toFixed(1)} - pv1.z)) - s0;
  vec2 s2 = pv2.xy * (${CAM_D.toFixed(1)} / (${CAM_D.toFixed(1)} - pv2.z)) - s0;
  float area = abs(s1.x * s2.y - s1.y * s2.x) / (E * E * uScale * uScale);
  gl_Position = vec4(sp.x / uRes.x * 2.0 - 1.0, 1.0 - sp.y / uRes.y * 2.0, 0.0, 1.0);

  // palette gradient top -> bottom, nudged by the folds so bands follow the surface
  float g = clamp(0.5 - pv.y * 0.55 + h * 0.05 + pv.x * 0.05 + uShift, 0.0, 1.0);
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.72, g));
  col = mix(col, uC2, smoothstep(0.56, 0.8, g));
  col = mix(col, uC3, smoothstep(0.9, 1.1, g));
  // mood tint keeps each dot's peak brightness, so tints stay luminous instead of going pale
  col = mix(col, uTint * max(col.r, max(col.g, col.b)), uTintAmt);
  col = mix(vec3(dot(col, vec3(0.3, 0.59, 0.11))), col, uSat);

  // ridges: edge-on parts glow and whiten slightly; the far side stays faint for depth
  float ridge = pow(edge, 2.5);
  col = mix(col, vec3(1.0), ridge * ridge * 0.03);
  float back = facing < 0.0 ? 0.12 : 1.0;
  // the outer silhouette fades softly (like the reference); inner folds keep their full glow
  float nz = (uRot * n).z;
  float rim = mix(0.5, 1.0, smoothstep(-0.05, 0.45, nz));
  float depth = 0.72 + 0.28 * clamp(pv.z, -1.0, 1.0);
  float b = uBright * back * rim * depth * pow(clamp(area, 0.03, 1.2), 0.45) * (0.85 + 0.6 * ridge) * (0.9 + 0.2 * aSeed);
  b *= 1.0 + ring * uRipple * 6.0;          // voice rings also pulse in light
  vCol = col * b;

  // grazing dots swell a little so ridges read as soft luminous bands, as in the reference
  float dotPx = ${DOT} * uRad * uDpr * persp * (facing < 0.0 ? 0.85 : 1.0) * (1.0 + 0.55 * ridge);
  vSize = max(dotPx, 1.4) * 1.8;             // sprite holds the dot plus a faint halo
  gl_PointSize = vSize;
}`;

const FS = `
precision mediump float;
varying vec3 vCol;
varying float vSize;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  const float core = 1.0 / 1.8;              // dot edge inside the sprite
  float px = 2.0 / vSize;                    // one device pixel in sprite units
  float dotA = 1.0 - smoothstep(core - px * 0.7, core + px * 0.7, r);
  float halo = exp(-r * r * 6.0) * 0.16;
  float a = dotA + halo;
  if (a < 0.004) discard;
  vec3 col = min(vCol, vec3(1.6));
  gl_FragColor = vec4(col * a, min(a * (0.6 + 0.4 * max(col.r, max(col.g, col.b))), 1.0));
}`;

// ---------------------------------------------------------------- state and mood tables
// Each state is a full parameter set; moods then scale (x*) or offset (+) it.
const BASE = {
  scale: 1, amp: 0.18, warp: 0.19, freq: 1.0, speed: 0.22, spin: 0.055, bright: 1.25,
  swirl: 0, pulse: 0, pulseHz: 1.3, breath: 0.012, bounce: 0, bounceHz: 0, droop: 0,
  tint: [1, 1, 1], tintAmt: 0, sat: 1, voice: 0, shift: 0,
};
const STATES = {
  idle: {},
  listening: { scale: 1.08, amp: 0.12, warp: 0.075, freq: 1.1, speed: 0.3, bright: 1.35, pulse: 0.03,
    pulseHz: 1.4, tint: [0.45, 0.95, 1.0], tintAmt: 0.2, spin: 0.04, shift: -0.14 },
  thinking: { amp: 0.19, warp: 0.15, freq: 1.6, speed: 0.95, spin: 0.42, swirl: 1.6, bright: 1.12,
    tint: [0.66, 0.45, 1.0], tintAmt: 0.2, breath: 0.006, shift: 0.1 },
  speaking: { amp: 0.15, warp: 0.1, speed: 0.4, bright: 1.12, voice: 1 },
  sleeping: { scale: 0.8, amp: 0.08, warp: 0.05, freq: 1.0, speed: 0.06, spin: 0.015, bright: 0.36,
    breath: 0.03, pulseHz: 0.18, tint: [0.3, 0.42, 1.0], tintAmt: 0.35, sat: 0.75, shift: -0.1 },
};
const MOODS = {
  neutral: {},
  happy: { 'scale+': 0.04, 'bright*': 1.1, 'bounce+': 0.022, bounceHz: 2.2, tint: [1.0, 0.62, 0.5], tintAmt: 0.16, 'shift+': 0.2 },
  amused: { 'scale+': 0.02, 'bright*': 1.08, 'bounce+': 0.016, bounceHz: 3.0, 'speed*': 1.2, tint: [1.0, 0.55, 0.9], tintAmt: 0.15, 'shift+': 0.14 },
  laughing: { 'scale+': 0.05, 'bright*': 1.2, 'bounce+': 0.05, bounceHz: 4.6, 'speed*': 1.6, 'amp*': 1.15,
    tint: [1.0, 0.6, 0.6], tintAmt: 0.2, 'shift+': 0.26 },
  thinking: { 'swirl+': 0.7, 'speed*': 1.35, 'freq*': 1.12, tint: [0.62, 0.45, 1.0], tintAmt: 0.15, 'shift+': 0.06 },
  surprised: { 'scale+': 0.09, 'amp*': 0.6, 'bright*': 1.3, 'speed*': 1.3, tint: [0.85, 0.95, 1.0], tintAmt: 0.2, 'shift+': -0.06 },
  concerned: { 'scale+': -0.12, 'amp*': 1.25, 'freq*': 1.45, 'speed*': 0.7, 'bright*': 0.82,
    tint: [0.25, 0.75, 0.9], tintAmt: 0.35, sat: 0.85, droop: 0.03, 'shift+': -0.3 },
  serious: { 'scale+': -0.05, 'amp*': 0.5, 'warp*': 0.5, 'speed*': 0.4, 'spin*': 0.3, 'bright*': 0.92,
    tint: [0.55, 0.65, 0.85], tintAmt: 0.3, sat: 0.65, 'breath*': 0.3, 'shift+': -0.12 },
  confident: { 'scale+': 0.05, 'bright*': 1.18, 'amp*': 0.85, 'speed*': 0.9, sat: 1.15 },
  listening: { 'scale+': 0.03, 'bright*': 1.12, tint: [0.45, 0.95, 1.0], tintAmt: 0.15, 'pulse+': 0.015, 'shift+': -0.08 },
  sad: { 'scale+': -0.09, 'bright*': 0.68, 'speed*': 0.55, 'amp*': 0.8, tint: [0.3, 0.45, 0.95], tintAmt: 0.35, 'shift+': -0.22,
    sat: 0.7, droop: 0.06 },
  sleeping: { 'scale+': -0.1, 'bright*': 0.55, 'speed*': 0.35, 'spin*': 0.4, tint: [0.3, 0.42, 1.0], tintAmt: 0.3, sat: 0.75, 'shift+': -0.1 },
};
const NUM_KEYS = ['scale', 'amp', 'warp', 'freq', 'speed', 'spin', 'bright', 'swirl', 'pulse', 'pulseHz',
  'breath', 'bounce', 'bounceHz', 'droop', 'tintAmt', 'sat', 'voice', 'shift'];

function hexRgb(h) {
  const s = String(h).replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.padEnd(6, '0');
  const n = parseInt(f.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const lerp = (a, b, k) => a + (b - a) * k;

// Cube-sphere lattice with equal-angle spacing: each face is an even grid of rows and
// columns, so the front reads as the tidy dot rows of the reference.
function buildLattice(N) {
  const pos = new Float32Array(6 * N * N * 3);
  const seed = new Float32Array(6 * N * N);
  const faces = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  let k = 0;
  let rnd = 1234567;
  for (const [c, u, v] of faces) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = Math.tan(((i + 0.5) / N - 0.5) * Math.PI / 2);
        const b = Math.tan(((j + 0.5) / N - 0.5) * Math.PI / 2);
        let x = c[0] + a * u[0] + b * v[0], y = c[1] + a * u[1] + b * v[1], z = c[2] + a * u[2] + b * v[2];
        const l = Math.hypot(x, y, z);
        pos[k * 3] = x / l; pos[k * 3 + 1] = y / l; pos[k * 3 + 2] = z / l;
        rnd = (rnd * 1103515245 + 12345) % 2147483648;
        seed[k] = rnd / 2147483648;
        k++;
      }
    }
  }
  return { pos, seed, count: k };
}

// ---------------------------------------------------------------- the orb
export class HoloOrb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const attrs = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false };
    const gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) throw new Error('HoloOrb: WebGL unavailable');
    this.gl = gl;

    this.state = 'idle';
    this.mood = 'neutral';
    this.paused = false;
    this.mouthSource = null;
    this.cx = 0; this.cy = 0; this.radius = 100;
    this._top = 0; this._bottom = 0;
    this._w = 1; this._h = 1; this._dpr = 1;
    this._t = 0;
    this._phaseReset = true;
    this._snap = true;                       // first frame jumps straight to the targets
    this._lost = false;

    this.reduced = false;
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = mq.matches;
      const onMq = (e) => { this.reduced = e.matches; this._retarget(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    } catch (e) { /* no matchMedia */ }

    // animated parameters: cur eases toward tgt
    this._tgt = { ...BASE, tint: [...BASE.tint] };
    this._cur = { ...BASE, tint: [...BASE.tint] };
    this._pal = (opts.palette || ['#3d7bff', '#4fd2ff', '#8f6bff', '#ff8ad8']).map(hexRgb);
    this._palTgt = this._pal.map((c) => [...c]);

    // integrated phases (so speed changes never jump)
    this._flow = 0; this._yaw = 0.35; this._ripple = 0; this._bounceP = 0; this._pulseP = 0; this._breathP = 0;
    // transient effects
    this._kick = 0; this._flash = 0; this._nod = 0;
    this._open = 0; this._energy = 0;
    // pointer look
    this._look = [0, 0]; this._lookTgt = [0, 0]; this._lookHold = 0;

    this._initGL();
    this._retarget();

    this._onLost = (e) => { e.preventDefault(); this._lost = true; cancelAnimationFrame(this._raf); this._raf = 0; };
    this._onRestored = () => { this._lost = false; this._initGL(); this._resize(); this._loop(); };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    this._resize();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    } else {
      window.addEventListener('resize', () => this._resize());
    }
    this._last = performance.now();
    this._loop();
  }

  // ---- public API
  get time() { return this._t; }
  set time(v) { this._t = +v || 0; this._phaseReset = true; }

  setPalette(stops) {
    if (!stops || stops.length < 4) return;
    this._palTgt = stops.slice(0, 4).map(hexRgb);
  }
  setMood(name) {
    const m = MOODS[name] ? name : 'neutral';
    if (m === 'surprised' && this.mood !== 'surprised') this._kick = 1;
    this.mood = m;
    this._retarget();
  }
  setState(state) {
    this.state = STATES[state] ? state : 'idle';
    this._retarget();
  }
  setViewport(top, bottom) {
    this._top = +top || 0; this._bottom = +bottom || 0;
    this._layout();
  }
  lookAt(nx, ny, holdSec = 2.5) {
    this._lookTgt = [Math.max(-1.2, Math.min(1.2, +nx || 0)), Math.max(-1.2, Math.min(1.2, +ny || 0))];
    this._lookHold = holdSec;
  }
  flashBrows() { this._flash = 1; }
  nod() { this._nod = 1; }
  hit(x, y) { return Math.hypot(x - this.cx, y - this.cy) <= this.radius * (this._cur.scale || 1) * 1.12; }

  destroy() {
    cancelAnimationFrame(this._raf); this._raf = 0;
    if (this._ro) this._ro.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
  }

  // ---- internals
  _retarget() {
    const s = { ...BASE, ...STATES[this.state] };
    s.tint = [...s.tint];
    const m = MOODS[this.mood] || {};
    for (const k of NUM_KEYS) {
      if (m[k + '*'] !== undefined) s[k] *= m[k + '*'];
      if (m[k + '+'] !== undefined) s[k] += m[k + '+'];
    }
    if (m.bounceHz) s.bounceHz = m.bounceHz;
    if (m.sat !== undefined) s.sat *= m.sat;
    if (m.droop !== undefined) s.droop += m.droop;
    if (m.tintAmt) {
      const a = s.tintAmt, b = m.tintAmt, t = a + b;
      s.tint = s.tint.map((c, i) => (c * a + m.tint[i] * b) / t);
      s.tintAmt = Math.min(0.6, t);
    }
    if (this.reduced) {
      s.speed *= 0.5; s.spin *= 0.5; s.bounce *= 0.25; s.pulse *= 0.5; s.swirl *= 0.6;
    }
    this._tgt = s;
  }

  _initGL() {
    const gl = this.gl;
    const sh = (type, src) => {
      const o = gl.createShader(type);
      gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error('HoloOrb shader compile failed: ' + gl.getShaderInfoLog(o));
      }
      return o;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('HoloOrb program link failed: ' + gl.getProgramInfoLog(p));
    }
    this._prog = p;
    this._u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      this._u[info.name] = gl.getUniformLocation(p, info.name);
    }
    const lat = buildLattice(FACE_N);
    this.pointCount = lat.count;
    this._posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lat.pos, gl.STATIC_DRAW);
    this._seedBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._seedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lat.seed, gl.STATIC_DRAW);
    this._aPos = 0;
    this._aSeed = gl.getAttribLocation(p, 'aSeed');
  }

  _resize() {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    this._w = Math.max(1, r.width || c.clientWidth || 300);
    this._h = Math.max(1, r.height || c.clientHeight || 300);
    this._dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(this._w * this._dpr), H = Math.round(this._h * this._dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this._layout();
  }

  _layout() {
    const free = Math.max(40, this._h - this._top - this._bottom);
    this.radius = Math.max(10, Math.min(free * 0.30, this._w * 0.36));
    this.cx = this._w / 2;
    this.cy = this._top + free / 2;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    let dt = (now - this._last) / 1000;
    this._last = now;
    if (this.paused || this._lost || (typeof document !== 'undefined' && document.hidden)) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    this._t += dt;
    this._update(dt);
    this._render();
  }

  _update(dt) {
    const cur = this._cur, tgt = this._tgt;
    const snap = this._snap;
    const k = snap ? 1 : 1 - Math.exp(-dt * 3.2);
    const kFast = snap ? 1 : 1 - Math.exp(-dt * 7);
    for (const key of NUM_KEYS) cur[key] = lerp(cur[key], tgt[key], key === 'scale' ? kFast : k);
    for (let i = 0; i < 3; i++) cur.tint[i] = lerp(cur.tint[i], tgt.tint[i], k);
    const kp = snap ? 1 : 1 - Math.exp(-dt * 2.5);
    for (let s = 0; s < 4; s++) for (let i = 0; i < 3; i++) this._pal[s][i] = lerp(this._pal[s][i], this._palTgt[s][i], kp);
    this._snap = false;

    // phases: on an external time set, derive them from time so frames are reproducible
    if (this._phaseReset) {
      const t = this._t;
      this._flow = t * cur.speed; this._yaw = 0.35 + t * cur.spin; this._ripple = t * 9;
      this._bounceP = t * cur.bounceHz * Math.PI * 2; this._pulseP = t * cur.pulseHz * Math.PI * 2;
      this._breathP = t * 1.05;
      this._phaseReset = false;
    } else {
      this._flow += dt * cur.speed * (1 + this._energy * 0.8);
      this._yaw += dt * cur.spin;
      this._ripple += dt * 9;
      this._bounceP += dt * cur.bounceHz * Math.PI * 2;
      this._pulseP += dt * cur.pulseHz * Math.PI * 2;
      this._breathP += dt * (this.state === 'sleeping' ? 0.55 : 1.05);
    }

    // voice: fast attack, slower release so each syllable reads
    let open = 0, energy = 0;
    let src = null;
    try { src = typeof this.mouthSource === 'function' ? this.mouthSource() : null; } catch (e) { src = null; }
    if (src) { open = Math.max(0, Math.min(1.2, +src.open || 0)); energy = Math.max(0, Math.min(1, +src.energy || 0)); }
    else if (this.state === 'speaking') { open = 0.35 + 0.3 * Math.sin(this._t * 11) * Math.sin(this._t * 3.1); energy = 0.4; }
    open *= cur.voice; energy *= cur.voice;
    this._open = lerp(this._open, open, open > this._open ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 9));
    this._energy = lerp(this._energy, energy, 1 - Math.exp(-dt * 6));

    // transients
    this._kick *= Math.exp(-dt * 3.0);
    this._flash *= Math.exp(-dt * 5.5);
    this._nod *= Math.exp(-dt * 3.2);

    // pointer look: hold, then drift home
    if (this._lookHold > 0) this._lookHold -= dt; else this._lookTgt = [0, 0];
    const kl = 1 - Math.exp(-dt * 4);
    this._look[0] = lerp(this._look[0], this._lookTgt[0], kl);
    this._look[1] = lerp(this._look[1], this._lookTgt[1], kl);
  }

  _render() {
    const gl = this.gl, u = this._u, c = this._cur;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this._prog);

    // rotation: slow spin + gentle wobble + pointer look; pitch tilts the top slightly away
    const red = this.reduced ? 0.4 : 1;
    const yaw = this._yaw + this._look[0] * 0.45 + Math.sin(this._t * 0.23) * 0.12 * red;
    const pitch = -0.12 + this._look[1] * 0.35 + Math.sin(this._t * 0.31) * 0.06 * red + this._nod * Math.sin(this._nod * 9) * 0.12;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = Rx(pitch) * Ry(yaw), stored column-major
    const R = [
      cy, sp * sy, -cp * sy,
      0, cp, sp,
      sy, -sp * cy, cp * cy,
    ];
    // view direction (0,0,1) in object space = third row of R
    const front = [R[2], R[5], R[8]];

    const breath = Math.sin(this._breathP) * c.breath;
    const pulse = c.pulse * Math.max(0, Math.sin(this._pulseP));
    const bounce = c.bounce * Math.abs(Math.sin(this._bounceP / 2));
    const scale = c.scale * (1 + breath + pulse + bounce * 0.6 + this._kick * 0.1 + this._flash * 0.02 + this._open * 0.05 + this._energy * 0.02);
    const offY = (-bounce * 1.6 + c.droop + this._nod * Math.sin((1 - this._nod) * 9) * 0.04) * this.radius;

    gl.uniformMatrix3fv(u.uRot, false, R);
    gl.uniform2f(u.uRes, this._w, this._h);
    gl.uniform2f(u.uCenter, this.cx, this.cy + offY);
    gl.uniform1f(u.uRad, this.radius);
    gl.uniform1f(u.uDpr, this._dpr);
    gl.uniform1f(u.uFlow, this._flow);
    gl.uniform1f(u.uAmp, c.amp * (1 + this._energy * 0.35) * (1 - this._kick * 0.4));
    gl.uniform1f(u.uWarp, c.warp);
    gl.uniform1f(u.uFreq, c.freq);
    gl.uniform1f(u.uSwirl, c.swirl * (1 + 0.3 * Math.sin(this._t * 0.7)));
    gl.uniform1f(u.uScale, scale);
    gl.uniform3f(u.uFront, front[0], front[1], front[2]);
    gl.uniform1f(u.uRipple, this._open * 0.065 + this._energy * 0.02 + this._nod * 0.035);
    gl.uniform1f(u.uRipplePhase, this._ripple);
    gl.uniform1f(u.uOpen, this._open);
    gl.uniform1f(u.uBright, c.bright * (1 + pulse * 4 + this._flash * 0.35 + this._kick * 0.3 + this._energy * 0.12 + this._open * 0.12));
    gl.uniform3fv(u.uC0, this._pal[0]); gl.uniform3fv(u.uC1, this._pal[1]);
    gl.uniform3fv(u.uC2, this._pal[2]); gl.uniform3fv(u.uC3, this._pal[3]);
    gl.uniform3fv(u.uTint, c.tint);
    gl.uniform1f(u.uTintAmt, c.tintAmt);
    gl.uniform1f(u.uSat, c.sat);
    gl.uniform1f(u.uShift, c.shift);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.enableVertexAttribArray(this._aPos);
    gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 0, 0);
    if (this._aSeed >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this._seedBuf);
      gl.enableVertexAttribArray(this._aSeed);
      gl.vertexAttribPointer(this._aSeed, 1, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.POINTS, 0, this.pointCount);
  }
}
