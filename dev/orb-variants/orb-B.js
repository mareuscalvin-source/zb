// HoloOrb, variant B ("alive"): a luminous dot-cloud orb for ZB.
// Raw WebGL 1 / GLSL ES 1.00. Thousands of crisp additive dots sit on latitude rings of a sphere,
// displaced by domain-warped simplex noise, traveling ripples (one per syllable) and a voice wave.
// Colours flow over the surface from a 4-stop palette that is swirled by noise, Siri style.

const MAX_RIPPLES = 6;

// ---------------------------------------------------------------- shaders
const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERT = `
precision highp float;
attribute vec4 aP;            // xyz: unit direction on the sphere, w: per-dot random 0..1
uniform mat3 uRot;            // object -> view rotation
uniform vec2 uRes;            // drawing buffer size (px)
uniform vec3 uCenter;         // orb centre (buffer px, y down), z: radius (buffer px)
uniform float uDot;           // base dot diameter (buffer px)
uniform vec4 uShape;          // x: amplitude, y: frequency, z: domain warp, w: fine detail
uniform vec4 uFlowV;          // x: noise flow phase, y: colour flow phase, z: voice phase, w: voice amount
uniform vec4 uBody;           // x: scale, y: vertical squash, z: twist, w: brightness
uniform vec4 uLook;           // x: colour swirl, y: saturation, z: vertical offset (radius units), w: dot scale
uniform vec4 uRip[${MAX_RIPPLES}];        // xyz: view-space origin direction, w: age (s)
uniform float uRipA[${MAX_RIPPLES}];      // ripple strength (0 = inactive)
uniform vec3 uPal[4];
varying vec3 vCol;
varying float vA;
${NOISE}

// Organic fold field: low-frequency noise, warped by a slower noise, plus some detail.
float field(vec3 n){
  vec3 q = n * uShape.y;
  float f = uFlowV.x;
  float w = snoise(q * 0.55 + vec3(0.0, f * 0.6, f * 0.25));
  float d = snoise(q + vec3(f * 0.45, -f * 0.3, 0.1) + w * uShape.z);
  d += uShape.w * 0.45 * snoise(q * 2.2 + vec3(-f * 0.8, 0.3, f * 0.6) + w * 0.8);
  // Ridged term: sharp creases where the surface folds over (bright dense lines).
  float r = 1.0 - abs(snoise(q * 0.8 + vec3(3.1, f * 0.4, -f * 0.3) + w * 0.5));
  d += 0.42 * (r * r * r - 0.4);
  return d;
}

// Radial offset of the surface along direction n (object space). glow returns ripple crest energy.
float disp(vec3 n, out float glow){
  vec3 v = uRot * n;                       // view-space direction, for ripples that face the viewer
  // Folds are stronger on the lower half and the sides, like draped cloth; the crown stays rounder.
  float drape = mix(0.65, 1.35, smoothstep(0.6, -0.7, v.y));
  float d = uShape.x * drape * field(n);
  glow = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    float a = uRipA[i];
    if (a > 0.0) {
      float age = uRip[i].w;
      float ang = acos(clamp(dot(v, uRip[i].xyz), -1.0, 1.0));
      float x = (ang - age * 1.9) / 0.2;   // ring front travels ~1.9 rad/s over the surface
      float ring = exp(-x * x) * a * exp(-age * 1.1);
      d += 0.085 * ring;
      glow += ring;
    }
  }
  // Continuous voice wave: concentric rings flowing outward from the face of the orb.
  float va = acos(clamp(v.z, -1.0, 1.0));
  float vw = sin(va * 7.0 - uFlowV.z) * uFlowV.w * smoothstep(2.6, 0.2, va);
  d += 0.06 * vw;
  glow += max(vw, 0.0) * 0.9;
  return d;
}

vec3 palette(float s){
  s = clamp(s, 0.0, 1.0) * 3.0;
  vec3 c = mix(uPal[0], uPal[1], smoothstep(0.0, 1.0, s));
  c = mix(c, uPal[2], smoothstep(1.0, 2.0, s));
  return mix(c, uPal[3], smoothstep(2.0, 3.0, s));
}

vec3 place(vec3 n, float d){
  vec3 p = n * (1.0 + d);
  // Twist around the vertical axis (thinking swirl).
  float tw = uBody.z * p.y;
  float c = cos(tw), s = sin(tw);
  p.xz = mat2(c, -s, s, c) * p.xz;
  return p;
}

void main(){
  vec3 n = aP.xyz;
  float glow, g1, g2;
  float d0 = disp(n, glow);
  // Finite-difference surface normal so folds turning away from us light up.
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  vec3 n1 = normalize(n + t1 * 0.035);
  vec3 n2 = normalize(n + t2 * 0.035);
  vec3 p0 = place(n, d0);
  vec3 p1 = place(n1, disp(n1, g1));
  vec3 p2 = place(n2, disp(n2, g2));
  vec3 N = normalize(cross(p1 - p0, p2 - p0));
  if (dot(N, n) < 0.0) N = -N;

  vec3 sc = vec3(uBody.x, uBody.x * uBody.y, uBody.x);
  vec3 wp = uRot * (p0 * sc);
  vec3 wn = normalize(uRot * (N / sc));
  wp.y += uLook.z;

  // Perspective projection, camera on +z.
  float persp = 4.2 / (4.2 - wp.z);
  vec2 px = uCenter.xy + vec2(wp.x, -wp.y) * uCenter.z * persp;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);

  float facing = abs(wn.z);
  float rim = 1.0 - facing;
  float front = smoothstep(-0.9, 0.5, wp.z);   // dots on the far side are dimmer

  // Colour: vertical gradient, swirled by drifting noise and an angular band (stronger when thinking).
  vec3 vd = uRot * n;
  float s = 0.34 - 0.54 * wp.y;
  s += 0.2 * snoise(vd * 1.3 + vec3(0.0, uFlowV.y * 0.5, uFlowV.y));
  s += uLook.x * 0.3 * sin(atan(wp.y, wp.x) * 2.0 + uFlowV.y * 2.0 + vd.z * 1.5);
  vec3 col = palette(s + 0.12 * rim);
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, uLook.y);
  col = mix(col, vec3(0.85, 0.95, 1.0), 0.08 * rim * rim + 0.12 * clamp(glow, 0.0, 1.0));

  float inten = (1.0 + 0.8 * pow(rim, 2.2)) * mix(0.07, 1.0, front);
  inten *= 1.0 + 0.5 * clamp(glow, 0.0, 1.5);
  vCol = col * inten * uBody.w;
  // Keep each dot's hue: never let a single dot clip to white (overlaps still add up into bright ridges).
  vCol /= max(1.0, max(vCol.r, max(vCol.g, vCol.b)) / 1.1);
  vA = 1.0;
  gl_PointSize = max(1.2, uDot * uLook.w * persp * (0.82 + 0.36 * aP.w) * (1.0 + 0.2 * clamp(glow, 0.0, 1.0)) * mix(0.75, 1.0, front));
}`;

const FRAG = `
precision mediump float;
varying vec3 vCol;
varying float vA;
void main(){
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.5, 0.95, r);   // crisp round dot
  float halo = exp(-r * r * 4.0) * 0.25;            // a touch of glow
  float a = (core + halo) * vA;
  if (a < 0.004) discard;
  vec3 rgb = vCol * a;
  gl_FragColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
}`;

// ---------------------------------------------------------------- tuning tables
// State: amp, freq, warp, detail, flow speed, colour speed, swirl, twist, scale, bright, spin, dot
const STATES = {
  idle:      { amp: 0.14, freq: 1.0, warp: 0.8, detail: 0.3, speed: 0.22, cspeed: 0.12, swirl: 0.15, twist: 0.0, scale: 1.0, bright: 1.0, spin: 0.10, dot: 1.0 },
  listening: { amp: 0.09, freq: 0.9, warp: 0.7, detail: 0.2, speed: 0.32, cspeed: 0.25, swirl: 0.2, twist: 0.0, scale: 1.08, bright: 1.22, spin: 0.06, dot: 1.1 },
  thinking:  { amp: 0.13, freq: 1.45, warp: 1.4, detail: 0.5, speed: 1.1, cspeed: 1.1, swirl: 1.0, twist: 0.9, scale: 0.98, bright: 1.0, spin: 0.55, dot: 1.0 },
  speaking:  { amp: 0.11, freq: 1.1, warp: 0.9, detail: 0.3, speed: 0.45, cspeed: 0.4, swirl: 0.35, twist: 0.0, scale: 1.0, bright: 0.95, spin: 0.14, dot: 1.0 },
  sleeping:  { amp: 0.05, freq: 1.0, warp: 0.6, detail: 0.2, speed: 0.06, cspeed: 0.03, swirl: 0.05, twist: 0.0, scale: 0.8, bright: 0.32, spin: 0.03, dot: 0.85 },
};
const WARM = ['#8a6bff', '#ff7fd0', '#ff5f8a', '#ffb45f'];
const COOL = ['#1f4fd6', '#2aa7c9', '#2b3fb0', '#3a5bd0'];
const VIOLET = ['#6b7bff', '#a46bff', '#7f4dff', '#ff6bd5'];
const CYAN = ['#3fa8ff', '#5ff0ff', '#4f8cff', '#a77bff'];
const SAD = ['#3a5a9a', '#4b78a8', '#4a4f8f', '#5f5a96'];
// Mood: multipliers on the state + palette tint. bounce = vertical bob amplitude, hz = bob speed.
const MOODS = {
  neutral:   {},
  happy:     { scale: 1.05, bright: 1.05, speed: 1.3, tint: WARM, tintAmt: 0.4, bounce: 0.03, hz: 2.4 },
  amused:    { scale: 1.03, bright: 1.1, speed: 1.2, tint: WARM, tintAmt: 0.25, bounce: 0.02, hz: 3.2, twist: 0.25 },
  laughing:  { scale: 1.07, bright: 1.12, speed: 1.7, tint: WARM, tintAmt: 0.45, bounce: 0.05, hz: 7.5, amp: 1.2 },
  thinking:  { speed: 1.5, swirl: 0.6, tint: VIOLET, tintAmt: 0.3, twist: 0.4 },
  surprised: { scale: 1.16, bright: 1.2, amp: 0.6, freq: 0.8, tint: CYAN, tintAmt: 0.25 },
  concerned: { scale: 0.88, bright: 0.85, amp: 1.25, freq: 1.5, speed: 0.7, tint: COOL, tintAmt: 0.55, sat: 0.85 },
  serious:   { scale: 0.92, bright: 0.9, amp: 0.45, speed: 0.4, tint: COOL, tintAmt: 0.25 },
  confident: { scale: 1.04, bright: 1.15, amp: 0.85, speed: 0.9 },
  listening: { scale: 1.03, bright: 1.05, tint: CYAN, tintAmt: 0.3 },
  sad:       { scale: 0.9, bright: 0.7, speed: 0.5, tint: SAD, tintAmt: 0.5, sat: 0.6, squash: 0.92, drop: -0.06 },
  sleeping:  { scale: 0.92, bright: 0.6, speed: 0.4, sat: 0.7 },
};

const hexRgb = (h) => {
  h = String(h).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const v = parseInt(h, 16) || 0;
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
};
// Hue-preserving colour mix (RGB lerp between e.g. blue and orange would go grey).
const toHsl = ([r, g, b]) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
};
const fromHsl = ([h, s, l]) => {
  const k = (n) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
};
const mixHsl = (A, B, t) => {
  if (t <= 0.001) return A.slice();
  const a = toHsl(A), b = toHsl(B);
  let dh = b[0] - a[0];
  if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
  return fromHsl([(a[0] + dh * t + 1) % 1, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
};
const TINT_RGB = new Map([WARM, COOL, VIOLET, CYAN, SAD].map((t) => [t, t.map(hexRgb)]));
const ease = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class HoloOrb {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.time = 0;
    this.paused = false;
    this.state = 'idle';
    this.mood = 'neutral';
    this.mouthSource = null;
    this.cx = 0; this.cy = 0;
    this.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this._top = 0; this._bottom = 0;
    this._frames = 0;

    const pal = (opts.palette || ['#3d7bff', '#4fd2ff', '#8f6bff', '#ff8ad8']).map(hexRgb);
    this._palTarget = pal;
    this._palBase = pal.map((c) => c.slice());
    this._pal = pal.map((c) => c.slice());

    // Smoothed parameters (start at the idle/neutral target).
    this._p = this._targets(0, 0);
    this._scale = this._p.scale; this._scaleV = 0;
    this._phase = { flow: 0, color: 0, voice: 0, yaw: 0 };
    this._lastTime = 0;
    this._energy = 0; this._open = 0; this._openFloor = 0; this._ripCool = 0;
    this._kick = 0; this._bob = 0; this._bobV = 0; this._listenT = 0;
    this._look = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, hold: 0 };
    this._rip = [];
    for (let i = 0; i < MAX_RIPPLES; i++) this._rip.push({ dir: [0, 0, 1], age: 9, amp: 0 });
    this._ripBuf = new Float32Array(MAX_RIPPLES * 4);
    this._ripABuf = new Float32Array(MAX_RIPPLES);
    this._palBuf = new Float32Array(12);
    this._seed = 1;

    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false })
      || canvas.getContext('experimental-webgl', { alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error('HoloOrb: WebGL unavailable');
    this.gl = gl;
    this._initGL();

    this._onLost = (e) => { e.preventDefault(); this._lost = true; cancelAnimationFrame(this._raf); };
    this._onRestored = () => { this._lost = false; this._initGL(); this._resize(); this._start(); };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    } else {
      window.addEventListener('resize', () => this._resize());
    }
    this._resize();
    this._start();
  }

  // ------------------------------------------------------------ public API
  setPalette(stops) {
    if (!stops || stops.length < 4) return;
    this._palTarget = stops.slice(0, 4).map(hexRgb);
  }
  setMood(name) {
    this.mood = MOODS[name] ? name : 'neutral';
    if (this.mood === 'surprised') this._scaleV += 1.6;     // quick expansion
    if (this.mood === 'laughing' || this.mood === 'happy') this._spawnRipple([0, 0.2, 1], 0.7);
    if (!this._frames) this._snap();
  }
  setState(state) {
    this.state = STATES[state] ? state : 'idle';
    if (this.state === 'listening') { this._scaleV += 0.8; this._listenT = 0.9; }   // inhale
    if (!this._frames) this._snap();
  }
  setViewport(top, bottom) { this._top = +top || 0; this._bottom = +bottom || 0; this._layout(); }
  lookAt(nx, ny, holdSec = 2.5) {
    const L = this._look;
    L.tYaw = Math.max(-1, Math.min(1, nx)) * 0.45;
    L.tPitch = Math.max(-1, Math.min(1, ny)) * 0.32;
    L.hold = holdSec;
  }
  flashBrows() { this._kick = Math.min(1, this._kick + 0.45); this._spawnRipple([0, 0.55, 0.83], 0.9); }
  nod() { this._bobV -= 0.35; this._spawnRipple([0, 0, 1], 0.8); }
  hit(x, y) {
    const r = this._radiusCss * this._scale * 1.12;
    return Math.hypot(x - this.cx, y - this.cy) <= r;
  }
  destroy() {
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
  }

  // ------------------------------------------------------------ GL setup
  _initGL() {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error('HoloOrb shader compile error: ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aP');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('HoloOrb link error: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    const U = {};
    ['uRot', 'uRes', 'uCenter', 'uDot', 'uShape', 'uFlowV', 'uBody', 'uLook'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    U.uRip = gl.getUniformLocation(prog, 'uRip[0]');
    U.uRipA = gl.getUniformLocation(prog, 'uRipA[0]');
    U.uPal = gl.getUniformLocation(prog, 'uPal[0]');
    this.U = U;

    // Dots on latitude rings, evenly spaced along each ring: gives the neat rows of the reference.
    const css = Math.min(this.canvas.clientWidth || 600, this.canvas.clientHeight || 600);
    const rings = css < 480 ? 96 : 106;
    const pts = [];
    for (let i = 0; i < rings; i++) {
      const th = (i + 0.5) / rings * Math.PI;
      const count = Math.max(3, Math.round(2 * rings * Math.sin(th)));
      const off = (i % 2) * 0.5;
      for (let j = 0; j < count; j++) {
        const ph = (j + off) / count * Math.PI * 2;
        const st = Math.sin(th);
        pts.push(st * Math.cos(ph), Math.cos(th), st * Math.sin(ph), this._rand());
      }
    }
    this.count = pts.length / 4;
    this.pointCount = this.count;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
    this._spacingK = Math.PI / rings;   // dot spacing in radius units
  }

  _rand() { this._seed = (this._seed * 16807) % 2147483647; return (this._seed - 1) / 2147483646; }

  _resize() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round((c.clientWidth || 300) * dpr));
    const h = Math.max(1, Math.round((c.clientHeight || 300) * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this._dpr = dpr;
    this._layout();
  }

  _layout() {
    const c = this.canvas;
    const W = c.clientWidth || 300, H = c.clientHeight || 300;
    const free = Math.max(60, H - this._top - this._bottom);
    this._radiusCss = Math.min(free * 0.30, W * 0.36);
    this.cx = W / 2;
    this.cy = this._top + free / 2;
  }

  _start() {
    cancelAnimationFrame(this._raf);
    this._last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      const real = Math.min(0.3, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      if (this._lost || this.paused || document.hidden) return;
      this._step(Math.min(real, 0.1), real);
      this._render();
      this._frames++;
    };
    this._raf = requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ animation
  _targets(energy, open) {
    const s = STATES[this.state] || STATES.idle, m = MOODS[this.mood] || {};
    const r = this.reduced ? 0.4 : 1;
    const speaking = this.state === 'speaking';
    return {
      amp: s.amp * (m.amp || 1) + (speaking ? energy * 0.04 : 0),
      freq: s.freq * (m.freq || 1),
      warp: s.warp, detail: s.detail,
      speed: s.speed * (m.speed || 1) * r * (speaking ? 1 + energy * 1.2 : 1),
      cspeed: s.cspeed * (m.speed || 1) * r,
      swirl: s.swirl + (m.swirl || 0),
      twist: (s.twist + (m.twist || 0)) * (this.reduced ? 0.4 : 1),
      scale: s.scale * (m.scale || 1) * (speaking ? 1 + open * 0.05 : 1),
      bright: s.bright * (m.bright || 1) * (speaking ? 1 + energy * 0.2 : 1),
      spin: s.spin * r * (this.mood === 'thinking' ? 1.6 : 1),
      dot: s.dot, sat: m.sat || 1, squash: m.squash || 1, drop: m.drop || 0,
      bounce: (m.bounce || 0) * (this.reduced ? 0.3 : 1), hz: m.hz || 0,
      voice: speaking ? energy : this.state === 'listening' ? 0.55 : 0,
      tint: m.tint || null, tintRgb: m.tint ? TINT_RGB.get(m.tint) : null, tintAmt: m.tintAmt || 0,
    };
  }

  _snap() {
    this._p = this._targets(0, 0);
    this._scale = this._p.scale; this._scaleV = 0;
    this._palBase = this._palTarget.map((c) => c.slice());
  }

  _spawnRipple(dir, amp) {
    let k = 0;
    for (let i = 1; i < MAX_RIPPLES; i++) if (this._rip[i].age > this._rip[k].age) k = i;
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    this._rip[k] = { dir: [dir[0] / l, dir[1] / l, dir[2] / l], age: 0, amp: amp * (this.reduced ? 0.4 : 1) };
  }

  _step(dt, real) {
    const de = Math.max(dt, real);   // easing uses real time so slow devices still settle
    this.time += dt;
    // If someone set .time (tests), rebase phases so the frame is a function of time.
    if (Math.abs(this.time - this._lastTime - dt) > 0.25) {
      const P = this._p;
      this._phase.flow = this.time * P.speed;
      this._phase.color = this.time * P.cspeed;
      this._phase.voice = this.time * 7;
      this._phase.yaw = this.time * P.spin;
    }
    this._lastTime = this.time;

    // Voice input.
    const m = this.mouthSource ? this.mouthSource() : null;
    const open = m ? Math.max(0, +m.open || 0) : 0;
    const energy = m ? Math.max(0, Math.min(1, +m.energy || 0)) : 0;
    this._open = ease(this._open, open, 22, de);
    this._energy = ease(this._energy, energy, 10, de);
    // Syllable onset: openness jumps above its recent floor -> send a ripple across the surface.
    this._openFloor = Math.min(open, this._openFloor + dt * 0.9);
    this._ripCool -= dt;
    if (m && open - this._openFloor > 0.2 && this._ripCool <= 0) {
      this._spawnRipple([(this._rand() - 0.5) * 0.9, (this._rand() - 0.5) * 0.7, 1], 0.55 + energy * 0.8);
      this._openFloor = open; this._ripCool = 0.13;
      this._kick = Math.min(1, this._kick + 0.15 * energy);
    }
    // Listening: an attentive pulse from the front every ~1.4 s.
    if (this.state === 'listening') {
      this._listenT -= dt;
      if (this._listenT <= 0) { this._spawnRipple([0, 0.1, 1], 0.75); this._listenT = 1.4; }
    }
    for (const r of this._rip) r.age += dt;

    // Ease parameters toward state/mood targets.
    const T = this._targets(this._energy, this._open), P = this._p;
    for (const k of ['amp', 'freq', 'warp', 'detail', 'speed', 'cspeed', 'swirl', 'twist', 'bright', 'spin', 'dot', 'sat', 'squash', 'drop', 'bounce', 'hz', 'voice', 'tintAmt']) {
      P[k] = ease(P[k], T[k], k === 'bright' || k === 'voice' || k === 'amp' ? 6 : 2.5, de);
    }
    if (T.tint) { P.tint = T.tint; P.tintRgb = T.tintRgb; }
    // Spring for scale: lets surprise overshoot and listening inhale.
    const steps = Math.min(30, Math.ceil(de / 0.016));
    for (let i = 0; i < steps; i++) {
      const h = de / steps;
      this._scaleV += ((T.scale - this._scale) * 60 - this._scaleV * 9) * h;
      this._scale += this._scaleV * h;
      this._bobV += (-this._bob * 70 - this._bobV * 8) * h;
      this._bob += this._bobV * h;
    }
    this._kick = ease(this._kick, 0, 4, de);

    // Phases.
    this._phase.flow += dt * P.speed;
    this._phase.color += dt * P.cspeed;
    this._phase.voice += dt * (this.state === 'listening' ? 3 : 5 + this._energy * 9);
    this._phase.yaw += dt * P.spin;

    // Gaze.
    const L = this._look;
    L.hold -= dt;
    if (L.hold <= 0) { L.tYaw = 0; L.tPitch = 0; }
    L.yaw = ease(L.yaw, L.tYaw, 4, de);
    L.pitch = ease(L.pitch, L.tPitch, 4, de);

    // Palette: base eases to the requested palette, then a mood tint is mixed on top.
    for (let i = 0; i < 4; i++) {
      for (let c = 0; c < 3; c++) this._palBase[i][c] = ease(this._palBase[i][c], this._palTarget[i][c], 3, de);
      this._pal[i] = P.tint ? mixHsl(this._palBase[i], P.tintRgb[i], P.tintAmt) : this._palBase[i].slice();
    }
  }

  _render() {
    const gl = this.gl, U = this.U, P = this._p, c = this.canvas;
    if (!this.prog) return;
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.prog);

    const t = this.time, dpr = this._dpr;
    // Rotation: slow spin + tilt toward viewer (to see the pole like the reference) + gaze + breathing sway.
    const yaw = this._phase.yaw + this._look.yaw + (this.reduced ? 0 : 0.08 * Math.sin(t * 0.37));
    const pitch = 0.38 + this._look.pitch + (this.reduced ? 0 : 0.05 * Math.sin(t * 0.29)) + (this.mood === 'sad' ? 0.25 : 0);
    const roll = 0.12 + (this.reduced ? 0 : 0.05 * Math.sin(t * 0.23));
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Rz(roll) * Rx(pitch) * Ry(yaw); positive pitch tips the top pole toward the viewer.
    const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
    const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
    const Rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
    const Rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
    const M = mul(Rz, mul(Rx, Ry));
    // Column-major for GL.
    gl.uniformMatrix3fv(U.uRot, false, new Float32Array([M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]));

    const breath = 1 + (this.reduced ? 0.006 : 0.018) * Math.sin(t * (this.state === 'sleeping' ? 0.8 : 1.5));
    const bounce = P.bounce * (P.hz > 5 ? Math.abs(Math.sin(t * P.hz)) * 2 - 0.6 : Math.sin(t * P.hz));
    const R = this._radiusCss * dpr;
    gl.uniform2f(U.uRes, c.width, c.height);
    gl.uniform3f(U.uCenter, this.cx * dpr, this.cy * dpr, R);
    gl.uniform1f(U.uDot, Math.max(1.5, R * this._spacingK * 0.56));
    gl.uniform4f(U.uShape, P.amp, P.freq, P.warp, P.detail);
    gl.uniform4f(U.uFlowV, this._phase.flow, this._phase.color, this._phase.voice, P.voice);
    gl.uniform4f(U.uBody, this._scale * breath, P.squash, P.twist, P.bright * (1 + this._kick * 0.6));
    gl.uniform4f(U.uLook, P.swirl, P.sat, bounce + this._bob * 0.3 + P.drop, P.dot);

    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = this._rip[i];
      this._ripBuf.set([r.dir[0], r.dir[1], r.dir[2], r.age], i * 4);
      this._ripABuf[i] = r.age < 3 ? r.amp : 0;
    }
    gl.uniform4fv(U.uRip, this._ripBuf);
    gl.uniform1fv(U.uRipA, this._ripABuf);
    for (let i = 0; i < 4; i++) this._palBuf.set(this._pal[i], i * 3);
    gl.uniform3fv(U.uPal, this._palBuf);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }
}
