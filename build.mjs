// Builds two targets from src/:
//   dist/jarvis.html  - the claude.ai page (thinks with your Claude plan, syncs across devices)
//   docs/             - the installable web app for GitHub Pages (mic, ElevenLabs, API key)
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const css = fs.readFileSync('src/styles.css', 'utf8');
const body = fs.readFileSync('src/body.html', 'utf8');
const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&family=Chakra+Petch:wght@400;500;600&family=Michroma&display=swap">';
const DESCRIPTION = 'ZB: a holographic AI assistant with a living, voice-reactive orb, powered by Claude.';
const target = ['es2020', 'safari15', 'chrome100', 'firefox100'];
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

fs.mkdirSync('dist/lib', { recursive: true });
fs.mkdirSync('docs/icons', { recursive: true });
fs.mkdirSync('docs/lib', { recursive: true });

// pdf.js, loaded on demand when someone adds a PDF to the Vault
await esbuild.build({ entryPoints: ['src/pdf-entry.js'], bundle: true, format: 'iife', minify: true, outfile: 'dist/lib/pdf.js', target, logLevel: 'error' });
fs.copyFileSync('dist/lib/pdf.js', 'docs/lib/pdf.js');

const art = await esbuild.build({ entryPoints: ['src/entry-artifact.js'], bundle: true, format: 'iife', minify: true, write: false, target });
fs.writeFileSync(
  'dist/jarvis.html',
  `<title>ZB</title>
<meta name="claude:viewport-fit-sides" content="cover">
${FONTS}
<style>
${css}
</style>
${body.replace('data-mode="web"', 'data-mode="cloud"')}
<script>${safe(art.outputFiles[0].text)}</script>
`,
);

await esbuild.build({ entryPoints: ['src/entry-web.js'], bundle: true, format: 'iife', minify: true, outfile: 'docs/app.js', target });
fs.writeFileSync(
  'docs/index.html',
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ZB</title>
<meta name="description" content="${DESCRIPTION}">
<meta name="theme-color" content="#02060b">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="ZB">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
${FONTS}
<style>
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
${css}
</style>
</head>
<body>
${body}
<script src="app.js"></script>
</body>
</html>
`,
);
fs.writeFileSync(
  'docs/manifest.webmanifest',
  JSON.stringify(
    {
      name: 'ZB',
      short_name: 'ZB',
      description: DESCRIPTION,
      start_url: './',
      scope: './',
      display: 'standalone',
      orientation: 'any',
      background_color: '#02060b',
      theme_color: '#02060b',
      icons: [
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  ),
);
const version = Date.now().toString(36);
fs.writeFileSync(
  'docs/sw.js',
  `// Offline support: serve the app shell from cache when the network is unavailable.
const CACHE = 'zb-${version}';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
`,
);
fs.writeFileSync('docs/.nojekyll', '');
const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
console.log('dist/jarvis.html', kb('dist/jarvis.html'));
console.log('docs/app.js', kb('docs/app.js'));
