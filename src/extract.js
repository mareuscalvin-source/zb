// Pull readable text out of the files people drop into ZB's Vault.
// Office files are zip archives of XML, so they're read with fflate + DOMParser;
// PDFs use Mozilla's pdf.js, loaded on demand from lib/pdf.js (shipped with the app).
import { unzipSync, strFromU8 } from 'fflate';

export const MAX_CHARS = 150000;

const ext = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'html', 'htm', 'js', 'ts', 'py', 'css', 'yml', 'yaml', 'ini', 'rtf', 'srt', 'vtt']);

export function kindOf(file) {
  const e = ext(file.name);
  const t = file.type || '';
  if (t.startsWith('image/') || ['heic', 'heif', 'jpg', 'jpeg', 'png', 'gif', 'webp'].includes(e)) return 'image';
  if (t === 'application/pdf' || e === 'pdf') return 'pdf';
  if (e === 'docx') return 'docx';
  if (e === 'xlsx' || e === 'xlsm') return 'xlsx';
  if (e === 'pptx') return 'pptx';
  if (t.startsWith('text/') || t === 'application/json' || TEXT_EXT.has(e)) return 'text';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'other';
}

function xml(u8) {
  return new DOMParser().parseFromString(strFromU8(u8), 'application/xml');
}
const byTag = (node, tag) => Array.from(node.getElementsByTagName(tag));

function docxText(zip) {
  const doc = zip['word/document.xml'];
  if (!doc) return '';
  const out = [];
  for (const p of byTag(xml(doc), 'w:p')) {
    let line = '';
    for (const n of byTag(p, '*')) {
      if (n.nodeName === 'w:t') line += n.textContent;
      else if (n.nodeName === 'w:tab') line += '\t';
      else if (n.nodeName === 'w:br') line += '\n';
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function colIndex(ref) {
  const letters = String(ref).replace(/[0-9]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(zip) {
  const shared = zip['xl/sharedStrings.xml']
    ? byTag(xml(zip['xl/sharedStrings.xml']), 'si').map((si) => byTag(si, 't').map((t) => t.textContent).join(''))
    : [];
  const wb = zip['xl/workbook.xml'] ? xml(zip['xl/workbook.xml']) : null;
  const rels = zip['xl/_rels/workbook.xml.rels'] ? xml(zip['xl/_rels/workbook.xml.rels']) : null;
  const target = {};
  if (rels) for (const r of byTag(rels, 'Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');
  const sheets = wb
    ? byTag(wb, 'sheet').map((s) => {
      const t = target[s.getAttribute('r:id')] || '';
      return { name: s.getAttribute('name'), path: t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\.\//, '')}` };
    })
    : Object.keys(zip).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).map((p, i) => ({ name: `Sheet ${i + 1}`, path: p }));
  const parts = [];
  let total = 0;
  for (const s of sheets) {
    const data = zip[s.path];
    if (!data) continue;
    const lines = [`## ${s.name}`];
    for (const row of byTag(xml(data), 'row').slice(0, 3000)) {
      const cells = [];
      for (const c of byTag(row, 'c')) {
        const t = c.getAttribute('t');
        const v = byTag(c, 'v')[0]?.textContent ?? '';
        let val = v;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = byTag(c, 't').map((x) => x.textContent).join('');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        cells[colIndex(c.getAttribute('r') || 'A')] = val;
      }
      const line = Array.from(cells, (x) => (x == null ? '' : String(x))).join(' | ').replace(/( \| )+$/, '');
      if (line.trim()) lines.push(line);
    }
    const block = lines.join('\n');
    parts.push(block);
    total += block.length;
    if (total > MAX_CHARS) break;
  }
  return parts.join('\n\n');
}

function pptxText(zip) {
  const slides = Object.keys(zip)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => parseInt(a.match(/\d+/g).pop(), 10) - parseInt(b.match(/\d+/g).pop(), 10));
  return slides
    .map((k, i) => {
      const paras = byTag(xml(zip[k]), 'a:p').map((p) => byTag(p, 'a:t').map((t) => t.textContent).join('')).filter(Boolean);
      return `## Slide ${i + 1}\n${paras.join('\n')}`;
    })
    .join('\n\n');
}

let pdfLoading = null;
function loadPdfLib() {
  if (globalThis.ZBPdf) return Promise.resolve(globalThis.ZBPdf);
  pdfLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'lib/pdf.js';
    s.onload = () => (globalThis.ZBPdf ? resolve(globalThis.ZBPdf) : reject(new Error('PDF reader failed to start')));
    s.onerror = () => {
      pdfLoading = null;
      reject(new Error('Couldn’t load the PDF reader'));
    };
    document.head.appendChild(s);
  });
  return pdfLoading;
}

async function pdfText(buf) {
  const pdfjs = await loadPdfLib();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const out = [];
  let total = 0;
  const pages = Math.min(doc.numPages, 300);
  for (let i = 1; i <= pages && total < MAX_CHARS; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    for (const it of tc.items) {
      line += it.str || '';
      if (it.hasEOL) line += '\n';
    }
    out.push(`--- page ${i} ---\n${line.trim()}`);
    total += line.length;
  }
  doc.destroy?.();
  return { text: out.join('\n\n'), pages: doc.numPages };
}

// Returns { kind, text, note } — text may be '' (images are read by Claude instead).
const OFFICE_PARTS = /^(word\/document\.xml|xl\/(sharedStrings|workbook)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/[^/]+\.xml|ppt\/slides\/slide\d+\.xml)$/;

// Plain text in any common encoding: UTF-8, or UTF-16 (Windows "Unicode" exports) by its byte-order mark.
function decodeText(u8) {
  let enc = 'utf-8';
  if (u8[0] === 0xff && u8[1] === 0xfe) enc = 'utf-16le';
  else if (u8[0] === 0xfe && u8[1] === 0xff) enc = 'utf-16be';
  else if (u8.length > 3 && u8[1] === 0 && u8[3] === 0 && u8[0] !== 0) enc = 'utf-16le';
  return new TextDecoder(enc).decode(u8).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export async function extractText(file) {
  const kind = kindOf(file);
  try {
    if (kind === 'text') return { kind, text: decodeText(new Uint8Array(await file.arrayBuffer())).slice(0, MAX_CHARS) };
    if (kind === 'pdf') {
      const { text, pages } = await pdfText(await file.arrayBuffer());
      const clean = text.replace(/--- page \d+ ---\s*/g, '').trim();
      return { kind, text: text.slice(0, MAX_CHARS), note: clean ? `${pages} page${pages === 1 ? '' : 's'}` : 'scanned PDF with no text layer' };
    }
    if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
      // inflate only the XML parts the readers use, and refuse archives that would blow up in memory
      let total = 0;
      const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (f) => {
          if (!OFFICE_PARTS.test(f.name) || f.originalSize > 20e6) return false;
          total += f.originalSize;
          return total <= 60e6;
        },
      });
      if (total > 60e6) return { kind, text: '', note: 'too large to read' };
      const text = kind === 'docx' ? docxText(zip) : kind === 'xlsx' ? xlsxText(zip) : pptxText(zip);
      return { kind, text: text.slice(0, MAX_CHARS) };
    }
  } catch (e) {
    return { kind, text: '', note: `couldn't read the contents (${e && e.message ? e.message : 'unknown error'})` };
  }
  return { kind, text: '' };
}

// Re-encode any image the browser can decode (including iPhone HEIC in Safari) as a JPEG.
export async function toJpeg(file, max = 2048) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('This browser can’t open that image type.'));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.86));
  } finally {
    URL.revokeObjectURL(url);
  }
}
