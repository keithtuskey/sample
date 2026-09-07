// Settings. The API key round-trips through the vault, so it is encrypted the
// same way the notes are and is never written to plain storage.

import { send } from '../ui/rpc.js';
import { MODELS } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
let settings = null;

function fillModels(selected) {
  $('model').textContent = '';
  for (const model of MODELS) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.label} — ${model.note}`;
    $('model').append(option);
  }
  $('model').value = selected;
}

function renderHosts() {
  const list = $('hosts');
  list.textContent = '';
  const hosts = settings.disabledHosts || [];
  if (!hosts.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.style.fontSize = '12px';
    li.textContent = 'None — the stripe shows everywhere.';
    list.append(li);
    return;
  }
  for (const host of hosts) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = `${host}  ✕`;
    btn.title = `Show Tucky on ${host} again`;
    btn.addEventListener('click', async () => {
      settings = await send({ type: 'ui.disableHost', host, disabled: false });
      renderHosts();
    });
    li.append(btn);
    list.append(li);
  }
}

async function patch(update) {
  settings = await send({ type: 'settings.save', patch: update });
}

async function renderVault() {
  const state = await send({ type: 'vault.state' });
  $('vault-lead').textContent = state.mode === 'passphrase'
    ? 'Your notes are encrypted with a key derived from your passphrase. The key is never written to disk — it lives in memory until you lock Tucky or restart Chrome.'
    : 'Your notes are encrypted with a device key kept on this machine, so they open without typing anything. Set a passphrase if you want the key off disk entirely.';
  $('remove-pass').classList.toggle('hidden', state.mode !== 'passphrase');
  $('lock-now').classList.toggle('hidden', state.mode !== 'passphrase');
}

async function connectorToggle(id, name, permission) {
  const box = $(id);
  box.addEventListener('change', async () => {
    if (permission && box.checked) {
      const granted = await chrome.permissions.request({ permissions: [permission] });
      if (!granted) { box.checked = false; return; }
    }
    if (permission && !box.checked) {
      await chrome.permissions.remove({ permissions: [permission] }).catch(() => {});
    }
    await patch({ connectors: { ...settings.connectors, [name]: box.checked } });
  });
}

async function boot() {
  settings = await send({ type: 'settings.get' });

  if (location.hash === '#welcome') $('welcome').classList.remove('hidden');

  const key = await send({ type: 'apiKey.status' });
  $('key-status').textContent = key.present
    ? `A key ending ${key.hint} is stored in the vault.`
    : 'No key yet — the agent stays asleep until you add one.';

  fillModels(settings.model);
  $('effort').value = settings.effort;
  $('c-page').checked = settings.connectors.page;
  $('c-tabs').checked = settings.connectors.tabs;
  $('c-history').checked = settings.connectors.history
    && await chrome.permissions.contains({ permissions: ['history'] });
  $('c-bookmarks').checked = settings.connectors.bookmarks
    && await chrome.permissions.contains({ permissions: ['bookmarks'] });
  $('show-edge').checked = settings.showEdge;
  $('peek').checked = settings.peekOnHover;
  $('side').value = settings.edgeSide;
  $('fan').value = settings.fanCount;
  $('fan-value').textContent = settings.fanCount;
  renderHosts();
  await renderVault();

  $('save-key').addEventListener('click', async () => {
    try {
      await send({ type: 'apiKey.set', apiKey: $('api-key').value });
      $('api-key').value = '';
      const status = await send({ type: 'apiKey.status' });
      $('key-status').textContent = status.present
        ? `Saved. Key ending ${status.hint} is in the vault.`
        : 'Key cleared.';
    } catch (err) {
      $('key-status').textContent = err.code === 'LOCKED'
        ? 'Unlock Tucky first — the key lives inside the encrypted vault.'
        : err.message;
    }
  });

  $('model').addEventListener('change', (e) => patch({ model: e.target.value }));
  $('effort').addEventListener('change', (e) => patch({ effort: e.target.value }));
  $('side').addEventListener('change', (e) => patch({ edgeSide: e.target.value }));
  $('show-edge').addEventListener('change', (e) => patch({ showEdge: e.target.checked }));
  $('peek').addEventListener('change', (e) => patch({ peekOnHover: e.target.checked }));
  $('fan').addEventListener('input', (e) => {
    $('fan-value').textContent = e.target.value;
    patch({ fanCount: Number(e.target.value) });
  });

  connectorToggle('c-page', 'page');
  connectorToggle('c-tabs', 'tabs');
  connectorToggle('c-history', 'history', 'history');
  connectorToggle('c-bookmarks', 'bookmarks', 'bookmarks');

  $('set-pass').addEventListener('click', async () => {
    const res = await send({
      type: 'vault.setPassphrase',
      passphrase: $('pass-new').value,
      current: $('pass-current').value,
    });
    $('vault-status').textContent = res.ok
      ? 'Passphrase set. Your notes were re-encrypted under the new key.'
      : res.error;
    if (res.ok) { $('pass-new').value = ''; $('pass-current').value = ''; }
    await renderVault();
  });

  $('remove-pass').addEventListener('click', async () => {
    const res = await send({ type: 'vault.removePassphrase', current: $('pass-current').value });
    $('vault-status').textContent = res.ok
      ? 'Back to a device key — Tucky opens without typing anything.'
      : res.error;
    await renderVault();
  });

  $('lock-now').addEventListener('click', async () => {
    await send({ type: 'vault.lock' });
    $('vault-status').textContent = 'Locked. Unlock from the popup or the side panel.';
  });

  $('export').addEventListener('click', async () => {
    try {
      const data = await send({ type: 'notes.export' });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `tucky-notes-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      $('data-status').textContent = `Exported ${data.notes.length} note${data.notes.length === 1 ? '' : 's'}.`;
    } catch (err) {
      $('data-status').textContent = err.message;
    }
  });

  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const notes = Array.isArray(parsed) ? parsed : parsed.notes;
      const res = await send({ type: 'notes.import', notes });
      $('data-status').textContent = `Imported ${res.imported} note${res.imported === 1 ? '' : 's'}.`;
    } catch (err) {
      $('data-status').textContent = `Could not read that file: ${err.message}`;
    }
    e.target.value = '';
  });

  $('erase').addEventListener('click', async () => {
    if (!confirm('Erase every note, the API key and the encryption key on this machine? This cannot be undone.')) return;
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    $('data-status').textContent = 'Erased. Reload this page to start fresh.';
  });

  $('edit-shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

boot();
