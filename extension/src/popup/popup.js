// The toolbar popup: somewhere to drop a thought from any page, including the
// ones Chrome won't let the edge stripe reach.

import { relativeTime, send } from '../ui/rpc.js';

const $ = (id) => document.getElementById(id);
let currentTab = null;
let settings = null;

async function refreshRecent() {
  const notes = await send({ type: 'notes.list' });
  const list = $('recent');
  list.textContent = '';
  for (const note of notes.slice(0, 3)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.innerHTML = '<span class="t"></span><span class="m"></span>';
    btn.querySelector('.t').textContent = note.title || 'Untitled';
    btn.querySelector('.m').textContent = relativeTime(note.updatedAt);
    btn.addEventListener('click', async () => {
      await send({ type: 'ui.openPanel' });
      window.close();
    });
    li.append(btn);
    list.append(li);
  }
}

async function tuck(body, source) {
  if (!body.trim()) return;
  await send({ type: 'notes.create', note: { body, source } });
  $('quick').value = '';
  $('status').textContent = 'Tucked away';
  await refreshRecent();
  setTimeout(() => { $('status').textContent = ''; }, 1600);
}

function renderSiteButton() {
  let host = '';
  try { host = new URL(currentTab?.url || '').hostname; } catch { host = ''; }
  if (!host) return $('site').classList.add('hidden');
  const off = (settings.disabledHosts || []).includes(host);
  $('site').textContent = off ? `Show on ${host}` : `Hide on ${host}`;
  $('site').onclick = async () => {
    settings = await send({ type: 'ui.disableHost', host, disabled: !off });
    renderSiteButton();
  };
}

async function boot() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await send({ type: 'settings.get' });

  const vault = await send({ type: 'vault.state' });
  $('mode').textContent = vault.mode === 'passphrase' ? 'Passphrase' : 'Encrypted';
  $('locked').classList.toggle('hidden', !vault.locked);
  $('capture').classList.toggle('hidden', vault.locked);

  $('unlock').addEventListener('click', async () => {
    const res = await send({ type: 'vault.unlock', passphrase: $('passphrase').value });
    if (!res.ok) { $('unlock-error').textContent = res.error; return; }
    $('locked').classList.add('hidden');
    $('capture').classList.remove('hidden');
    await refreshRecent();
  });
  $('passphrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock').click(); });

  $('tuck').addEventListener('click', () => tuck($('quick').value, {
    url: currentTab?.url, title: currentTab?.title,
  }));
  $('quick').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('tuck').click();
  });
  $('grab').addEventListener('click', async () => {
    await tuck(`${currentTab?.title || 'This page'}\n${currentTab?.url || ''}`, {
      url: currentTab?.url, title: currentTab?.title,
    });
  });
  $('panel').addEventListener('click', async () => {
    await send({ type: 'ui.openPanel' });
    window.close();
  });
  $('ask').addEventListener('click', async () => {
    const delivered = currentTab?.id != null
      && await chrome.tabs.sendMessage(currentTab.id, { type: 'tucky.openAsk' }).then(() => true, () => false);
    if (!delivered) await send({ type: 'ui.openPanel' });
    window.close();
  });
  $('settings').addEventListener('click', () => send({ type: 'ui.openOptions' }).then(() => window.close()));

  renderSiteButton();
  if (!vault.locked) await refreshRecent();
  $('quick').focus();
}

boot();
