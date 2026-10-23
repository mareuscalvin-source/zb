// Downloadable build: installable web app with mic input, ElevenLabs voices and a Claude API key.
import { boot } from './app.js';
import { createApiAsk, apiErrorText, MODELS } from './api.js';

boot({ apiAsk: createApiAsk(), apiErrorText, models: MODELS });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
