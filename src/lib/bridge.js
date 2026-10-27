// The only place that knows whether we are inside Tauri or a plain browser.
// In the browser the same OpenRouter API is called directly over CORS.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const STORE_FILE = 'quizforge.json';
const LS_KEY = 'quizforge.state.v1';

let storePromise = null;

async function tauriStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const { load } = await import('@tauri-apps/plugin-store');
      return load(STORE_FILE, { autoSave: 250, defaults: {} });
    })();
  }
  return storePromise;
}

export async function loadState() {
  if (!isTauri) {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    } catch {
      return null;
    }
  }
  const store = await tauriStore();
  return (await store.get('state')) ?? null;
}

export async function saveState(state) {
  if (!isTauri) {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    return;
  }
  const store = await tauriStore();
  await store.set('state', state);
  await store.save();
}

const FILTERS = [
  {
    name: 'Attachments',
    extensions: [
      'pdf', 'docx', 'pptx', 'txt', 'md', 'markdown', 'tex', 'csv', 'json',
      'ipynb', 'html', 'htm', 'rtf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
    ],
  },
  { name: 'Documents', extensions: ['pdf', 'docx', 'pptx'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
  { name: 'Text', extensions: ['txt', 'md', 'markdown', 'tex', 'csv', 'json', 'ipynb', 'html', 'htm'] },
];

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function pickAttachment() {
  if (!isTauri) return pickInBrowser();
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({
    multiple: false,
    directory: false,
    title: 'Upload an attachment',
    filters: FILTERS,
  });
  if (!path) return null;
  const file = await tauriInvoke('read_file_bytes', { path });
  return {
    name: file.name,
    size: file.size,
    bytes: base64ToBytes(file.data),
  };
}

function pickInBrowser() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept =
      '.pdf,.docx,.pptx,.txt,.md,.markdown,.tex,.csv,.json,.ipynb,.html,.htm,.rtf,.png,.jpg,.jpeg,.webp,.gif,.bmp';
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      finish({ name: file.name, size: file.size, bytes });
    });
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}

export async function openExternal(url) {
  if (!isTauri) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

export async function invoke(cmd, args) {
  if (isTauri) return tauriInvoke(cmd, args);
  return browserInvoke(cmd, args);
}

// ---------------------------------------------------------------------------
// Browser transport. The web build talks to OpenRouter directly (its API sends
// permissive CORS headers), so `npm run dev` is a real client, not a demo.
// The desktop build uses the Rust commands above instead, keeping the key out
// of the webview's network stack.
// ---------------------------------------------------------------------------

const FALLBACK_BASE = 'https://openrouter.ai/api/v1';

function providerBase(provider) {
  const base = String(provider?.baseUrl || FALLBACK_BASE).trim().replace(/\/+$/, '');
  return base || FALLBACK_BASE;
}

function tidy(body) {
  const text = String(body || '').trim();
  if (!text) return 'the server sent an empty response';
  try {
    const parsed = JSON.parse(text);
    const message =
      parsed?.error?.message || parsed?.error || parsed?.message || parsed?.detail;
    if (typeof message === 'string' && message) return message.slice(0, 500);
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, ' ').slice(0, 500);
}

function failure(status, body) {
  const hint =
    status === 401
      ? ' Check the key in Settings.'
      : status === 402
        ? ' Your OpenRouter account may be out of credits.'
        : status === 429
          ? ' Too many requests — wait a moment and try again.'
          : '';
  return new Error(`OpenRouter returned HTTP ${status}. ${tidy(body)}${hint}`);
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

async function openrouterChat(request) {
  const provider = request.provider || {};
  const key = String(provider.apiKey || '').trim();
  if (!key) throw new Error('Add your OpenRouter API key in Settings first.');
  if (!String(provider.model || '').trim()) {
    throw new Error('No model is selected. Open Settings and choose a model.');
  }

  const images = Array.isArray(request.images) ? request.images : [];
  const content = images.length
    ? [
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.data}` },
        })),
        { type: 'text', text: request.user },
      ]
    : request.user;

  let maxTokens = Math.min(32000, Math.max(256, Number(provider.maxTokens) || 8000));
  const temperature = Math.min(1.5, Math.max(0, Number(provider.temperature ?? 0.7)));
  const modelName = String(provider.model).split('/').pop() || '';
  const reasoning = /^(o1|o3|o4|gpt-5|gpt-6)/i.test(modelName);

  const buildPayload = (limit) => {
    const payload = {
      model: provider.model,
      stream: false,
      max_tokens: limit,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content },
      ],
    };
    if (!reasoning) payload.temperature = temperature;
    return payload;
  };

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(`${providerBase(provider)}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://quizforge.app',
          'X-Title': 'QuizForge',
        },
        body: JSON.stringify(buildPayload(maxTokens)),
        signal: AbortSignal.timeout(600_000),
      });
    } catch (error) {
      throw new Error(`Could not reach OpenRouter: ${error.message}`);
    }

    const body = await response.text();

    if (!response.ok) {
      lastError = failure(response.status, body);
      if (response.status === 402 && attempt === 0) {
        const affordable = /can only afford (\d+) tokens/i.exec(body);
        if (affordable) {
          const next = Math.max(512, Math.min(maxTokens, Number(affordable[1]) - 64));
          if (next < maxTokens) {
            maxTokens = next;
            continue;
          }
        }
      }
      throw lastError;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`OpenRouter sent something that was not JSON: ${tidy(body)}`);
    }

    const text = textFromContent(data?.choices?.[0]?.message?.content);
    if (!text.trim()) throw new Error('OpenRouter returned an empty response.');
    return { text };
  }

  throw lastError || new Error('OpenRouter could not complete the request.');
}

async function openrouterModels() {
  let response;
  try {
    response = await fetch(`${FALLBACK_BASE}/models`, {
      headers: { 'X-Title': 'QuizForge' },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Could not load the OpenRouter catalogue: ${error.message}`);
  }
  const body = await response.text();
  if (!response.ok) throw failure(response.status, body);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Unexpected model list: ${tidy(body)}`);
  }
  return (Array.isArray(data?.data) ? data.data : [])
    .map((model) => ({
      id: String(model.id || ''),
      name: String(model.name || model.id || ''),
      context: Number(model.context_length) || 0,
      promptPrice: String(model?.pricing?.prompt ?? ''),
    }))
    .filter((model) => model.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function openrouterVerify(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, label: '', usage: 0, limit: null, detail: 'Enter an OpenRouter API key.' };
  }
  let response;
  try {
    response = await fetch(`${FALLBACK_BASE}/key`, {
      headers: { Authorization: `Bearer ${key}`, 'X-Title': 'QuizForge' },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Could not reach OpenRouter: ${error.message}`);
  }
  const body = await response.text();
  if (response.status === 401 || response.status === 403) {
    return { ok: false, label: '', usage: 0, limit: null, detail: 'OpenRouter rejected that key.' };
  }
  if (!response.ok) {
    return {
      ok: false,
      label: '',
      usage: 0,
      limit: null,
      detail: `OpenRouter returned HTTP ${response.status}: ${tidy(body)}`,
    };
  }
  let payload = {};
  try {
    payload = JSON.parse(body);
  } catch {
    payload = {};
  }
  const data = payload.data || payload;
  return {
    ok: true,
    label: String(data.label || 'OpenRouter key'),
    usage: Number(data.usage) || 0,
    limit: Number.isFinite(Number(data.limit)) ? Number(data.limit) : null,
    detail: 'Connected to OpenRouter.',
  };
}

async function browserInvoke(cmd, args) {
  if (cmd === 'list_models') return openrouterModels();
  if (cmd === 'verify_openrouter') return openrouterVerify(args?.apiKey);
  if (cmd === 'chat_completion') return openrouterChat(args?.request || {});
  if (cmd === 'read_file_bytes') {
    throw new Error('The browser build reads files through the file picker; use the desktop app for path access.');
  }
  throw new Error(`Unknown command: ${cmd}`);
}
