// Claude through the user's own API key (downloadable app only).
import Anthropic from '@anthropic-ai/sdk';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (smartest)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
];

// Older-style web search tool for models without the dynamic-filtering variant.
const SEARCH_TOOL = {
  'claude-haiku-5-5': 'web_search_20250305',
};

function toApiMessages(history, message, image) {
  const msgs = [];
  for (const t of history) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.content}`;
    else msgs.push({ role: t.role, content: t.content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }, { type: 'text', text: message }]
    : message;
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'user') {
    last.content = typeof content === 'string' ? `${last.content}\n\n${content}` : [{ type: 'text', text: last.content }, ...content];
  } else msgs.push({ role: 'user', content });
  return msgs;
}

export function createApiAsk() {
  let client = null;
  let clientKey = '';
  return async function ask({ apiKey, model, deep, webSearch, system, history, message, image, signal, onText }) {
    if (!client || clientKey !== apiKey) {
      client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      clientKey = apiKey;
    }
    const params = {
      model,
      max_tokens: 16000,
      system: [
        { type: 'text', text: system.stable, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: system.dynamic },
      ],
      messages: toApiMessages(history, message, image),
      output_config: { effort: deep ? 'high' : 'low' },
    };
    const betas = [];
    if (model !== 'claude-haiku-5-5') {
      // if a safety classifier declines, retry on Anthropic's recommended fallback model
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }
    if (webSearch) params.tools = [{ type: SEARCH_TOOL[model] || 'web_search_20260209', name: 'web_search', max_uses: 3 }];
    let text = '';
    try {
      const stream = client.beta.messages.stream({ ...params, betas }, { signal });
      stream.on('text', (delta) => {
        text += delta;
        onText({ text, delta });
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw { code: 'refused', text };
      return { text, truncated: msg.stop_reason === 'max_tokens' };
    } catch (e) {
      if (e && e.code) throw e;
      if (e instanceof Anthropic.APIUserAbortError || signal?.aborted) throw { code: 'cancelled', text };
      if (e instanceof Anthropic.AuthenticationError) throw { code: 'bad_key', text };
      if (e instanceof Anthropic.PermissionDeniedError) throw { code: 'bad_key', text };
      if (e instanceof Anthropic.RateLimitError) throw { code: 'rate_limited', text };
      if (e instanceof Anthropic.BadRequestError) throw { code: 'bad_request', text, message: e.message };
      if (e instanceof Anthropic.APIConnectionError) throw { code: 'offline', text };
      throw { code: 'upstream_error', text, message: String(e?.message || e) };
    }
  };
}

export function apiErrorText(e) {
  switch (e && e.code) {
    case 'bad_key':
      return 'That Claude API key didn’t work. Check it in Settings.';
    case 'rate_limited':
      return 'I’m being rate limited. Give it a minute.';
    case 'offline':
      return 'I can’t reach Claude. Check your internet connection.';
    case 'refused':
      return 'I can’t help with that one.';
    case 'bad_request':
      return `Claude rejected the request: ${e.message || 'bad request'}`;
    default:
      return 'Something went wrong reaching Claude. Try again.';
  }
}
