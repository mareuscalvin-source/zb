// HoloOrb, variant C: "cinematic depth".
// A lat-long lattice of crisp luminous dots on a sphere, folded by domain-warped simplex noise.
// Depth cues: per-dot surface normal (finite differences in the vertex shader) drives a soft key
// light, a fresnel rim and back-face dimming; dot size/brightness scale with depth, and dots far
// from the focal plane get a touch larger and softer (depth of field). A faint core glow sits
// behind the lattice and a sparse halo of particles drifts around it.
// Raw WebGL 1 / GLSL ES 1.00, no extensions, additive blending, no depth test.

const MAX_DPR = 2;

// ---------------------------------------------------------------- GLSL

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
}
`;

const DOT_VS = `
precision highp float;
attribute vec3 aDir;    // unit direction on the base sphere (or halo direction)
attribute vec2 aSeed;   // x: random 0..1, y: kind (0 = surface, 1 = halo)

uniform float uPhase;      // noise flow phase (accumulated, so speed changes never jump)
uniform float uTime;       // raw seconds, for halo drift / twinkle
uniform float uAmp;        // fold depth
uniform float uFreq;       // fold frequency
uniform float uTwist;      // tangential swirl that makes folds lean over
uniform float uSwirl;      // latitude-dependent vortex (thinking)
uniform vec3  uScale;      // per-axis radius (squash / stretch)
uniform float uPulse;      // uniform radial swell (breath, syllables, bounce)
uniform float uRipple;     // speaking ripple amplitude
uniform float uRipPhase;
uniform mat3  uRot;
uniform vec2  uCenter;     // device px
uniform float uRadius;     // device px
uniform vec2  uRes;        // device px
uniform float uDot;        // base dot diameter, device px
uniform float uBright;
uniform float uHalo;       // halo visibility
uniform vec3  uPal0; uniform vec3 uPal1; uniform vec3 uPal2; uniform vec3 uPal3;
uniform vec3  uTint; uniform float uTintAmt;

varying vec3 vColor;
varying float vSoft;

const float CAM = 4.2;                       // camera distance in orb radii
const vec3 LIGHT = vec3(-0.45, 0.62, 0.64);  // soft key light, upper left front

${NOISE}

// Surface position for a base direction: radial folds + a twist that leans them over.
vec3 surface(vec3 d){
  vec3 q = d * uFreq;
  float w = snoise(q * 0.55 + vec3(0.0, uPhase * 0.21, 3.1));
  float n = snoise(q + vec3(uPhase * 0.13, -uPhase * 0.17, uPhase * 0.11) + w * 0.85);
  float n2 = snoise(q * 1.9 + vec3(-uPhase * 0.23, uPhase * 0.19, 5.0) + w * 0.4);
  float h = n * 0.85 + n2 * 0.15;
  // ripple: waves rolling down the orb, modulated so they are not perfectly regular
  float rip = uRipple * sin(dot(d, vec3(0.2, 0.95, 0.25)) * 13.0 - uRipPhase) * (0.7 + 0.3 * n);
  float r = 1.0 + uAmp * h + rip + uPulse;
  float a = uTwist * (w + 0.5 * n) + uSwirl * sin(d.y * 2.6 + uPhase * 0.9);
  float c = cos(a), s = sin(a);
  vec3 p = d * r;
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  return p * uScale;
}

vec3 palette(float g){
  vec3 c = mix(uPal0, uPal1, smoothstep(0.12, 0.5, g));
  c = mix(c, uPal2, smoothstep(0.56, 0.8, g));
  c = mix(c, uPal3, smoothstep(0.8, 1.0, g));
  return mix(c, c * uTint * 1.6, uTintAmt);
}

void main(){
  vec3 p, n;
  float bright, size, soft;
  if (aSeed.y < 0.5) {
    vec3 d = aDir;
    vec3 up = abs(d.y) > 0.98 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 t1 = normalize(cross(d, up));
    vec3 t2 = cross(d, t1);
    vec3 p0 = surface(d);
    vec3 pa = surface(normalize(d + t1 * 0.03));
    vec3 pb = surface(normalize(d + t2 * 0.03));
    n = normalize(cross(pa - p0, pb - p0));
    if (dot(n, p0) < 0.0) n = -n;
    p = uRot * p0;
    n = uRot * n;
  } else {
    // halo particle: slow orbit + wobble on a shell outside the surface
    float k = aSeed.x;
    float ang = uTime * (0.04 + 0.05 * k) + k * 6.2831;
    float c = cos(ang), s = sin(ang);
    vec3 d = vec3(c * aDir.x + s * aDir.z, aDir.y, -s * aDir.x + c * aDir.z);
    float r = 1.14 + 0.32 * k + 0.05 * sin(uTime * 0.7 + k * 40.0);
    p = uRot * (d * r * (0.6 + 0.4 * uScale.y));
    n = normalize(p);
  }

  vec3 cam = vec3(0.0, 0.0, CAM);
  vec3 V = normalize(cam - p);
  float persp = CAM / (CAM - p.z);
  vec2 px = uCenter + vec2(p.x, -p.y) * persp * uRadius;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;

  // screen-vertical gradient so the palette always reads top -> bottom
  float g = clamp(0.5 - p.y * 0.52, 0.0, 1.0);
  vec3 col = palette(g);
  float depth = clamp(p.z * 0.5 + 0.5, 0.0, 1.0);   // 0 back .. 1 front

  if (aSeed.y < 0.5) {
    float facing = dot(n, V);
    float fres = 1.0 - abs(facing);
    float diff = max(dot(n, normalize(LIGHT)), 0.0);
    float spec = pow(max(dot(reflect(-normalize(LIGHT), n), V), 0.0), 14.0);
    float front = mix(0.1, 1.0, smoothstep(-0.25, 0.3, facing));
    bright = front * (0.62 + 0.6 * diff) * (0.85 + 1.3 * fres * fres) * mix(0.45, 1.0, depth);
    col = mix(col, vec3(1.0), 0.16 * spec + 0.08 * fres * fres * fres);
    // depth of field: focal plane slightly in front of the center
    float blur = clamp(abs(p.z - 0.55) * 0.55 - 0.12, 0.0, 1.0);
    size = uDot * persp * mix(0.78, 1.08, depth) * (1.0 + 0.45 * blur) * (0.9 + 0.25 * fres);
    soft = 0.22 + 0.55 * blur;
    bright /= (1.0 + 0.6 * blur);
  } else {
    float k = aSeed.x;
    float tw = 0.55 + 0.45 * sin(uTime * (1.3 + aSeed.x * 2.0) + aSeed.x * 90.0);
    bright = 0.4 * tw * uHalo * mix(0.45, 1.0, depth) * (1.0 - k * 0.7);
    size = uDot * persp * (0.55 + 0.6 * fract(aSeed.x * 7.13));
    soft = 0.5;
  }
  gl_PointSize = max(size, 1.0);
  vColor = col * bright * uBright;
  vSoft = soft;
}
`;

const DOT_FS = `
precision mediump float;
varying vec3 vColor;
varying float vSoft;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  float a = 1.0 - smoothstep(1.0 - vSoft, 1.0, r);
  if (a <= 0.003) discard;
  vec3 c = vColor * a;
  gl_FragColor = vec4(c, min(max(c.r, max(c.g, c.b)), 1.0));
}
`;

// Faint inner core glow: a quad around the orb with a radial falloff.
const GLOW_VS = `
precision highp float;
attribute vec2 aCorner;
uniform vec2 uCenter; uniform float uRadius; uniform vec2 uRes;
varying vec2 vUv;
void main(){
  vUv = aCorner;
  vec2 px = uCenter + aCorner * uRadius * 1.7;
  vec2 c = px / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}
`;
const GLOW_FS = `
precision mediump float;
varying vec2 vUv;
uniform vec3 uCol0; uniform vec3 uCol1; uniform float uGlow;
void main(){
  float d = length(vUv) * 1.7;   // in orb radii
  float a = exp(-d * d * 2.2) * 0.9 + exp(-d * d * 9.0) * 0.5;
  vec3 c = mix(uCol0, uCol1, clamp(0.5 + vUv.y * 0.6, 0.0, 1.0)) * a * uGlow;
  gl_FragColor = vec4(c, min(max(c.r, max(c.g, c.b)), 1.0));
}
`;

// ---------------------------------------------------------------- behaviour tables

// Per-state targets. speed scales noise flow; spin is yaw rad/s; breath is radial swell amplitude.
const STATES = {
  idle:      { amp: 0.23, freq: 1.00, speed: 0.38, twist: 0.25, scale: 1.00, bright: 1.00, breath: 0.018, breathRate: 0.9, glow: 0.10, spin: 0.07, halo: 1.0 },
  listening: { amp: 0.25, freq: 0.95, speed: 0.55, twist: 0.20, scale: 1.09, bright: 1.35, breath: 0.035, breathRate: 2.3, glow: 0.22, spin: 0.10, halo: 1.6 },
  thinking:  { amp: 0.22, freq: 1.35, speed: 1.30, twist: 0.45, swirl: 0.75, scale: 0.97, bright: 1.10, breath: 0.010, breathRate: 1.6, glow: 0.14, spin: 0.45, halo: 1.3 },
  speaking:  { amp: 0.17, freq: 1.10, speed: 0.65, twist: 0.30, scale: 1.02, bright: 1.12, breath: 0.006, breathRate: 1.2, glow: 0.16, spin: 0.10, halo: 1.2 },
  sleeping:  { amp: 0.10, freq: 0.85, speed: 0.12, twist: 0.15, scale: 0.80, bright: 0.36, breath: 0.030, breathRate: 0.35, glow: 0.05, spin: 0.02, halo: 0.3 },
};

// Mood modifiers (multipliers unless noted). tint is an RGB multiplier blended in by tintAmt.
const N = { amp: 1, freq: 1, speed: 1, twist: 0, scale: 1, bright: 1, squash: 1, droop: 0, bounce: 0, bounceRate: 2, tint: [1, 1, 1], tintAmt: 0 };
const MOODS = {
  neutral: {},
  happy:     { amp: 1.06, speed: 1.25, scale: 1.04, bright: 1.15, bounce: 0.030, bounceRate: 2.6, tint: [1.0, 0.62, 0.52], tintAmt: 0.32 },
  amused:    { amp: 1.10, speed: 1.15, scale: 1.02, bright: 1.08, bounce: 0.022, bounceRate: 3.4, tint: [1.0, 0.70, 0.82], tintAmt: 0.22 },
  laughing:  { amp: 1.25, speed: 1.60, scale: 1.05, bright: 1.18, bounce: 0.060, bounceRate: 7.5, tint: [1.0, 0.64, 0.55], tintAmt: 0.30 },
  thinking:  { freq: 1.08, speed: 1.15, twist: 0.1, bright: 1.0, tint: [0.66, 0.52, 1.0], tintAmt: 0.32 },
  surprised: { amp: 1.30, speed: 1.50, scale: 1.15, bright: 1.22, squash: 1.04, tint: [0.80, 0.95, 1.0], tintAmt: 0.22 },
  concerned: { amp: 0.72, freq: 1.45, speed: 0.80, scale: 0.86, bright: 0.84, squash: 0.94, tint: [0.32, 0.56, 1.0], tintAmt: 0.50 },
  serious:   { amp: 0.48, speed: 0.45, scale: 0.93, bright: 0.90, twist: -0.25, tint: [0.55, 0.72, 1.0], tintAmt: 0.22 },
  confident: { amp: 0.90, scale: 1.07, bright: 1.15, tint: [0.62, 0.86, 1.0], tintAmt: 0.15 },
  listening: { scale: 1.04, bright: 1.12, tint: [0.50, 0.90, 1.0], tintAmt: 0.20 },
  sad:       { amp: 0.80, speed: 0.60, scale: 0.92, bright: 0.72, squash: 0.90, droop: 0.06, tint: [0.40, 0.50, 0.92], tintAmt: 0.42 },
  sleeping:  { speed: 0.55, bright: 0.70, scale: 0.95, tint: [0.55, 0.6, 1.0], tintAmt: 0.2 },
};

function hex(h) {
  const n = parseInt(String(h).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Lat-long lattice (rows read like the reference) + halo shell.
function buildPoints(rings, haloCount) {
  const dirs = [], seeds = [];
  let rnd = 1234567;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < rings; i++) {
    const th = ((i + 0.5) / rings) * Math.PI;
    const st = Math.sin(th), ct = Math.cos(th);
    const count = Math.max(3, Math.round(2 * rings * st));
    for (let j = 0; j < count; j++) {
      const ph = (j / count) * Math.PI * 2;
      dirs.push(st * Math.cos(ph), ct, st * Math.sin(ph));
      seeds.push(rand(), 0);
    }
  }
  for (let i = 0; i < haloCount; i++) {
    const u = rand() * 2 - 1, ph = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    dirs.push(s * Math.cos(ph), u, s * Math.sin(ph));
    seeds.push(rand(), 1);
  }
  return { dirs: new Float32Array(dirs), seeds: new Float32Array(seeds), count: dirs.length / 3 };
}

// ---------------------------------------------------------------- class

export class HoloOrb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.paused = false;
    this.state = 'idle';
    this.mood = 'neutral';
    this.mouthSource = null;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.cx = 0; this.cy = 0; this.radius = 100;
    this._top = 0; this._bottom = 0;
    this._t = 0; this._phase = 0; this._ripPhase = 0; this._spin = 0; this._bouncePh = 0; this._breathPh = 0;
    this._look = { x: 0, y: 0, tx: 0, ty: 0, until: 0 };
    this._flash = 0; this._nod = 0; this._open = 0; this._energy = 0;
    const stops = (opts.palette || ['#3d7bff', '#4fd2ff', '#8f6bff', '#ff8ad8']).map(hex);
    this._pal = stops.map((c) => c.slice()); this._palT = stops;
    this._p = this._targets(); // current smoothed params

    this.gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false })
      || canvas.getContext('experimental-webgl');
    if (!this.gl) throw new Error('HoloOrb: WebGL unavailable');
    this._init();

    this._onLost = (e) => { e.preventDefault(); this._lost = true; cancelAnimationFrame(this._raf); };
    this._onRestored = () => { this._lost = false; this._init(); this._loop(); };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
    this._resize();
    this._last = performance.now();
    this._loop();
  }

  // --- public API
  get time() { return this._t; }
  set time(v) { this._t = v; this._phase = v * this._p.speed; this._spin = v * this._p.spin; }

  setPalette(stops) { if (stops && stops.length >= 4) this._palT = stops.slice(0, 4).map(hex); }
  setMood(name) { this.mood = MOODS[name] ? name : 'neutral'; }
  setState(s) { this.state = STATES[s] ? s : 'idle'; }
  setViewport(top, bottom) { this._top = top || 0; this._bottom = bottom || 0; this._layout(); }
  lookAt(nx, ny, holdSec = 2.5) {
    this._look.tx = Math.max(-1, Math.min(1, nx || 0)) * 0.45;
    this._look.ty = Math.max(-1, Math.min(1, ny || 0)) * 0.32;
    this._look.until = this._t + holdSec;
  }
  flashBrows() { this._flash = 1; }
  nod() { this._nod = 1; }
  hit(x, y) { const dx = x - this.cx, dy = y - this.cy; return dx * dx + dy * dy <= (this.radius * 1.12) ** 2; }

  destroy() {
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
  }

  // --- GL setup
  _compile(type, src) {
    const gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error('HoloOrb shader compile error: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }
  _program(vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('HoloOrb program link error: ' + gl.getProgramInfoLog(p));
    }
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  _init() {
    const gl = this.gl;
    this._dot = this._program(DOT_VS, DOT_FS);
    this._glow = this._program(GLOW_VS, GLOW_FS);
    const r = this.canvas.getBoundingClientRect();
    const small = Math.min(r.width || 600, r.height || 700) < 500;
    this._rings = small ? 100 : 126;          // ~12.7k / ~20.2k surface dots
    const pts = buildPoints(this._rings, small ? 220 : 340);
    this._count = pts.count;
    this._bDir = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this._bDir); gl.bufferData(gl.ARRAY_BUFFER, pts.dirs, gl.STATIC_DRAW);
    this._bSeed = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this._bSeed); gl.bufferData(gl.ARRAY_BUFFER, pts.seeds, gl.STATIC_DRAW);
    this._bQuad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this._bQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this._aDir = gl.getAttribLocation(this._dot.p, 'aDir');
    this._aSeed = gl.getAttribLocation(this._dot.p, 'aSeed');
    this._aCorner = gl.getAttribLocation(this._glow.p, 'aCorner');
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
  }
  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this._dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, Math.round(r.width * this._dpr)), h = Math.max(1, Math.round(r.height * this._dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this._cssW = r.width; this._cssH = r.height;
    this._layout();
  }
  _layout() {
    const w = this._cssW || this.canvas.clientWidth || 1, h = this._cssH || this.canvas.clientHeight || 1;
    const free = Math.max(40, h - this._top - this._bottom);
    this.cx = w / 2;
    this.cy = this._top + free / 2;
    this.radius = Math.min(free * 0.30, w * 0.36);
  }

  // --- behaviour
  _targets() {
    const s = STATES[this.state] || STATES.idle;
    const m = Object.assign({}, N, MOODS[this.mood] || {});
    const calm = this.reduced ? 0.5 : 1;
    return {
      amp: s.amp * m.amp, freq: s.freq * m.freq, speed: s.speed * m.speed * calm, twist: s.twist + m.twist,
      swirl: s.swirl || 0, scale: s.scale * m.scale, bright: s.bright * m.bright, breath: s.breath, breathRate: s.breathRate,
      glow: s.glow, spin: s.spin * calm, halo: s.halo, squash: m.squash, droop: m.droop,
      bounce: m.bounce * calm, bounceRate: m.bounceRate, tintR: m.tint[0], tintG: m.tint[1], tintB: m.tint[2], tintAmt: m.tintAmt,
    };
  }
  _step(dt) {
    const tg = this._targets(), p = this._p;
    const k = 1 - Math.exp(-dt * 3.2);
    for (const key in tg) p[key] += (tg[key] - p[key]) * k;
    const kp = 1 - Math.exp(-dt * 2.0);
    for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) this._pal[i][c] += (this._palT[i][c] - this._pal[i][c]) * kp;

    // voice: fast attack, slower release so every syllable reads as a puff
    const m = this.state === 'speaking' && this.mouthSource ? this.mouthSource() : null;
    const open = m ? Math.max(0, Math.min(1.2, m.open || 0)) : 0;
    const energy = m ? Math.max(0, Math.min(1, m.energy || 0)) : 0;
    this._open += (open - this._open) * (1 - Math.exp(-dt * (open > this._open ? 30 : 10)));
    this._energy += (energy - this._energy) * (1 - Math.exp(-dt * 6));

    this._flash *= Math.exp(-dt * 6);
    this._nod *= Math.exp(-dt * 3.5);
    const L = this._look;
    if (this._t > L.until) { L.tx = 0; L.ty = 0; }
    const kl = 1 - Math.exp(-dt * 4);
    L.x += (L.tx - L.x) * kl; L.y += (L.ty - L.y) * kl;

    const voice = this._energy;
    this._phase += dt * (p.speed + voice * 0.6);
    this._ripPhase += dt * (5 + 9 * voice);
    this._spin += dt * p.spin;
    this._breathPh += dt * p.breathRate * Math.PI * 2;
    this._bouncePh += dt * p.bounceRate * Math.PI * 2;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    if (this.paused || this._lost || (typeof document !== 'undefined' && document.hidden)) return;
    this._t += dt;
    this._step(dt);
    this._draw();
  }

  _draw() {
    const gl = this.gl, p = this._p, dpr = this._dpr || 1;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const breath = p.breath * Math.sin(this._breathPh);
    const bounce = p.bounce * Math.abs(Math.sin(this._bouncePh * 0.5));
    const pulse = breath + bounce + this._open * 0.075 + this._flash * 0.03;
    const radius = this.radius * dpr;
    const cx = this.cx * dpr;
    const cy = (this.cy + (p.droop - bounce * 0.8 + this._nod * Math.sin(this._t * 9) * 0.03) * this.radius) * dpr;
    const sc = p.scale, sq = p.squash;

    // rotation: slow spin + slight forward tilt + lookAt + nod bob
    const yaw = this._spin + this._look.x;
    const pitch = 0.22 + this._look.y + this._nod * 0.08 * Math.sin(this._t * 9);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = Rx(pitch) * Ry(yaw), column-major
    const rot = new Float32Array([
      cyw, sp * syw, -cp * syw,
      0, cp, sp,
      syw, -sp * cyw, cp * cyw,
    ]);

    // core glow
    const pal = this._pal;
    gl.useProgram(this._glow.p);
    let u = this._glow.u;
    gl.uniform2f(u.uCenter, cx, cy); gl.uniform1f(u.uRadius, radius * sc); gl.uniform2f(u.uRes, W, H);
    gl.uniform3fv(u.uCol0, pal[1]); gl.uniform3fv(u.uCol1, pal[2]);
    gl.uniform1f(u.uGlow, p.glow * (0.6 + 0.4 * p.bright) * (1 + this._open * 0.8 + this._flash));
    gl.bindBuffer(gl.ARRAY_BUFFER, this._bQuad);
    gl.enableVertexAttribArray(this._aCorner);
    gl.vertexAttribPointer(this._aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(this._aCorner);

    // dots
    gl.useProgram(this._dot.p);
    u = this._dot.u;
    gl.uniform1f(u.uPhase, this._phase);
    gl.uniform1f(u.uTime, this._t);
    gl.uniform1f(u.uAmp, p.amp + this._energy * 0.08 + this._nod * 0.04);
    gl.uniform1f(u.uFreq, p.freq);
    gl.uniform1f(u.uTwist, p.twist);
    gl.uniform1f(u.uSwirl, p.swirl);
    gl.uniform3f(u.uScale, sc / Math.sqrt(sq), sc * sq, sc / Math.sqrt(sq));
    gl.uniform1f(u.uPulse, pulse);
    gl.uniform1f(u.uRipple, this._energy * 0.03 + this._open * 0.04 + this._nod * 0.025);
    gl.uniform1f(u.uRipPhase, this._ripPhase);
    gl.uniformMatrix3fv(u.uRot, false, rot);
    gl.uniform2f(u.uCenter, cx, cy);
    gl.uniform1f(u.uRadius, radius);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uDot, Math.max(1.6 * dpr, (radius * Math.PI / this._rings) * 0.68));
    gl.uniform1f(u.uBright, p.bright * (1 + this._flash * 0.45 + this._open * 0.3));
    gl.uniform1f(u.uHalo, p.halo);
    gl.uniform3fv(u.uPal0, pal[0]); gl.uniform3fv(u.uPal1, pal[1]);
    gl.uniform3fv(u.uPal2, pal[2]); gl.uniform3fv(u.uPal3, pal[3]);
    gl.uniform3f(u.uTint, p.tintR, p.tintG, p.tintB);
    gl.uniform1f(u.uTintAmt, p.tintAmt);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._bDir);
    gl.enableVertexAttribArray(this._aDir);
    gl.vertexAttribPointer(this._aDir, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._bSeed);
    gl.enableVertexAttribArray(this._aSeed);
    gl.vertexAttribPointer(this._aSeed, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, this._count);
    gl.disableVertexAttribArray(this._aDir);
    gl.disableVertexAttribArray(this._aSeed);
  }
}
