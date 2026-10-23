// Bundled to lib/pdf.js and loaded only when someone adds a PDF. Running the pdf.js worker
// on the main thread keeps it working inside sandboxed pages that can't start workers.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as worker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

globalThis.pdfjsWorker = worker;
globalThis.ZBPdf = pdfjs;
