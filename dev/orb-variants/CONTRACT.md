# HoloOrb contract

Write ONE self-contained ES module (no imports except optionally `../../src/palettes.js`, no external libraries)
that exports `class HoloOrb`. It renders a luminous, shape-shifting point-cloud orb with raw WebGL 1 (GLSL ES 1.00)
on the canvas it is given. It replaces a talking face in a voice assistant app, so it must be expressive.

## API (the app calls exactly these)
```
const orb = new HoloOrb(canvas, { palette: ['#3d7bff','#4fd2ff','#8f6bff','#ff8ad8'] })
  // throws an Error if WebGL is unavailable (the app falls back to another renderer)
orb.setPalette(stops)          // 4 hex strings, top -> bottom gradient; animate the change smoothly
orb.setMood(name)              // neutral happy amused laughing thinking surprised concerned serious confident listening sad sleeping (unknown -> neutral)
orb.setState(state)            // 'idle' | 'listening' | 'thinking' | 'speaking' | 'sleeping'
orb.setViewport(top, bottom)   // CSS px reserved by HUD at top and chat dock at bottom; center the orb in the free area
orb.lookAt(nx, ny, holdSec=2.5)// pointer in roughly [-1,1]; tilt/turn the orb toward it for holdSec
orb.flashBrows()               // a small, quick emphasis pulse (called on some spoken words)
orb.nod()                      // a small ripple / bob emphasis
orb.hit(x, y)                  // CSS px relative to canvas -> true if over the orb
orb.mouthSource = () => ({ open, wide, energy }) | null   // polled every frame; non-null while speaking.
                               // open 0..1.2 (syllable openness), energy 0..1 (loudness). Drive voice reactivity from these.
orb.paused = true|false        // when true, skip rendering (another renderer is showing)
orb.time                       // seconds of animation time; tests may SET it to freeze a moment (advance by dt each frame)
orb.cx, orb.cy                 // CSS px center of the orb on the canvas
orb.state, orb.mood            // current values
orb.reduced                    // true if prefers-reduced-motion; calmer motion
```

## Requirements
- Look: match the quality of `dev/orb-variants/reference.png`: thousands of crisp round dots on a sphere-like surface,
  organically deformed into soft folds by flowing 3D noise, luminous gradient color (blue/cyan top -> violet/pink bottom
  for the default palette), additive glow, dense bright ridges where the surface folds or turns away. Transparent background
  (the page paints a dark background behind the canvas).
- Alive: always gently morphing and slowly rotating. States must read at a glance:
  idle = calm breathing; listening = opens up, brighter, attentive pulse; thinking = faster swirling turbulence;
  speaking = deformation and ripples driven by mouthSource energy/open, every syllable visible;
  sleeping = dim, slow, contracted. Moods tint and reshape it (happy warmer/bouncier, concerned contracts/cools,
  surprised quick expansion, laughing rapid bounces, serious tight and still, etc.).
- Size: orb radius about min(free height * 0.30, width * 0.36). Position via setViewport.
- Tech: WebGL 1 only. `precision highp float` in the vertex shader, mediump OK in fragment. No float textures, no
  extensions required. Must compile on iOS Safari and Android Chrome. Point count <= 26000 (fewer on small screens is fine).
  devicePixelRatio capped at 2. ResizeObserver on the canvas. Handle `webglcontextlost` (preventDefault, stop) and
  `webglcontextrestored` (re-init). Respect prefers-reduced-motion. requestAnimationFrame loop that skips work while
  `document.hidden` or `paused`. Use additive blending, no depth test.
- Write simplex noise in GLSL yourself (the standard Ashima/stegu 3D snoise is fine).

## Testing
Harness: `dev/orb-test.html?v=<LETTER>&state=idle&mood=neutral&energy=0&palette=aurora&t=12`
(`t` freezes time at that many seconds; `energy` fakes speech). Screenshot it with:
`node dev/shot.mjs . '[{"url":"dev/orb-test.html?v=A&t=12","out":"dev/orb-variants/shots/A-idle.png","w":600,"h":700,"wait":1500}]'`
then Read the PNG and compare with `dev/orb-variants/reference.png`. The shot script prints page errors (GLSL compile errors must be thrown
with the info log so they show up). Iterate until it looks as good as the reference.
