// Avatar: the one "face" the app talks to. It is backed by the WebGL orb (default) or the
// canvas hologram head, and carries mood, state and layout across when the look changes.
import { HoloFace } from './face.js';
import { HoloOrb } from './orb.js';

export class Avatar {
  constructor({ orbCanvas, faceCanvas, look, palette, faceColor, faceOptions }) {
    this.canvases = { orb: orbCanvas, face: faceCanvas };
    this.r = {};
    this.mood = 'neutral';
    this.state = 'idle';
    this.vp = [0, 0];
    this._mouth = null;
    this.palette = palette;
    this.faceColor = faceColor;
    this.faceOpts = faceOptions;
    this.orbFailed = false;
    this.use(look);
  }

  _make(look) {
    if (this.r[look]) return this.r[look];
    let r;
    if (look === 'orb') {
      if (this.orbFailed) return null;
      try {
        r = new HoloOrb(this.canvases.orb, {
          palette: this.palette,
          // the GPU gave up (e.g. context lost for good): switch to the canvas head
          onFail: () => {
            this.orbFailed = true;
            try {
              this.r.orb?.destroy?.();
            } catch (e) {
              /* already gone */
            }
            delete this.r.orb;
            if (this.look === 'orb') this.use('face');
            this.onFallback?.();
          },
        });
      } catch (e) {
        console.warn('3D orb unavailable on this device; using the hologram head instead.', e);
        this.orbFailed = true;
        return null;
      }
    } else {
      r = new HoloFace(this.canvases.face);
      r.setColor(this.faceColor);
      r.setOptions(this.faceOpts);
    }
    this.r[look] = r;
    r.mouthSource = this._mouth;
    return r;
  }

  use(look) {
    let r = this._make(look);
    if (!r) {
      look = 'face';
      r = this._make('face');
    }
    for (const [k, c] of Object.entries(this.canvases)) c.hidden = k !== look;
    for (const [k, x] of Object.entries(this.r)) x.paused = !!this.covered || k !== look;
    this.look = look;
    this.cur = r;
    r.setViewport(...this.vp);
    r.setState(this.state);
    r.setMood(this.mood);
    return look;
  }

  // Stop drawing while something covers the stage (saves battery on phones).
  setCovered(covered) {
    this.covered = covered;
    for (const [k, x] of Object.entries(this.r)) x.paused = covered || k !== this.look;
  }

  setMood(m) {
    this.mood = m;
    this.cur.setMood(m);
  }
  setState(s) {
    this.state = s;
    if (s === 'sleeping') this.mood = 'sleeping';
    else if (this.mood === 'sleeping') this.mood = 'neutral';
    this.cur.setState(s);
  }
  setViewport(top, bottom) {
    this.vp = [top, bottom];
    for (const r of Object.values(this.r)) r.setViewport(top, bottom);
  }
  setPalette(stops) {
    this.palette = stops;
    this.r.orb?.setPalette(stops);
  }
  setFaceLook(color, opts) {
    this.faceColor = color;
    this.faceOpts = opts;
    this.r.face?.setColor(color);
    this.r.face?.setOptions(opts);
  }
  set mouthSource(f) {
    this._mouth = f;
    for (const r of Object.values(this.r)) r.mouthSource = f;
  }
  get mouthSource() {
    return this._mouth;
  }
  lookAt(...a) {
    this.cur.lookAt(...a);
  }
  flashBrows() {
    this.cur.flashBrows();
  }
  nod() {
    this.cur.nod();
  }
  hit(x, y) {
    return this.cur.hit(x, y);
  }
  get cx() {
    return this.cur.cx;
  }
  get cy() {
    return this.cur.cy;
  }
}
