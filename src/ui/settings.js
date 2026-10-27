import { listModels, verifyKey } from '../lib/llm.js';
import { openExternal } from '../lib/bridge.js';
import { esc } from '../lib/util.js';
import { icon } from './icons.js';

const DEFAULT_MODEL = 'openai/gpt-5.4-mini';

export function openSettings({ settings, required = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="OpenRouter settings">
        <div class="settings-head">
          <span class="provider-badge">${icon('key', 15)} OpenRouter</span>
          <h2>${required ? 'Connect OpenRouter' : 'Settings'}</h2>
          <p>QuizForge uses your own OpenRouter key. The key stays on this device and is only sent to OpenRouter.</p>
        </div>

        <label class="field">
          <span class="field-label">API key</span>
          <span class="input-wrap">
            <input id="sf-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-or-v1-…" value="${esc(settings?.apiKey || '')}" />
            <button class="icon-btn" id="sf-eye" type="button" aria-label="Show key" title="Show key">${icon('eye', 17)}</button>
          </span>
          <span class="field-hint">
            <button class="link" id="sf-get" type="button">Get a key at openrouter.ai ${icon('external', 13)}</button>
          </span>
        </label>

        <label class="field">
          <span class="field-label">Model</span>
          <span class="input-wrap">
            <input id="sf-model" list="sf-models" spellcheck="false" autocomplete="off" placeholder="${DEFAULT_MODEL}" value="${esc(settings?.model || DEFAULT_MODEL)}" />
            <button class="icon-btn" id="sf-refresh" type="button" aria-label="Refresh models" title="Refresh models">${icon('refresh', 17)}</button>
          </span>
          <datalist id="sf-models"></datalist>
          <span class="field-hint" id="sf-model-hint">Loading the OpenRouter catalogue…</span>
          <span class="field-hint">For math-heavy material, <code>openai/gpt-5.4-mini</code> or stronger gives more reliable answers.</span>
          <span class="field-hint">Models ending in <code>:free</code> cost nothing, with rate limits.</span>
        </label>

        <div class="status-line" id="sf-status" role="status"></div>

        <div class="modal-actions">
          <button class="btn ghost" id="sf-cancel" type="button">${required ? 'Not now' : 'Cancel'}</button>
          <button class="btn primary" id="sf-save" type="button">Save key</button>
        </div>
        <p class="fineprint">OpenRouter is the only supported provider. Vision models can read image attachments.</p>
      </div>`;
    document.body.appendChild(overlay);

    const keyEl = overlay.querySelector('#sf-key');
    const modelEl = overlay.querySelector('#sf-model');
    const datalist = overlay.querySelector('#sf-models');
    const statusEl = overlay.querySelector('#sf-status');
    const saveBtn = overlay.querySelector('#sf-save');
    const modelHint = overlay.querySelector('#sf-model-hint');
    const refreshBtn = overlay.querySelector('#sf-refresh');
    const eyeBtn = overlay.querySelector('#sf-eye');

    let finished = false;

    const close = (result) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };

    const finish = (nextSettings) => {
      close({ saved: true, settings: nextSettings });
    };

    const setStatus = (message, tone = '') => {
      statusEl.className = `status-line ${tone}`;
      statusEl.textContent = message;
    };

    const offerSaveAnyway = (message) => {
      setStatus(typeof message === 'string' ? message : message.message, 'error');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link inline';
      button.textContent = 'Save anyway';
      button.addEventListener('click', () => {
        const apiKey = keyEl.value.trim();
        const model = modelEl.value.trim();
        if (!apiKey || !model) return;
        finish({ apiKey, model, temperature: 0.7 });
      });
      statusEl.appendChild(document.createTextNode(' '));
      statusEl.appendChild(button);
    };

    const onKey = (event) => {
      if (event.key === 'Escape' && !finished) close({ saved: false });
    };

    async function refreshModels() {
      refreshBtn.classList.add('spinning');
      modelHint.textContent = 'Loading the OpenRouter catalogue…';
      try {
        const models = await listModels();
        datalist.replaceChildren();
        for (const model of models) {
          const option = document.createElement('option');
          option.value = model.id;
          option.label = model.name || model.id;
          datalist.appendChild(option);
        }
        modelHint.textContent = `${models.length} models available — type to filter`;
      } catch (error) {
        modelHint.textContent = 'Could not load the catalogue. You can still type a model ID.';
      } finally {
        refreshBtn.classList.remove('spinning');
      }
    }

    async function save() {
      const apiKey = keyEl.value.trim();
      const model = modelEl.value.trim() || DEFAULT_MODEL;
      if (!apiKey) {
        setStatus('Add your OpenRouter API key first.', 'error');
        keyEl.focus();
        return;
      }
      saveBtn.disabled = true;
      const original = saveBtn.textContent;
      saveBtn.textContent = 'Checking…';
      setStatus('Checking the key with OpenRouter…', 'busy');
      try {
        const info = await verifyKey(apiKey);
        if (!info.ok) {
          offerSaveAnyway(info.detail || 'OpenRouter rejected that key.');
          return;
        }
        const usage = Number(info.usage) > 0 ? ` · $${Number(info.usage).toFixed(2)} used` : '';
        setStatus(`${info.detail || 'Connected.'}${usage}`, 'ok');
        finish({ apiKey, model, temperature: 0.7 });
      } catch (error) {
        offerSaveAnyway(error?.message || 'Could not reach OpenRouter.');
      } finally {
        if (!finished) {
          saveBtn.disabled = false;
          saveBtn.textContent = original;
        }
      }
    }

    eyeBtn.addEventListener('click', () => {
      const showing = keyEl.type === 'text';
      keyEl.type = showing ? 'password' : 'text';
      eyeBtn.innerHTML = icon(showing ? 'eye' : 'eyeOff', 17);
      eyeBtn.title = showing ? 'Show key' : 'Hide key';
    });

    overlay.querySelector('#sf-get').addEventListener('click', () => {
      openExternal('https://openrouter.ai/keys').catch(() => {});
    });
    refreshBtn.addEventListener('click', refreshModels);
    saveBtn.addEventListener('click', save);
    overlay.querySelector('#sf-cancel').addEventListener('click', () => close({ saved: false }));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close({ saved: false });
    });
    document.addEventListener('keydown', onKey);

    refreshModels();
    if (!settings?.apiKey) keyEl.focus();
    else modelEl.focus();
  });
}
