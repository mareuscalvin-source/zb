// The mirror: ZB learns how the user talks from their own words ("Be Right Back" style).
// A distilled profile plus verbatim samples go into every prompt; new messages are collected
// as samples and every so often Claude re-studies them to update the profile.
import SEED from './mirror-seed.json';

export { SEED };
export const STUDY_EVERY = 12; // new samples between automatic re-studies
export const MAX_SAMPLES = 80;
export const PROMPT_SAMPLES = 20; // recent learned samples sent with each message

// The profile and phrases stay empty until a study writes them, so improvements to the seed
// reach everyone who hasn't been studied yet. Seed samples always come from SEED.
export function defaultMirror() {
  return { v: 2, learn: true, profile: '', phrases: [], samples: [], since: 0, studiedAt: 0 };
}

export function upgradeMirror(m) {
  const out = { ...defaultMirror(), ...m };
  if ((m.v || 1) < 2) {
    out.samples = (m.samples || []).filter((s) => s.src !== 'seed');
    if (!m.studiedAt) {
      out.profile = '';
      out.phrases = [];
    }
    out.v = 2;
  }
  return out;
}

export const fillUser = (text, user) => String(text || '').replaceAll('{{USER}}', user);
export const mirrorProfileOf = (m, user) => fillUser(m.profile || SEED.mirrorProfile, user);
export const mirrorPhrasesOf = (m) => (m.phrases && m.phrases.length ? m.phrases : SEED.signaturePhrases);

// Worth learning from: real sentences, not one-word commands or wake words.
export function isGoodSample(text) {
  const t = String(text || '').trim();
  if (t.length < 12 || t.length > 1500) return false;
  return t.split(/\s+/).length >= 3;
}

export function studyInput({ user, mirror }) {
  const all = [...SEED.seedSamples, ...mirror.samples.filter((s) => s.src !== 'seed').slice(-50).map((s) => s.t)];
  const samples = all.map((t) => `- "${t.replace(/\s+/g, ' ').slice(0, 600)}"`).join('\n');
  return SEED.studyPrompt
    .replaceAll('{{USER}}', user)
    .replaceAll('{{PROFILE}}', mirrorProfileOf(mirror, user))
    .replaceAll('{{SAMPLES}}', samples);
}

export function parseStudy(v) {
  let o = v;
  if (typeof v === 'string') {
    const a = v.indexOf('{');
    const b = v.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      o = JSON.parse(v.slice(a, b + 1));
    } catch (e) {
      return null;
    }
  }
  if (!o || typeof o.mirrorProfile !== 'string' || o.mirrorProfile.trim().length < 80) return null;
  return {
    profile: o.mirrorProfile.trim().slice(0, 9000),
    phrases: Array.isArray(o.signaturePhrases) ? o.signaturePhrases.map(String).slice(0, 30) : [],
  };
}
