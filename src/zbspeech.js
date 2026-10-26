// ZB's speech front end: turns a reply into the phonemes his voice model reads.
// English goes through eSpeak (passed in as `espeak`), with an optional Miami accent on top;
// Kreyòl is spelled the way it sounds, so it's read with rules instead of an English dictionary.

// ---------- cleanup: slang, money, years ----------
const SLANG = {
  fr: 'for real', frfr: 'for real for real', rn: 'right now', ngl: 'not gonna lie', tbh: 'to be honest',
  idk: "I don't know", idc: "I don't care", ik: 'I know', yk: 'you know', ykwim: 'you know what I mean',
  imo: 'in my opinion', btw: 'by the way', nvm: 'never mind', smh: 'shaking my head', bc: 'cause', cuz: 'cause',
  u: 'you', ur: 'your', tho: 'though', pls: 'please', plz: 'please', thx: 'thanks', ty: 'thank you',
  np: 'no problem', omw: 'on my way', wya: 'where you at', wyd: 'what you doing', hbu: 'how about you',
  ppl: 'people', imma: 'Ima', ima: 'Ima', lol: '', lmao: '', lmfao: '', ong: 'on God', istg: 'I swear to God',
};
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const twoDigits = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ''));

export function normalize(text) {
  return String(text)
    .replace(/(\d),(?=\d{3}\b)/g, '$1') // 1,850 -> 1850, so the comma isn't read as a pause
    // $1,850.50 -> 1,850 dollars and 50 cents
    .replace(/\$\s?(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, d, c) => `${d} ${d === '1' ? 'dollar' : 'dollars'}${c && c !== '00' ? ` and ${+c} cents` : ''}`)
    // years read the way people say them: 2026 -> twenty twenty six, 1998 -> nineteen ninety eight
    .replace(/(^|[^\d$,.])((?:19|20)\d\d)(?!\d|[.,]\d)/g, (m, pre, y) => {
      const hi = Math.floor(+y / 100);
      const lo = +y % 100;
      if (hi === 20 && lo < 10) return `${pre}two thousand${lo ? ` ${ONES[lo]}` : ''}`;
      return `${pre}${twoDigits(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${ONES[lo]}` : twoDigits(lo)}`;
    })
    .replace(/\b[A-Za-z]+\b/g, (w) => (Object.hasOwn(SLANG, w.toLowerCase()) ? SLANG[w.toLowerCase()] : w))
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Kreyòl: which words, and how they sound ----------
// Words that only make sense as Kreyòl…
const KREYOL = new Set(`mwen sak pase boule menm tande woy kenbe fèm ale wè fasil pran dousman repoze bouke enkyete nòmal
  nève fè fou pwoblèm pwoblem bondye felisitasyon mezanmi frè sè bòn nwit dòmi byen yon manje mèsi anpil kounye kounya
  toujou kòman kouman kijan bagay lakay zanmi granmoun renmen konnen konn vle travay lajan ayiti nou ou wi sa ki kap wap
  pral dwe bèl cheri manman fanmi pitit jodi demen kote kisa poukisa paske avèk avek ak rete vini chita ede bezwen kontan
  fatige malad lopital legliz bonjou bonswa orevwa souple padon eskize enpi epi sou anba anwo lavi zafè kreyòl pou
  tankou mennen tounen`.split(/\s+/));
// …and ones that are also English words, counted as Kreyòl only next to a word above.
const SHARED = new Set(`yo la li men non ka m w n l e a o fe di al bon mal gro piti map nap tap pa se ti we pale gen bay ale
  pita ann fem pare deja tout mesi`.split(/\s+/));
const LETTER = /[\p{L}']/u;

export function splitKreyol(text) {
  const toks = text.match(/[\p{L}']+|[^\p{L}']+/gu) || [];
  const words = toks.map((t, i) => (LETTER.test(t[0]) ? i : -1)).filter((i) => i >= 0);
  const isK = new Map(words.map((i) => [i, KREYOL.has(toks[i].toLowerCase())]));
  // a shared word joins a Kreyòl word beside it (only across spaces and light punctuation)
  for (let changed = true; changed;) {
    changed = false;
    words.forEach((i, k) => {
      if (isK.get(i) || !SHARED.has(toks[i].toLowerCase())) return;
      const near = [words[k - 1], words[k + 1]].filter((j) => j !== undefined && /^[\s,/]*$/.test(toks.slice(Math.min(i, j) + 1, Math.max(i, j)).join('')));
      if (near.some((j) => isK.get(j))) {
        isK.set(i, true);
        changed = true;
      }
    });
  }
  const segs = [];
  let cur = null;
  toks.forEach((t, i) => {
    const lang = isK.has(i) ? (isK.get(i) ? 'ht' : 'en') : cur ? cur.lang : 'en';
    if (cur && cur.lang === lang) cur.text += t;
    else if (cur && !isK.has(i)) cur.text += t; // punctuation and spaces stay with the run before them
    else segs.push((cur = { lang, text: t }));
  });
  return segs;
}

const KREYOL_DIGRAPHS = [['tch', 'tʃ'], ['dj', 'dʒ'], ['ch', 'ʃ'], ['oun', 'uŋ'], ['ou', 'u'], ['àn', 'an'], ['èn', 'ɛn'], ['òn', 'ɔn'], ['ui', 'ɥi'], ['ng', 'ŋ']];
const KREYOL_LETTERS = { a: 'a', à: 'a', b: 'b', d: 'd', e: 'e', é: 'e', è: 'ɛ', f: 'f', g: 'ɡ', h: 'h', i: 'i', j: 'ʒ', k: 'k', l: 'l', m: 'm', n: 'n', o: 'o', ò: 'ɔ', p: 'p', r: 'ɣ', s: 's', t: 't', v: 'v', w: 'w', y: 'j', z: 'z', x: 'ks', c: 'k', q: 'k' };
const K_VOWEL = /[aeiouɛɔɑ]/;

export function kreyolWord(word) {
  const w = word.toLowerCase().replace(/'/g, '');
  let out = '';
  for (let i = 0; i < w.length;) {
    const pair = w.slice(i, i + 2);
    const next = w[i + 2] || '';
    if ((pair === 'an' || pair === 'en' || pair === 'on') && !/[aeiouèòy]/.test(next)) {
      // nasal vowels: closest without a nasal-vowel symbol is the vowel plus a nasal that fits what follows
      const nasal = !next ? 'ŋ' : next === 'm' ? '' : /[bp]/.test(next) ? 'm' : 'n';
      out += { an: 'ɑ', en: 'ɛ', on: 'ɔ' }[pair] + nasal;
      i += 2;
      continue;
    }
    const d = KREYOL_DIGRAPHS.find(([a]) => w.startsWith(a, i));
    if (d) {
      out += d[1];
      i += d[0].length;
    } else {
      out += KREYOL_LETTERS[w[i]] || '';
      i++;
    }
  }
  // stress falls on the last syllable
  const vowels = [...out].filter((c) => K_VOWEL.test(c)).length;
  if (vowels > 1) {
    const at = Math.max(...[...out].map((c, k) => (K_VOWEL.test(c) ? k : -1)));
    out = out.slice(0, at) + 'ˈ' + out.slice(at);
  }
  return out;
}

export function kreyol(text) {
  return (text.match(/[\p{L}']+|[^\p{L}']+/gu) || []).map((t) => (LETTER.test(t[0]) ? kreyolWord(t) : t)).join('');
}

// ---------- Miami accent: pronunciation rules on eSpeak's IPA ----------
const VOW = 'aeiouæɑɐɒɔəɚɛɜɪʊʌɝ';
const reVowelBefore = new RegExp(`([${VOW}ː])ɹ(?=$|[^${VOW}ː])`, 'g');
const reCentering = new RegExp(`([ɪʊɛe])ɹ(?=$|[^${VOW}ː])`, 'g');
const reMedialTh = new RegExp(`(?<=[${VOW}mː])θ`, 'g');

export function miami(ipa, level = 2) {
  if (!level) return ipa;
  return ipa.split(/( +)/).map((w) => {
    if (!w.trim()) return w;
    const core = w.replace(/[,.!?;:]+$/, '');
    const tail = w.slice(core.length);
    let x = core
      .replace(/^([ˈˌ]?)ð/, '$1d') // the, that, this -> da, dat, dis
      .replace(/ð$/, 't'); // with -> wit
    if (level >= 2) {
      x = x
        .replace(/^([ˈˌ]?)θ/, '$1t') // think -> tink
        .replace(reMedialTh, 'f') // nothing -> nuffin, both -> bof
        .replace(/(ˈ?)æsk/, '$1æks'); // ask -> aks
    }
    x = x
      .replace(/ɪŋ$/, 'ɪn') // -ing -> -in'
      .replace(/ɚ/g, 'ə') // brother -> brotha
      .replace(/^([ˈˌ]?)jʊɹ$/, '$1joʊ') // your -> yo
      .replace(reCentering, '$1ə') // here -> heah, there -> theah
      .replace(reVowelBefore, '$1'); // for real -> fo real, car -> cah
    // final clusters: just -> jus, and -> an, told -> tol, left -> lef
    if (x.length > 3) x = x.replace(/(?<=[sfkp])t$|(?<=[nl])d$|(?<=s)k$/, '');
    if (level >= 2) x = x.replace(/aɪ(?![ptkfsθʃ])/g, 'aː'); // I, my, time -> ah, mah, tahm
    else if (/^[ˈˌ]?m?aɪ$/.test(x)) x = x.replace('aɪ', 'aː');
    return x + tail;
  }).join('');
}

// ---------- the whole pipeline ----------
const PUNCT = /(\s*[;:,.!?¡¿—…"«»“”()[\]{}]+\s*)/;

async function englishIpa(text, espeak) {
  const out = [];
  for (const part of text.split(PUNCT)) {
    if (!part) continue;
    if (PUNCT.test(part)) {
      // keep the pauses the voice understands
      const p = part.trim().replace(/[—…]/g, (c) => (c === '—' ? ',' : '.')).replace(/[^;:,.!?]/g, '');
      out.push(p ? `${p} ` : ' ');
    } else if (part.trim()) out.push((await espeak(part.trim())).join(' '));
  }
  return out.join('');
}

export async function toPhonemes(text, { espeak, accent = 0 }) {
  const parts = [];
  for (const seg of splitKreyol(normalize(text))) {
    if (!seg.text.trim()) continue;
    if (seg.lang === 'ht') parts.push(kreyol(seg.text).replace(/[—…"“”«»()]/g, ''));
    else parts.push(miami(await englishIpa(seg.text, espeak), accent));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function toIds(ipa, map) {
  const ids = [...map['^']];
  for (const ch of ipa) if (map[ch]) ids.push(...map[ch], ...map._);
  ids.push(...map.$);
  return ids;
}
