import { esc } from '../lib/util.js';

export function toast(message, type = 'info', ms = 3600) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<span>${esc(message)}</span>`;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  window.setTimeout(() => {
    node.classList.remove('in');
    window.setTimeout(() => node.remove(), 240);
  }, ms);
}

export function confirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal confirm-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        <p>${esc(body)}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-act="cancel">${esc(cancelLabel)}</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter' && event.target === overlay.querySelector('[data-act="ok"]')) close(true);
    };
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) return close(false);
      const action = event.target.closest('[data-act]')?.dataset.act;
      if (action === 'ok') close(true);
      if (action === 'cancel') close(false);
    });
    overlay.querySelector('[data-act="ok"]')?.focus();
  });
}
