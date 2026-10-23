// HoloOrb: ZB's living orb. A latitude-ring lattice of crisp luminous dots, folded by domain-warped
// simplex noise into a round shell with soft interior fold bands, lit by a soft key light and
// colored with a top-to-bottom palette gradient. Speech sends a ring across the surface for every
// syllable. Raw WebGL 1 / GLSL ES 1.00, no dependencies.

const CAM_D = 5.0;            // camera distance in orb radii (mild perspective)
const DOT = 0.016;            // dot diameter as a fraction of the orb radius at FACE_N = 56
const FACE_N_LARGE = 56;      // density level: about 6 * 56 * 56 = 18.8k points
const FACE_N_SMALL = 42;      // about 6 * 42 * 42 = 10.6k points when min(css w, h) < 500
const FACE_STEPS = [56, 48, 42, 36, 30];   // frame-time watchdog steps down through these
const MAX_RIPPLES = 6;
const SPRITE = 1.45;          // point sprite size relative to the dot: just holds the dot and its faint halo
const GLOW_MAX = 1.7;         // largest core-glow extent, in orb radii
const HEADROOM = 4.0;         // the tone-map buffer holds sums up to this many fully lit dots per channel
const LOST_WAIT = 4000;       // ms to wait for webglcontextrestored before reporting the orb as failed

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

const CAM = CAM_D.toFixed(1);

const VS = `
precision highp float;
attribute vec3 aPos;          // point on the unit sphere (latitude-ring lattice)
attribute vec2 aSeed;         // x: 0..1 per-dot random, y: relative lattice cell area
uniform mat3 uRot;            // object -> view rotation
uniform vec2 uRes;            // canvas size, CSS px
uniform vec2 uCenter;         // orb center, CSS px
uniform float uRad;           // orb radius, CSS px
uniform float uDot;           // dot diameter, device px per CSS px of radius
uniform float uFlow;          // integrated noise time
uniform float uAmp;           // radial fold amplitude
uniform float uWarp;          // tangential fold amplitude (bunches dots into ridges)
uniform float uFreq;          // fold frequency
uniform float uSwirl;         // twist of the noise domain around the vertical axis
uniform float uTwist;         // fold lean: rotates the folded surface by the warp field
uniform float uScale;
uniform float uRipple;        // continuous voice ring amplitude
uniform float uRipplePhase;
uniform float uOpen;          // syllable swell toward the viewer
uniform float uBright;
uniform vec4 uRip[${MAX_RIPPLES}];       // xyz: view-space origin, w: cos of the ring front angle
uniform vec3 uRipK[${MAX_RIPPLES}];      // x: strength (0 = inactive), y: 1 / ring width in cosine units, z: 1 = accent ring
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3;
uniform float uSat;
uniform float uShift;         // slides the gradient: + warmer (bottom end), - cooler
uniform vec3 uAccent;         // ring accent color
uniform float uAccentK;       // 0..1 how far the rings take it on
varying vec3 vCol;
varying float vSize;
${NOISE}

vec3 domain(vec3 n){
  vec3 q = n * uFreq;
  float tw = uSwirl * n.y;
  float c = cos(tw), s = sin(tw);
  q.xz = vec2(c * q.x - s * q.z, s * q.x + c * q.z);
  return q;
}

// Low-frequency warp field. It barely changes across a lattice cell, so the normal samples reuse it.
vec3 warpField(vec3 n){
  float t = uFlow;
  vec3 wq = domain(n) * 0.6 + vec3(0.0, t * 0.55, t * 0.3);
  return vec3(snoise(wq), snoise(wq + vec3(31.4, 7.1, -12.3)), snoise(wq + vec3(-9.2, 23.7, 5.5)));
}

// Displaced surface position for sphere direction n. h: fold height, glow: ring light.
vec3 surface(vec3 n, vec3 w, out float h, out float glow, out float rg){
  float t = uFlow;
  vec3 qq = domain(n) + w * 0.45 + vec3(t * 0.21, -t * 0.17, t * 0.26);
  // smooth lobes plus rounded grooves (inverted ridged noise): dents whose walls catch the light
  float r = snoise(qq * 0.85 + vec3(4.7, -2.1, 8.3));
  h = 0.85 * snoise(qq) + 0.35 * (sqrt(r * r + 0.05) - 0.4);
  vec3 v = uRot * n;
  // drape: crown stays round, folds gather on the lower half; the limb is calmer so the outline reads round
  float drape = mix(0.65, 1.35, smoothstep(0.6, -0.7, v.y)) * mix(0.45, 1.0, abs(v.z));
  float f = v.z;
  float ring = sin(f * 18.0 - uRipplePhase) * smoothstep(-0.2, 0.75, f);
  float rings = 0.0;
  rg = 0.0;
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    float a = uRipK[i].x;
    if (a > 0.001) {
      float x = (dot(v, uRip[i].xyz) - uRip[i].w) * uRipK[i].y;
      float e = exp(-x * x) * a;
      rings += e;
      rg += e * uRipK[i].z;
    }
  }
  glow = ring * uRipple * 6.0 + rings * 0.9;
  float disp = uAmp * drape * h + uRipple * ring + 0.085 * rings + uOpen * 0.11 * smoothstep(0.1, 1.0, f);
  vec3 p = n * (1.0 + disp) + (w - n * dot(w, n)) * uWarp;
  // fold lean: neighbouring folds rotate by different amounts and overlap into bright interior bands.
  // The angle follows the slow warp field more than the fold height so the sheet leans without tearing through itself.
  float a = uTwist * (w.x + 0.3 * h);
  float c = cos(a), s = sin(a);
  p.xz = vec2(c * p.x - s * p.z, s * p.x + c * p.z);
  return p;
}

void main(){
  vec3 n = normalize(aPos);
  vec3 up = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  const float E = 0.025;
  vec3 w = warpField(n);
  float h, glow, rg, hx, gx, rx;
  vec3 P = surface(n, w, h, glow, rg);
  vec3 P1 = surface(normalize(n + E * t1), w, hx, gx, rx);
  vec3 P2 = surface(normalize(n + E * t2), w, hx, gx, rx);
  vec3 N = normalize(cross(P1 - P, P2 - P));

  vec3 pv = uRot * (P * uScale);
  vec3 nv = uRot * N;
  float facing = nv.z;                       // >0 faces the camera
  float edge = 1.0 - abs(facing);            // 1 where the sheet is seen edge-on

  float persp = ${CAM} / (${CAM} - pv.z);
  vec2 sp = uCenter + vec2(pv.x, -pv.y) * uRad * persp;
  // projected area of this dot's lattice cell: where the sheet folds or turns edge-on, cells shrink
  // and dots pile up; dimming by the area keeps ridges bright but colored instead of white lines.
  vec3 pv1 = uRot * (P1 * uScale), pv2 = uRot * (P2 * uScale);
  vec2 s0 = pv.xy * persp;
  vec2 s1 = pv1.xy * (${CAM} / (${CAM} - pv1.z)) - s0;
  vec2 s2 = pv2.xy * (${CAM} / (${CAM} - pv2.z)) - s0;
  float area = abs(s1.x * s2.y - s1.y * s2.x) / (E * E * uScale * uScale);
  gl_Position = vec4(sp.x / uRes.x * 2.0 - 1.0, 1.0 - sp.y / uRes.y * 2.0, 0.0, 1.0);

  // palette gradient top -> bottom, nudged by the folds so bands follow the surface
  float g = clamp(0.5 - pv.y * 0.55 + h * 0.05 + pv.x * 0.05 + uShift, 0.0, 1.0);
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.72, g));
  col = mix(col, uC2, smoothstep(0.56, 0.8, g));
  col = mix(col, uC3, smoothstep(0.9, 1.1, g));
  col = mix(vec3(dot(col, vec3(0.3, 0.59, 0.11))), col, uSat);

  // soft key light from the upper left front: fold walls facing it glow, the rest shades
  vec3 L = normalize(vec3(-0.45, 0.62, 0.64));
  vec3 V = normalize(vec3(0.0, 0.0, ${CAM}) - pv);
  float diff = max(dot(nv, L), 0.0);
  float spec = pow(max(dot(reflect(-L, nv), V), 0.0), 14.0);

  float ridge = pow(edge, 2.5);
  // where the sheet folds through itself the cell area collapses and dots pile up: those dim and shrink
  float open = smoothstep(0.04, 0.3, area);
  // accent: the cores of the travelling rings take on this color (surprise's gold) directly, not through the
  // palette mix. A dot is either accent or palette (a partial RGB mix of cyan and gold would be a pale grey-white),
  // so the amount moves the threshold instead: more accent, wider gold cores. Edge-on dots keep the palette:
  // there gold and cyan dots would stack, and complementary colors add up to white.
  // Only the middle of the disc takes it: toward the silhouette folds and rim dots overlap, and gold over cyan is white too.
  float athr = 0.3 + (1.0 - uAccentK) * 1.5;
  col = mix(col, uAccent, step(0.01, uAccentK) * step(athr, rg) * step(ridge, 0.4) * step(0.5, open)
                          * step(length(pv.xy), 0.72 * uScale) * step(0.0, facing));
  // the white sheen only lands on open, camera-facing sheet: stacked edge-on dots would sum it to a white line
  col = mix(col, vec3(1.0), ridge * ridge * 0.03 * open + 0.16 * spec * open * (1.0 - smoothstep(0.3, 0.7, ridge))
                           + 0.04 * clamp(glow, 0.0, 1.0) * (1.0 - uAccentK));
  float back = facing < 0.0 ? 0.12 : 1.0;
  float rim = mix(0.5, 1.0, smoothstep(-0.05, 0.45, (uRot * n).z));
  float depth = 0.72 + 0.28 * clamp(pv.z, -1.0, 1.0);
  // brightness follows sqrt(area) on open sheet but falls linearly once cells collapse (area < 0.1), so the
  // 1/area dots stacked along an edge-on fold add up to about one dot's light instead of saturating to white
  float areaK = area < 0.1 ? max(area, 0.003) * 3.1623 : sqrt(min(area, 1.2));
  float b = uBright * back * rim * depth * areaK * (0.85 + 0.6 * ridge * open)
          * (0.62 + 0.6 * diff) * (0.9 + 0.2 * aSeed.x) * sqrt(aSeed.y);
  b *= 1.0 + 0.35 * clamp(glow, -0.5, 1.5); // voice rings pulse in light

  vCol = col * b;
  vCol /= max(1.0, max(vCol.r, max(vCol.g, vCol.b)));   // too bright keeps its hue instead of clipping to white

  // grazing dots swell a little so ridges read as soft luminous bands (not where the cells collapse)
  float dotPx = uDot * uRad * persp * (facing < 0.0 ? 0.85 : 1.0) * (1.0 + 0.55 * ridge * open) * mix(0.75, 1.0, open)
              * (1.0 + 0.15 * clamp(glow, 0.0, 1.0));
  vSize = max(dotPx, 1.4) * ${SPRITE.toFixed(2)};   // sprite holds the dot plus a faint halo
  gl_PointSize = vSize;
}`;

const FS = `
precision mediump float;
varying vec3 vCol;
varying float vSize;
uniform float uGain;          // 1 / HEADROOM when drawing into the tone-map buffer
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c) * ${SPRITE.toFixed(2)};   // in dot radii
  float px = 2.0 * ${SPRITE.toFixed(2)} / vSize;    // one device pixel in dot radii
  float dotA = 1.0 - smoothstep(1.0 - px * 0.7, 1.0 + px * 0.7, r);
  float a = dotA + exp(-r * r * 1.85) * 0.16;
  if (a < 0.004) discard;
  vec3 col = vCol * a;                       // valid premultiplied output: rgb never exceeds alpha
  gl_FragColor = vec4(col, max(col.r, max(col.g, col.b))) * uGain;
}`;

// Hue-preserving tone map. The dots add up in an 8-bit buffer scaled down by HEADROOM, so a fold where several
// saturated dots overlap keeps its sum; this pass scales it back and divides by the brightest channel, so a
// pile-up reads as a dense, fully saturated band of its own color instead of clipping channel by channel to white.
const COMP_VS = `
attribute vec2 aCorner;
void main(){ gl_Position = vec4(aCorner, 0.0, 1.0); }`;
const COMP_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec2 uSize;
uniform float uHead;
void main(){
  vec3 c = texture2D(uTex, gl_FragCoord.xy / uSize).rgb * uHead;
  float mx = max(c.r, max(c.g, c.b));
  c /= max(1.0, mx);
  mx = min(mx, 1.0);
  // overlapping dots of complementary colors (a gold ring core over cyan) sum to near white, which has no hue
  // left to keep: near full brightness, hold the weakest channel under 80% of the strongest so such spots stay
  // a pale tint (or, for a white palette stop, a soft grey-white) instead of a blown-out white
  float mn = min(c.r, min(c.g, c.b));
  c -= max(0.0, mn - 0.8 * mx) * smoothstep(0.7, 1.0, mx);
  gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
}`;

// Faint additive core glow behind the dots: a quad with a radial falloff.
const GLOW_VS = `
precision highp float;
attribute vec2 aCorner;                // disc outline (unit circle) or center
uniform vec2 uCenter; uniform float uRadius; uniform vec2 uRes; uniform float uExtent;
varying vec2 vUv;                       // position in orb radii
void main(){
  vUv = aCorner * uExtent;
  vec2 px = uCenter + aCorner * uRadius * uExtent;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
}`;
const GLOW_FS = `
precision mediump float;
varying vec2 vUv;
uniform vec3 uCol0; uniform vec3 uCol1; uniform float uGlow;
uniform float uGain;          // 1 / HEADROOM when drawing into the tone-map buffer
void main(){
  float d = length(vUv);
  float a = exp(-d * d * 2.2) * 0.9 + exp(-d * d * 9.0) * 0.5;
  vec3 c = min(mix(uCol0, uCol1, clamp(0.5 + vUv.y * 0.353, 0.0, 1.0)) * a * uGlow, vec3(1.0));
  gl_FragColor = vec4(c, max(c.r, max(c.g, c.b))) * uGain;
}`;

// ---------------------------------------------------------------- state and mood tables
// Tint palettes (top -> bottom). They are mixed into the user's palette in HSL so hues stay luminous.
const TINTS = {
  WARM: ['#ff7a3d', '#ff9a3a', '#ff5248', '#ff5e8c'],     // tangerine, amber, coral, rose (deep enough to stay colored)
  GLEE: ['#ff6a5c', '#ff9433', '#ff4f7b', '#ff72ad'],
  SPARK: ['#58ffe6', '#ffe066', '#5cd6ff', '#b9a6ff'],    // surprise: electric aqua with a gold flash
  CYAN: ['#4fb8ff', '#6ff0ff', '#58a8ff', '#9a8cff'],
  VIOLET: ['#7b7bff', '#a46bff', '#8a5cff', '#e06bff'],
  COOL: ['#2f6fd6', '#2ab0c9', '#2f5fc0', '#3a7bd0'],
  STEEL: ['#5f7fb0', '#6fa0c0', '#5a6aa8', '#6f78b0'],
  SAD: ['#3a5a9a', '#4b78a8', '#4a4f8f', '#5f5a96'],
  NIGHT: ['#2f4fd0', '#3a6fd8', '#3a3fb8', '#5a4fc0'],
};

// Each state is a full parameter set; moods then scale (x*) or offset (+) it.
const BASE = {
  scale: 1, amp: 0.24, warp: 0.17, freq: 1.0, speed: 0.22, spin: 0.055, bright: 1.35,
  swirl: 0, twist: 0.32, glow: 0.1, pulse: 0, pulseHz: 1.3, breath: 0.012, bounce: 0, bounceHz: 0, droop: 0,
  sat: 1, voice: 0, shift: 0, tint: null, tintAmt: 0,
};
const STATES = {
  idle: {},
  listening: { scale: 1.08, amp: 0.13, warp: 0.08, freq: 1.1, speed: 0.3, bright: 1.45, pulse: 0.025,
    pulseHz: 1.4, twist: 0.2, glow: 0.15, tint: 'CYAN', tintAmt: 0.2, spin: 0.04, shift: -0.14 },
  thinking: { amp: 0.2, warp: 0.14, freq: 1.5, speed: 0.95, spin: 0.42, swirl: 1.2, bright: 1.25, twist: 0.22,
    glow: 0.11, tint: 'VIOLET', tintAmt: 0.2, breath: 0.006, shift: 0.1 },
  speaking: { amp: 0.16, warp: 0.1, speed: 0.4, bright: 1.38, twist: 0.3, glow: 0.17, voice: 1 },
  sleeping: { scale: 0.8, amp: 0.09, warp: 0.05, freq: 1.0, speed: 0.06, spin: 0.015, bright: 0.4, twist: 0.15,
    glow: 0.06, breath: 0.03, pulseHz: 0.18, tint: 'NIGHT', tintAmt: 0.35, sat: 0.75, shift: -0.1 },
};
const MOODS = {
  neutral: {},
  happy: { 'scale+': 0.04, 'bright*': 1.1, 'bounce+': 0.022, bounceHz: 2.2, tint: 'WARM', tintAmt: 0.3, 'shift+': 0.12 },
  amused: { 'scale+': 0.02, 'bright*': 1.08, 'bounce+': 0.016, bounceHz: 3.0, 'speed*': 1.2, tint: 'GLEE', tintAmt: 0.26, 'shift+': 0.1 },
  laughing: { 'scale+': 0.05, 'bright*': 1.2, 'bounce+': 0.05, bounceHz: 4.6, 'speed*': 1.6, 'amp*': 1.15,
    tint: 'WARM', tintAmt: 0.36, 'shift+': 0.14 },
  thinking: { 'swirl+': 0.45, 'speed*': 1.3, 'freq*': 1.08, tint: 'VIOLET', tintAmt: 0.18, 'shift+': 0.06 },
  surprised: { 'scale+': 0.09, 'amp*': 0.6, 'freq*': 0.75, 'bright*': 1.25, 'speed*': 1.5, 'spin*': 2.2, 'glow*': 1.8,
    tint: 'SPARK', tintAmt: 0.3, 'shift+': 0.04 },
  concerned: { 'scale+': -0.12, 'amp*': 1.25, 'freq*': 1.45, 'speed*': 0.7, 'bright*': 0.82,
    tint: 'COOL', tintAmt: 0.35, sat: 0.85, droop: 0.03, 'shift+': -0.3 },
  serious: { 'scale+': -0.05, 'amp*': 0.5, 'warp*': 0.5, 'speed*': 0.4, 'spin*': 0.3, 'bright*': 0.92, 'twist*': 0.5,
    tint: 'STEEL', tintAmt: 0.3, sat: 0.65, 'breath*': 0.3, 'shift+': -0.12 },
  confident: { 'scale+': 0.05, 'bright*': 1.18, 'amp*': 0.85, 'speed*': 0.9, sat: 1.15 },
  listening: { 'scale+': 0.03, 'bright*': 1.12, tint: 'CYAN', tintAmt: 0.15, 'pulse+': 0.015, 'shift+': -0.08 },
  sad: { 'scale+': -0.09, 'bright*': 0.68, 'speed*': 0.55, 'amp*': 0.8, tint: 'SAD', tintAmt: 0.4, 'shift+': -0.22,
    sat: 0.7, droop: 0.06 },
  sleeping: { 'scale+': -0.1, 'bright*': 0.55, 'speed*': 0.35, 'spin*': 0.4, tint: 'NIGHT', tintAmt: 0.3, sat: 0.75, 'shift+': -0.1 },
};
const NUM_KEYS = ['amp', 'warp', 'freq', 'speed', 'spin', 'bright', 'swirl', 'twist', 'glow', 'pulse', 'pulseHz',
  'breath', 'bounce', 'bounceHz', 'droop', 'sat', 'voice', 'shift'];

function hexRgb(h) {
  const s = String(h).replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s.padEnd(6, '0');
  const n = parseInt(f.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const ACCENT = hexRgb('#ffd75e');            // surprise: gold rings over the electric aqua
const TINT_RGB = Object.fromEntries(Object.entries(TINTS).map(([k, v]) => [k, v.map(hexRgb)]));
const lerp = (a, b, k) => a + (b - a) * k;

// Hue-preserving color mix (an RGB lerp from blue toward orange would go grey). The hue moves
// further than saturation and lightness so a modest tint still reads, and never through green.
function toHsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-5) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]) {
  const k = (n) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}
// The hue only travels part of the way so every palette stays recognizable under every mood. It never moves
// into the green band (about 75-170 degrees): where the short way would pass through it, the hue holds and
// lightness and saturation carry the mood. Going the long way round instead lands on the opposite side of the
// wheel from the tint (sad Ember turned hot pink, happy Borealis turned sky blue).
const GREEN_LO = 75 / 360, GREEN_HI = 170 / 360, GREEN_MID = (GREEN_LO + GREEN_HI) / 2;
const inGreen = (h) => h > GREEN_LO && h < GREEN_HI;
function mixHsl(A, B, t) {
  if (t <= 0.001) return A.slice();
  const a = toHsl(A), b = toHsl(B);
  if (a[1] < 0.02) a[0] = b[0];
  let dh = b[0] - a[0];
  if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
  const move = dh * Math.min(0.6, t * 1.8);
  const wrap = (h) => ((h % 1) + 1) % 1;
  let ok = true;
  if (inGreen(a[0])) {
    // a palette that starts in the band (Borealis mint) may only move out of it, away from its middle
    ok = Math.abs(wrap(a[0] + move) - GREEN_MID) > Math.abs(a[0] - GREEN_MID) && Math.abs(move) < 0.2;
  } else {
    for (let i = 1; i <= 8 && ok; i++) ok = !inGreen(wrap(a[0] + (move * i) / 8));
  }
  return fromHsl([ok ? wrap(a[0] + move) : a[0], lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
}

// Latitude-ring lattice: horizontal rows of evenly spaced dots, like the reference's grid, with no
// cube-face seams to flicker past while the orb spins. Density N matches a cube-sphere of N dots per
// face edge (6 * N * N points). Each ring starts at a random phase so columns do not line up into a
// visible meridian. aSeed.y carries a relative cell area so dot brightness evens out density changes.
function buildLattice(N) {
  const rings = Math.max(8, Math.round(N * 2.171));
  const counts = [];
  let total = 0;
  for (let i = 0; i < rings; i++) {
    const th = ((i + 0.5) / rings) * Math.PI;
    const c = Math.max(3, Math.round(2 * rings * Math.sin(th)));
    counts.push(c); total += c;
  }
  const pos = new Float32Array(total * 3);
  const seed = new Float32Array(total * 2);
  let rnd = 1234567;
  const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  let k = 0;
  for (let i = 0; i < rings; i++) {
    const th = ((i + 0.5) / rings) * Math.PI;
    const st = Math.sin(th), ct = Math.cos(th), n = counts[i];
    const off = rand();
    // area per dot relative to the ideal spacing (only differs on the few rings near the poles)
    const area = Math.min(1.3, Math.max(0.7, (2 * Math.PI * st / n) / (Math.PI / rings)));
    for (let j = 0; j < n; j++) {
      const ph = ((j + off) / n) * Math.PI * 2;
      pos[k * 3] = st * Math.cos(ph); pos[k * 3 + 1] = ct; pos[k * 3 + 2] = st * Math.sin(ph);
      seed[k * 2] = rand();
      seed[k * 2 + 1] = area;
      k++;
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
    this._paused = false;
    this._raf = 0; this._poll = 0; this._lostTimer = 0;
    this.failed = false;                     // true once the orb cannot draw (a GPU reset it could not recover from)
    this.mouthSource = null;
    this.cx = 0; this.cy = 0; this.radius = 100;
    this._top = 0; this._bottom = 0;
    this._w = 0; this._h = 0; this._dpr = 1; this._sized = false;
    this._t = 0;
    this._timeSet = false;                   // time was just set: the next frame draws exactly that time
    this._snap = true;                       // first frame jumps straight to the targets
    this._lost = false; this._dead = false; this._failed = false; this._failSent = false;
    this._onFail = typeof opts.onFail === 'function' ? opts.onFail : null;
    this._offscreen = false; this._visible = true; this._acc = 0;
    this._radK = 1; this._radSnap = true;    // projected-size cap factor
    this._N = 0; this._nCap = FACE_STEPS[0];
    this._runT = 0; this._chk = 0;
    this._wdReset();

    this.reduced = false;
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = mq.matches;
      this._mq = mq;
      this._onMq = (e) => { this.reduced = e.matches; this._retarget(); };
      if (mq.addEventListener) mq.addEventListener('change', this._onMq); else if (mq.addListener) mq.addListener(this._onMq);
    } catch (e) { this._mq = null; }

    // animated parameters: cur eases toward tgt
    this._tgt = { ...BASE };
    this._cur = { ...BASE };
    this._scale = 1; this._scaleV = 0;
    this._base = (opts.palette || ['#3d7bff', '#4fd2ff', '#8f6bff', '#ff8ad8']).map(hexRgb);
    this._baseTgt = this._base.map((c) => [...c]);
    this._pal = this._base.map((c) => [...c]);
    // two tint layers (state, mood): colors and amounts both ease
    this._tintS = { rgb: TINT_RGB.CYAN.map((c) => [...c]), amt: 0, tgt: null, tgtAmt: 0 };
    this._tintM = { rgb: TINT_RGB.WARM.map((c) => [...c]), amt: 0, tgt: null, tgtAmt: 0 };

    // integrated phases (so speed changes never jump)
    this._flow = 0; this._yaw = 0.35; this._ripple = 0; this._bounceP = 0; this._pulseP = 0; this._breathP = 0;
    // transients
    this._kick = 0; this._flash = 0; this._nod = 0;
    this._open = 0; this._energy = 0; this._openFloor = 0; this._ripCool = 0; this._listenT = 0;
    this._openPeak = 0.3; this._openV = 0; this._syl = 0;   // voice: running peak, normalized openness, syllable pulse
    this._accent = 0; this._surpT = 0;                    // surprise: gold ring accent and its ring train
    this._rip = [];
    for (let i = 0; i < MAX_RIPPLES; i++) this._rip.push({ dir: [0, 0, 1], age: 9, amp: 0, acc: 0 });
    this._ripBuf = new Float32Array(MAX_RIPPLES * 4);
    this._ripKBuf = new Float32Array(MAX_RIPPLES * 3);
    this._seed = 7;
    // pointer look
    this._look = [0, 0]; this._lookTgt = [0, 0]; this._lookHold = 0;

    // listen before the first GL call so a context lost during start-up can still be restored
    this._onLost = (e) => { e.preventDefault(); this._lost = true; this._stop(); this._armLostTimer(); };
    this._onRestored = () => {
      if (this._dead) return;
      clearTimeout(this._lostTimer); this._lostTimer = 0;
      let ok = false;
      this._nCap = FACE_STEPS[0];            // the GPU may have changed: measure again from full density
      try { ok = this._initGL(); } catch (err) { this._fail('restore', err); return; }
      if (!ok) return;                       // lost again mid-restore: the next webglcontextrestored retries
      this._lost = false; this._failed = false; this.failed = false; this._failSent = false;
      this._wdReset(); this._runT = 0; this._radSnap = true;
      this._resize();
      this._stop();
      this._wake();
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    try {
      if (!this._initGL()) { this._lost = true; this._armLostTimer(); }   // lost at birth: wait for webglcontextrestored
    } catch (err) {
      canvas.removeEventListener('webglcontextlost', this._onLost);
      canvas.removeEventListener('webglcontextrestored', this._onRestored);
      throw err;
    }
    this._retarget();

    this._resize();
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._resize(); this._wake(); });
      this._ro.observe(canvas);
    } else {
      this._onWinResize = () => { this._resize(); this._wake(); };
      window.addEventListener('resize', this._onWinResize);
    }
    // scrolled or clipped out of view: skip drawing
    if (typeof IntersectionObserver !== 'undefined') {
      this._io = new IntersectionObserver((es) => {
        this._offscreen = !es[es.length - 1].isIntersecting;
        if (this._offscreen) this._stop(); else this._wake();
      });
      this._io.observe(canvas);
    }
    // a hidden page gets no frames at all; start again (with a fresh frame clock) when it is shown
    this._onVis = () => { if (document.hidden) this._stop(); else this._wake(); };
    try { document.addEventListener('visibilitychange', this._onVis); } catch (e) { this._onVis = null; }
    this._wake();
  }

  // ---- public API
  // paused: stop the frame loop entirely (another renderer is showing, or the stage is covered)
  get paused() { return this._paused; }
  set paused(v) {
    v = !!v;
    if (v === this._paused) return;
    this._paused = v;
    if (v) this._stop(); else this._wake();
  }
  get time() { return this._t; }
  set time(v) {
    const t = +v || 0, d = t - this._t, c = this._cur;
    // shift the integrated phases by the jump at the current rates, so driving time frame by frame plays
    // at the same pace as free running and a rate change never rescales the whole elapsed time
    this._flow += d * c.speed * (1 + this._energy * 0.8);
    this._yaw += d * c.spin;
    this._ripple += d * 9;
    this._bounceP += d * c.bounceHz * Math.PI * 2;
    this._pulseP += d * c.pulseHz * Math.PI * 2;
    this._breathP += d * (this.state === 'sleeping' ? 0.55 : 1.05);
    this._t = t;
    this._timeSet = true;
    // scrubbing while paused still shows the frame
    if (this.paused && !this._lost && !this._failed && !this._dead && this._sized) { this._update(0, 0); this._render(0); }
  }

  setPalette(stops) {
    if (!stops || stops.length < 4) return;
    this._baseTgt = stops.slice(0, 4).map(hexRgb);
  }
  setMood(name) {
    const m = MOODS[name] ? name : 'neutral';
    if (m !== this.mood) {
      if (m === 'surprised') {                // quick expansion that overshoots, with a flash and a burst ring
        this._kick = 1; this._scaleV += 1.6; this._flash = 1; this._surpT = 0.55;
        this._spawnRipple([0, 0, 1], 1.1, 1); this._spawnRipple([0, 0.5, 0.86], 0.6, 1);
      }
      if (m === 'happy' || m === 'laughing') this._spawnRipple([0, 0.2, 1], 0.7);
    }
    this.mood = m;
    this._retarget();
  }
  setState(state) {
    const s = STATES[state] ? state : 'idle';
    if (s === 'listening' && this.state !== 'listening') { this._scaleV += 0.8; this._listenT = 0.9; }   // inhale
    this.state = s;
    this._retarget();
  }
  setViewport(top, bottom) {
    this._top = +top || 0; this._bottom = +bottom || 0;
    this._layout();
  }
  lookAt(nx, ny, holdSec = 2.5) {
    this._lookTgt[0] = Math.max(-1.2, Math.min(1.2, +nx || 0));
    this._lookTgt[1] = Math.max(-1.2, Math.min(1.2, +ny || 0));
    this._lookHold = +holdSec || 0;
  }
  flashBrows() { this._flash = 1; this._spawnRipple([0, 0.55, 0.83], 0.9); }
  nod() { this._nod = 1; this._spawnRipple([0, 0, 1], 0.8); }
  hit(x, y) { return Math.hypot(x - this.cx, y - this.cy) <= this.radius * this._radK * (this._scale || 1) * 1.12; }

  destroy() {
    this._dead = true; this._lost = true;
    this._stop();
    clearTimeout(this._lostTimer); this._lostTimer = 0;
    if (this._onVis) { try { document.removeEventListener('visibilitychange', this._onVis); } catch (e) { /* ignore */ } }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._io) { this._io.disconnect(); this._io = null; }
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    if (this._mq && this._onMq) {
      try {
        if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
        else if (this._mq.removeListener) this._mq.removeListener(this._onMq);
      } catch (e) { /* ignore */ }
    }
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this.mouthSource = null;
    this._onFail = null;
    const gl = this.gl;
    try {
      for (const b of [this._posBuf, this._seedBuf, this._quadBuf, this._triBuf]) if (b) gl.deleteBuffer(b);
      for (const p of [this._prog, this._gprog, this._cprog]) if (p) gl.deleteProgram(p);
      if (this._fb) gl.deleteFramebuffer(this._fb);
      if (this._fbTex) gl.deleteTexture(this._fbTex);
    } catch (e) { /* context may be gone */ }
  }

  // ---- internals
  _rand() { this._seed = (this._seed * 16807) % 2147483647; return (this._seed - 1) / 2147483646; }

  // Tell the app the orb cannot do its job, through opts.onFail(reason, error) and an 'orbfail' event on the
  // canvas (detail: { reason, error }). 'restore': the GPU came back but the orb could not rebuild, so it stops
  // drawing. 'lost': the WebGL context was lost and not restored within LOST_WAIT (the browser may have blocked
  // WebGL for the page); it stops drawing, and a restore that still arrives later brings it back.
  // 'slow': frames stay very slow even at the lowest density and drawing is shown to be the cause; it keeps
  // drawing and the app may switch.
  _fail(reason, err) {
    if (reason === 'restore' || reason === 'lost') {
      this._failed = true; this.failed = true; this._lost = true;
      this._stop();
    } else if (this._failSent) return;
    this._failSent = true;
    try { if (this._onFail) this._onFail(reason, err || null); } catch (e) { /* app callback */ }
    try { this.canvas.dispatchEvent(new CustomEvent('orbfail', { detail: { reason, error: err || null } })); } catch (e) { /* old browsers */ }
  }

  _armLostTimer() {
    clearTimeout(this._lostTimer);
    this._lostTimer = setTimeout(() => {
      this._lostTimer = 0;
      if (this._lost && !this._dead && !this._failed) this._fail('lost');
    }, LOST_WAIT);
  }

  // Frame loop control. The loop only runs while it can draw: pausing, going offscreen, hiding the page or
  // losing the context stops it (no idle wake-ups), and _wake() starts it again when that changes.
  _stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._poll);
    this._raf = 0; this._poll = 0;
    if (this._wd.probe && this._wd.probe.dir === 0) { this._blank = false; this._wd.probe = null; }   // a blank probe cut short says nothing
    this._idle();
  }
  _wake() {
    if (this._dead || this._raf || this._paused || this._lost || this._failed || this._offscreen) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    clearTimeout(this._poll); this._poll = 0;
    this._idle();
    this._last = performance.now();
    this._raf = requestAnimationFrame(() => this._loop());
  }
  // hidden by CSS or not laid out yet: look again a few times a second instead of every frame
  _later() {
    if (!this._poll) this._poll = setTimeout(() => { this._poll = 0; this._chk = 29; this._wake(); }, 250);
  }

  // acc = 1: an accent ring (surprise): its core takes on the gold accent color
  _spawnRipple(dir, amp, acc = 0) {
    let k = 0;
    for (let i = 1; i < MAX_RIPPLES; i++) if (this._rip[i].age > this._rip[k].age) k = i;
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    this._rip[k] = { dir: [dir[0] / l, dir[1] / l, dir[2] / l], age: 0, amp: amp * (this.reduced ? 0.4 : 1), acc };
  }

  _retarget() {
    const s = { ...BASE, ...STATES[this.state] };
    const m = MOODS[this.mood] || {};
    for (const k of NUM_KEYS.concat('scale')) {
      if (m[k + '*'] !== undefined) s[k] *= m[k + '*'];
      if (m[k + '+'] !== undefined) s[k] += m[k + '+'];
    }
    if (m.bounceHz) s.bounceHz = m.bounceHz;
    if (m.sat !== undefined) s.sat *= m.sat;
    if (m.droop !== undefined) s.droop += m.droop;
    if (this.reduced) {
      s.speed *= 0.5; s.spin *= 0.5; s.bounce *= 0.25; s.pulse *= 0.5; s.swirl *= 0.6; s.twist *= 0.7;
    }
    this._tintS.tgt = s.tint; this._tintS.tgtAmt = s.tint ? s.tintAmt : 0;
    this._tintM.tgt = m.tint || null; this._tintM.tgtAmt = m.tint ? m.tintAmt : 0;
    this._tgt = s;
  }

  // Returns false (without throwing) when the context is lost part way, since a lost context may hand back
  // null objects; the next webglcontextrestored event builds again. Throws only on a real compile/link error.
  _initGL() {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    const sh = (type, src) => {
      const o = gl.createShader(type);
      if (!o) return null;
      gl.shaderSource(o, src); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) {
        if (gl.isContextLost()) return null;
        throw new Error('HoloOrb shader compile failed: ' + gl.getShaderInfoLog(o));
      }
      return o;
    };
    const program = (vs, fs, attrs) => {
      const p = gl.createProgram();
      const v = p && sh(gl.VERTEX_SHADER, vs);
      const f = v && sh(gl.FRAGMENT_SHADER, fs);
      if (!f) return null;
      gl.attachShader(p, v);
      gl.attachShader(p, f);
      attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        if (gl.isContextLost()) return null;
        throw new Error('HoloOrb program link failed: ' + gl.getProgramInfoLog(p));
      }
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        if (!info) continue;
        const name = info.name.replace(/\[0\]$/, '');
        u[name] = gl.getUniformLocation(p, info.name);
      }
      return { p, u };
    };
    const dot = program(VS, FS, ['aPos', 'aSeed']);
    const glow = dot && program(GLOW_VS, GLOW_FS, ['aCorner']);
    const comp = glow && program(COMP_VS, COMP_FS, ['aCorner']);
    if (!comp) return false;
    this._prog = dot.p; this._u = dot.u;
    this._gprog = glow.p; this._gu = glow.u;
    this._cprog = comp.p; this._cu = comp.u;
    // tone-map target (allocated at the canvas size on first draw) and a triangle that covers the viewport
    this._triBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this._fbTex = gl.createTexture();
    this._fb = gl.createFramebuffer();
    this._fbW = 0; this._fbH = 0; this._fbOk = false;
    // core glow disc: a fan whose polygon just encloses the unit circle (no wasted square corners)
    const SEG = 20, k = 1 / Math.cos(Math.PI / SEG), fan = [0, 0];
    for (let i = 0; i <= SEG; i++) { const a = (i / SEG) * Math.PI * 2; fan.push(Math.cos(a) * k, Math.sin(a) * k); }
    this._fanN = SEG + 2;
    this._quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.STATIC_DRAW);
    this._posBuf = gl.createBuffer();
    this._seedBuf = gl.createBuffer();
    this._N = 0;
    this._buildPoints();
    return !gl.isContextLost();
  }

  // (Re)size the tone-map target to the canvas. False when this device cannot render to it: the dots then draw
  // straight to the canvas as before (pile-ups may clip toward white, nothing else changes).
  _ensureFB(W, H) {
    if (this._fbW === W && this._fbH === H) return this._fbOk;
    const gl = this.gl;
    this._fbW = W; this._fbH = H; this._fbOk = false;
    if (!this._fb || !this._fbTex) return false;
    gl.bindTexture(gl.TEXTURE_2D, this._fbTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fbTex, 0);
    this._fbOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this._fbOk;
  }

  // lattice density: fewer dots on small screens, and fewer again if the watchdog saw the orb slow frames down
  _baseN() {
    let css = Math.min(this._w, this._h);
    if (!this._sized) css = Math.min(window.innerWidth || 800, window.innerHeight || 800);
    return css < 500 ? FACE_N_SMALL : FACE_N_LARGE;
  }
  _wantN() { return Math.min(this._baseN(), this._nCap); }
  _buildPoints() {
    const N = this._wantN();
    if (N === this._N) return;
    const gl = this.gl;
    const lat = buildLattice(N);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lat.pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._seedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, lat.seed, gl.STATIC_DRAW);
    this._N = N;
    this.pointCount = lat.count;
  }

  _resize() {
    if (this._dead) return;
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const w = r.width || c.clientWidth || 0, h = r.height || c.clientHeight || 0;
    if (w < 2 || h < 2) { this._sized = false; return; }   // display:none; the loop retries
    this._sized = true;
    this._w = w; this._h = h;
    // once the watchdog has had to shed dots, render at a lower resolution too (fewer fragments per dot)
    this._dpr = Math.min(this._wantN() < this._baseN() ? 1.5 : 2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(w * this._dpr)), H = Math.max(1, Math.round(h * this._dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this._layout();
    if (!this._lost) this._buildPoints();
  }

  _layout() {
    const w = this._w || 300, h = this._h || 300;
    const free = Math.max(40, h - this._top - this._bottom);
    this.radius = Math.max(10, Math.min(free * 0.30, w * 0.36));
    this.cx = w / 2;
    this.cy = this._top + free / 2;
    this._capR = 0.46 * Math.min(w, free);   // the settled silhouette stays inside this
    this._edgeR = 0.48 * Math.min(w, free);  // quick swells may reach this (less the dot radius), never further
  }

  // asleep and settled: the orb barely moves, so it draws at about 20 fps
  _dozing() {
    return this.state === 'sleeping' && this._cur.speed < 0.1 && Math.abs(this._scale - this._tgt.scale) < 0.01;
  }

  _loop() {
    this._raf = 0;
    if (this._dead) return;
    const now = performance.now();
    const raw = (now - this._last) / 1000;
    this._last = now;
    if (++this._chk % 30 === 0) {
      try { this._visible = getComputedStyle(this.canvas).visibility !== 'hidden'; } catch (e) { this._visible = true; }
    }
    // stopped: whatever stopped it (unpause, back on screen, page shown, context restored) calls _wake()
    if (this._paused || this._lost || this._failed || this._offscreen ||
        (typeof document !== 'undefined' && document.hidden)) { this._idle(); return; }
    if (!this._visible) { this._idle(); this._later(); return; }
    // the canvas may start hidden (0x0) and be shown later: recover the size here too
    if (!this._sized || (this._chk % 30 === 0 && Math.abs(this.canvas.clientWidth - this._w) > 1.5)) {
      this._resize();
      if (!this._sized) { this._idle(); this._later(); return; }
    }
    this._raf = requestAnimationFrame(() => this._loop());
    let step = raw;
    if (this._dozing()) {
      this._acc += raw;
      if (this._acc < 0.04) return;
      step = this._acc; this._acc = 0;
      this._idle();                          // the watchdog only judges full-rate frames
    } else {
      this._acc = 0;
      this._watchdog(raw);
      if (this._dead || this._failed) return;   // the app's onFail may have destroyed the orb just now
    }
    const dt = Math.min(Math.max(step, 0), 0.1);
    const adv = this._timeSet ? 0 : dt;      // a frame right after a time set draws exactly that time
    this._timeSet = false;
    this._t += adv;
    this._update(dt, adv);
    if (!this._blank) this._render(dt);    // the watchdog's blank probe skips drawing for about a second
  }

  // not drawing: the next frame gaps say nothing about the orb's cost
  _idle() {
    this._acc = 0;
    this._wd.skip = 3;
  }

  _wdReset() {
    this._wd = { avg: 1 / 60, slowT: 0, sum: 0, n: 0, settle: 0, probe: null, upT: 0, upWait: 12, notOurs: 0, skip: 3,
      hist: new Float32Array(32), hn: 0, hi: 0, hits: 0 };
    this._blank = false;
  }
  _setCap(n) {
    this._nCap = n;
    this._wd.hn = 0;                         // recent frame times were measured at the old density
    this._resize();
  }
  // typical recent frame time at the current density: the median, so one long frame does not skew it
  _wdRecent() {
    const w = this._wd;
    if (w.hn < 8) return w.avg;
    const a = Array.from(w.hist.subarray(0, w.hn)).sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  // Frame-time watchdog. The gap between frames also grows when the browser caps rAF (30 Hz in Low Power
  // Mode or Energy Saver) or other code keeps the main thread busy, so a density change only sticks when it
  // measurably changes the frame time: a step down that does not speed frames up is undone (and that cadence
  // is then treated as not ours), and every so often a step back up is tried and kept if frames do not slow.
  // At the lowest density it only reports 'slow' when, three times in a row, a blank probe (about a second of not
  // drawing, between a second of drawing before and after) shows frames clearly faster only while the orb is off.
  _watchdog(raw) {
    const w = this._wd;
    if (raw <= 0) return;
    // a gap this long is not a frame: the tab was in the background, or one long task held the main thread.
    // Treat it like a pause, and also skip the catch-up frames right after it.
    if (raw > 0.25) { this._idle(); return; }
    this._runT += raw;
    if (this._runT < 3) return;
    if (w.skip > 0) { w.skip--; return; }
    const f = raw;
    w.avg += (f - w.avg) * (1 - Math.exp(-f / 0.6));   // about 0.6 s memory at any frame rate
    w.hist[w.hi] = f; w.hi = (w.hi + 1) % w.hist.length; w.hn = Math.min(w.hn + 1, w.hist.length);
    if (w.avg < 0.02) { w.notOurs = 0; w.hits = 0; }   // fast frames: whatever capped the rate before is gone

    if (w.probe) {
      if (w.settle > 0) { w.settle -= f; return; }      // let new buffers and canvas size settle first
      w.sum += f; w.n++;
      if (w.sum < (w.probe.dir === 0 ? 1 : 2.5) || w.n < 6) return;
      const p = w.probe, mean = w.sum / w.n;
      w.probe = null; w.slowT = 0; w.upT = 0;
      if (p.dir === 0) {                     // blank probe at the lowest density
        if (this._blank) {                   // the blank second is over: draw again for a second to compare
          this._blank = false;
          p.blank = mean; w.probe = p; w.sum = 0; w.n = 0; w.settle = 0.1;
          return;
        }
        // slow while drawing before and after, fast only in between while not drawing: the orb is the cost.
        // Something else that stopped being slow during the blank second shows up as fast frames after it.
        const ours = p.blank < p.before * 0.6 && p.blank < mean * 0.6;
        if (!ours) { w.hits = 0; w.notOurs = Math.max(p.before, mean); }   // drawing is not the problem
        else if (++w.hits >= 3) this._fail('slow');                        // shown three times in a row: report it
        w.avg = mean;
        return;
      }
      w.avg = mean;
      if (p.dir < 0) {
        if (mean > p.before * 0.88) { w.notOurs = p.before; this._setCap(p.from); }   // fewer dots did not help
      } else if (mean > Math.max(p.before * 1.12, 0.0185)) {
        this._setCap(p.from); w.upWait = Math.min(240, w.upWait * 2);   // more dots slowed frames: back off
      } else w.upWait = 12;
      return;
    }

    const probe = (dir, n) => {
      w.probe = { dir, from: this._nCap, before: this._wdRecent() };
      w.sum = 0; w.n = 0; w.settle = 0.5; w.slowT = 0; w.upT = 0;
      this._setCap(n);
    };
    const slow = w.avg > 0.022 && !(w.notOurs && w.avg < w.notOurs * 1.25);
    w.slowT = slow ? w.slowT + f : Math.max(0, w.slowT - f);
    if (w.slowT > 4) {
      w.slowT = 0;
      const next = FACE_STEPS.find((n) => n < this._N);
      if (next) probe(-1, next);
      else if (!this._failSent && this._wdRecent() > 0.06) {   // lowest density and still under ~16 fps
        w.probe = { dir: 0, from: this._nCap, before: this._wdRecent() };
        w.sum = 0; w.n = 0; w.settle = 0.25; w.upT = 0;
        this._blank = true;
      }
    } else if (!slow && this._N < this._baseN()) {
      w.upT += f;
      if (w.upT > w.upWait) {
        const up = FACE_STEPS.filter((n) => n > this._N).pop();
        if (up) probe(1, up);
      }
    }
  }

  _update(dt, adv = dt) {
    const cur = this._cur, tgt = this._tgt;
    const snap = this._snap;
    const k = snap ? 1 : 1 - Math.exp(-dt * 3.2);
    for (const key of NUM_KEYS) cur[key] = lerp(cur[key], tgt[key], k);

    // scale spring: surprise overshoots, listening inhales
    if (snap) { this._scale = tgt.scale; this._scaleV = 0; } else if (dt > 0) {
      const steps = Math.min(30, Math.ceil(dt / 0.016));
      for (let i = 0; i < steps; i++) {
        const h = dt / steps;
        this._scaleV += ((tgt.scale - this._scale) * 60 - this._scaleV * 9) * h;
        this._scale += this._scaleV * h;
      }
    }

    // palette: the base eases to the chosen colorway, then the state and mood tints mix in HSL
    const kp = snap ? 1 : 1 - Math.exp(-dt * 2.5);
    for (let s = 0; s < 4; s++) for (let i = 0; i < 3; i++) this._base[s][i] = lerp(this._base[s][i], this._baseTgt[s][i], kp);
    for (const T of [this._tintS, this._tintM]) {
      if (T.tgt) {
        const src = TINT_RGB[T.tgt];
        // a tint that was fully off adopts its new colors at once; otherwise the colors ease over
        const kc = snap || T.amt < 0.01 ? 1 : k;
        for (let s = 0; s < 4; s++) for (let i = 0; i < 3; i++) T.rgb[s][i] = lerp(T.rgb[s][i], src[s][i], kc);
      }
      T.amt = lerp(T.amt, T.tgtAmt, k);
    }
    for (let s = 0; s < 4; s++) {
      let c = this._base[s];
      if (this._tintS.amt > 0.002) c = mixHsl(c, this._tintS.rgb[s], this._tintS.amt);
      if (this._tintM.amt > 0.002) c = mixHsl(c, this._tintM.rgb[s], this._tintM.amt);
      this._pal[s] = c;
    }
    this._snap = false;

    // phases advance with animation time (adv is 0 on the frame after a time set: the setter already moved them)
    this._flow += adv * cur.speed * (1 + this._energy * 0.8);
    this._yaw += adv * cur.spin;
    this._ripple += adv * 9;
    this._bounceP += adv * cur.bounceHz * Math.PI * 2;
    this._pulseP += adv * cur.pulseHz * Math.PI * 2;
    this._breathP += adv * (this.state === 'sleeping' ? 0.55 : 1.05);

    // voice: fast attack, slower release so each syllable reads
    let open = 0, energy = 0;
    let src = null;
    try { src = typeof this.mouthSource === 'function' ? this.mouthSource() : null; } catch (e) { src = null; }
    if (src) { open = Math.max(0, Math.min(1.2, +src.open || 0)); energy = Math.max(0, Math.min(1, +src.energy || 0)); }
    else if (this.state === 'speaking') { open = 0.35 + 0.3 * Math.sin(this._t * 11) * Math.sin(this._t * 3.1); energy = 0.4; }
    open *= cur.voice; energy *= cur.voice;
    this._open = lerp(this._open, open, open > this._open ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 9));
    this._energy = lerp(this._energy, energy, 1 - Math.exp(-dt * 6));
    // quiet speech still swings fully: openness is also read relative to its running peak (a few seconds)
    this._openPeak = Math.max(open, 0.12, this._openPeak * Math.exp(-dt * 0.35));
    this._openV = 0.5 * this._open + 0.5 * Math.min(1.2, this._open / Math.max(0.25, this._openPeak));

    // syllable onset: openness rises clearly above its recent floor (relative to how loud the speech is)
    // -> a ring travels across the surface and the orb pulses, at any loudness
    this._openFloor = Math.min(open, this._openFloor + dt * 1.5 * Math.max(0.25, this._openPeak));
    this._ripCool -= dt;
    if (cur.voice > 0.3 && open - this._openFloor > Math.max(0.05, 0.4 * this._openPeak) && this._ripCool <= 0) {
      this._spawnRipple([(this._rand() - 0.5) * 0.9, (this._rand() - 0.5) * 0.7, 1], 0.7 + energy * 0.6);
      this._openFloor = open; this._ripCool = 0.13;
      this._kick = Math.min(1, this._kick + 0.15 * energy);
      this._syl = 1;
    }
    this._syl *= Math.exp(-dt * 6);
    // surprised: gold rings keep coming while the mood holds, so it never settles into a plain big ball
    const surprised = this.mood === 'surprised';
    this._accent = lerp(this._accent, surprised ? 1 : 0, snap ? 1 : 1 - Math.exp(-dt * (surprised ? 8 : 1.5)));
    if (surprised) {
      this._surpT -= dt;
      if (this._surpT <= 0) {
        this._spawnRipple([(this._rand() - 0.5) * 1.4, (this._rand() - 0.5) * 1.1, 1], 0.5, 1);
        this._surpT = 0.6;
      }
    }
    // listening: an attentive pulse ring from the front every 1.4 s
    if (this.state === 'listening') {
      this._listenT -= dt;
      if (this._listenT <= 0) { this._spawnRipple([0, 0.1, 1], 0.75); this._listenT = 1.4; }
    }
    for (const r of this._rip) r.age += dt;

    // transients
    this._kick *= Math.exp(-dt * 3.0);
    this._flash *= Math.exp(-dt * 5.5);
    this._nod *= Math.exp(-dt * 3.2);

    // pointer look: hold, then drift home
    if (this._lookHold > 0) this._lookHold -= dt; else { this._lookTgt[0] = 0; this._lookTgt[1] = 0; }
    const kl = 1 - Math.exp(-dt * 4);
    this._look[0] = lerp(this._look[0], this._lookTgt[0], kl);
    this._look[1] = lerp(this._look[1], this._lookTgt[1], kl);
  }

  _render(dt) {
    const gl = this.gl, c = this._cur;
    const W = this.canvas.width, H = this.canvas.height;
    const tone = this._ensureFB(W, H);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);           // the canvas
    if (tone) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fb);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

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

    const breath = Math.sin(this._breathP) * c.breath;
    const pulse = c.pulse * Math.max(0, Math.sin(this._pulseP));
    const bounce = c.bounce * Math.abs(Math.sin(this._bounceP / 2));
    const openV = this._openV;
    const scale = this._scale * (1 + breath + pulse + bounce * 0.6 + this._flash * 0.02 + openV * 0.05 + this._energy * 0.02
      + this._syl * 0.015);
    const amp = c.amp * (1 + this._energy * 0.35) * (1 - this._kick * 0.3);

    // syllable / emphasis rings: precompute the cosine of each ring front (no acos in the shader)
    let ringMax = 0;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = this._rip[i];
      const th = r.age * 1.9;                // ring front travels ~1.9 rad/s over the surface
      const a = th < 2.9 ? r.amp * Math.exp(-r.age * 1.1) * Math.min(1, (2.9 - th) / 0.5) : 0;
      this._ripBuf[i * 4] = r.dir[0]; this._ripBuf[i * 4 + 1] = r.dir[1]; this._ripBuf[i * 4 + 2] = r.dir[2];
      this._ripBuf[i * 4 + 3] = Math.cos(th);
      this._ripKBuf[i * 3] = a;
      this._ripKBuf[i * 3 + 1] = 1 / (0.2 * Math.max(Math.sin(th), 0.3));
      this._ripKBuf[i * 3 + 2] = r.acc;
      ringMax = Math.max(ringMax, a);
    }

    // dots: a smaller screen's coarser lattice gets proportionally larger dots so it reads the same; the
    // watchdog's extra steps only partly enlarge them, so shedding dots also sheds fragment work
    const baseN = Math.max(this._N, this._baseN());
    const dotK = (FACE_N_LARGE / baseN) * Math.sqrt(baseN / this._N);

    // keep the whole orb on the canvas: cap the projected silhouette radius. The cap follows slowly so quick
    // swells (a surprise overshoot, bounces, syllables) still show, and a hard limit keeps them on screen.
    // The settled estimate is generous for steady folds; the hard limit also allows for what the shader adds on
    // top (ring fronts and the syllable swell reaching the outline) and for the dots' own radius.
    const ext = Math.max(1, this.radius * scale * (1 + amp * 0.9 + 0.04 + openV * 0.03));
    // (x 1.03: the fold warp and perspective push single ridges a little past the estimate, measured up to ~2%)
    const extEdge = (ext + this.radius * scale * (0.05 * ringMax + 0.04 * openV)) * 1.03;
    const want = Math.min(1, (this._capR || 1e9) / ext);
    this._radK = this._radSnap ? want : lerp(this._radK, want, 1 - Math.exp(-dt * 1.5));
    if (this._edgeR) {
      const edge = this._edgeR - 0.65 * DOT * dotK * this.radius;
      this._radK = Math.min(this._radK, Math.max(10, edge) / extEdge);
    }
    this._radSnap = false;
    const rad = this.radius * this._radK;
    const offY = (-bounce * 1.6 + c.droop + this._nod * Math.sin((1 - this._nod) * 9) * 0.04) * rad;
    const pal = this._pal;

    const u = this._u;
    gl.useProgram(this._prog);
    gl.uniformMatrix3fv(u.uRot, false, R);
    gl.uniform2f(u.uRes, this._w, this._h);
    gl.uniform2f(u.uCenter, this.cx, this.cy + offY);
    gl.uniform1f(u.uRad, rad);
    // each syllable also swells the dots briefly: most lit dots already sit at full brightness, so more light per
    // dot would not show, but larger dots do
    gl.uniform1f(u.uDot, DOT * dotK * this._dpr * (1 + 0.14 * this._syl));
    gl.uniform1f(u.uFlow, this._flow);
    gl.uniform1f(u.uAmp, amp);
    gl.uniform1f(u.uWarp, c.warp);
    gl.uniform1f(u.uFreq, c.freq);
    gl.uniform1f(u.uSwirl, c.swirl * (1 + 0.3 * Math.sin(this._t * 0.7)));
    gl.uniform1f(u.uTwist, c.twist);
    gl.uniform1f(u.uScale, scale);
    // speech: a faint ring texture flows from the front whenever the orb talks, deepening with each syllable
    gl.uniform1f(u.uRipple, c.voice * 0.006 + openV * 0.035 + this._energy * 0.012 + this._nod * 0.02 + this._accent * 0.006);
    gl.uniform1f(u.uRipplePhase, this._ripple);
    gl.uniform1f(u.uOpen, openV);
    gl.uniform1f(u.uBright, c.bright * (1 + pulse * 4 + this._flash * 0.35 + this._kick * 0.15 + this._energy * 0.06
      + openV * 0.08 + this._syl * 0.25));
    gl.uniform3fv(u.uC0, pal[0]); gl.uniform3fv(u.uC1, pal[1]);
    gl.uniform3fv(u.uC2, pal[2]); gl.uniform3fv(u.uC3, pal[3]);
    gl.uniform1f(u.uSat, c.sat);
    gl.uniform1f(u.uShift, c.shift);
    gl.uniform1f(u.uGain, tone ? 1 / HEADROOM : 1);
    gl.uniform3fv(u.uAccent, ACCENT);
    gl.uniform1f(u.uAccentK, this._accent);
    gl.uniform4fv(u.uRip, this._ripBuf);
    gl.uniform3fv(u.uRipK, this._ripKBuf);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._seedBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, this.pointCount);
    gl.disableVertexAttribArray(1);

    // faint core glow behind the dots, drawn only as far out as it can still light a pixel. It goes into the
    // tone-map buffer with the dots (additive, so the order does not matter): added on the canvas after the
    // tone map, its blue would sum with a bright gold or pink dot to white. Capped so loud speech in an excited
    // mood does not wash the middle of the orb out.
    const glowK = Math.min(0.42, c.glow * (0.6 + 0.4 * Math.min(c.bright, 1.5))
      * (1 + openV * 0.8 + this._flash * 0.6 + pulse * 6 + this._syl * 0.5));
    const reach = Math.min(GLOW_MAX, Math.sqrt(Math.max(0.25, Math.log(Math.max(1.1, glowK * 0.9 * 600)) / 2.2)));
    const gu = this._gu;
    gl.useProgram(this._gprog);
    gl.uniform2f(gu.uCenter, this.cx, this.cy + offY);
    gl.uniform1f(gu.uRadius, rad * scale);
    gl.uniform1f(gu.uExtent, reach);
    gl.uniform2f(gu.uRes, this._w, this._h);
    gl.uniform3fv(gu.uCol0, pal[1]); gl.uniform3fv(gu.uCol1, pal[2]);
    gl.uniform1f(gu.uGlow, glowK);
    gl.uniform1f(gu.uGain, tone ? 1 / HEADROOM : 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, this._fanN);

    if (tone) {                              // tone-map the dots and glow onto the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(this._cprog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._fbTex);
      gl.uniform1i(this._cu.uTex, 0);
      gl.uniform2f(this._cu.uSize, W, H);
      gl.uniform1f(this._cu.uHead, HEADROOM);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._triBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }
}
