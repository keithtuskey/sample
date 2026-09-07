// The only privileged place in Tucky. Everything that touches the vault key,
// the API key or the network happens here; the UI surfaces ask by message and
// never see a secret they don't need.

import * as vault from '../lib/vault.js';
import { getSettings, isHostDisabled, saveSettings } from '../lib/settings.js';
import { ask, transform } from '../lib/agent.js';

const activeRuns = new Map(); // portName -> AbortController

chrome.runtime.onInstalled.addListener(async (details) => {
  await vault.initDevice();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tucky-capture',
      title: 'Tuck selection into Tucky',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'tucky-ask',
      title: 'Ask Tucky about this',
      contexts: ['selection', 'page'],
    });
  });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(() => { vault.initDevice(); });

// The toolbar button opens the popup; the side panel is opened deliberately.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});

// ------------------------------------------------------------- messaging

async function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id != null) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

async function notesChanged() {
  return broadcast({ type: 'tucky.notesChanged' });
}

const handlers = {
  'vault.state': () => vault.getState(),
  'vault.unlock': ({ passphrase }) => vault.unlock(passphrase),
  'vault.lock': () => vault.lock(),
  'vault.setPassphrase': ({ passphrase, current }) => vault.setPassphrase(passphrase, current),
  'vault.removePassphrase': ({ current }) => vault.removePassphrase(current),

  'notes.list': () => vault.listNotes(),
  'notes.get': ({ id }) => vault.getNote(id),
  'notes.search': ({ query, limit }) => vault.searchNotes(query, limit),
  'notes.create': async (msg) => {
    const note = await vault.createNote(msg.note || {});
    await notesChanged();
    return note;
  },
  'notes.update': async ({ id, patch }) => {
    const note = await vault.updateNote(id, patch || {});
    await notesChanged();
    return note;
  },
  'notes.delete': async ({ id }) => {
    const res = await vault.deleteNote(id);
    await notesChanged();
    return res;
  },
  'notes.export': () => vault.exportAll(),
  'notes.import': async ({ notes, replace }) => {
    const res = await vault.importNotes(notes, { replace });
    await notesChanged();
    return res;
  },

  'settings.get': () => getSettings(),
  'settings.save': async ({ patch }) => {
    const next = await saveSettings(patch);
    await broadcast({ type: 'tucky.settingsChanged', settings: next });
    return next;
  },

  'apiKey.status': async () => {
    const key = await vault.getApiKey();
    return { present: Boolean(key), hint: key ? `…${key.slice(-4)}` : '' };
  },
  'apiKey.set': async ({ apiKey }) => {
    await vault.setApiKey((apiKey || '').trim());
    return { ok: true };
  },

  'agent.transform': ({ instruction, text }) => transform({ instruction, text }),

  'ui.openPanel': async (msg, sender) => {
    const windowId = sender?.tab?.windowId ?? (await chrome.windows.getCurrent()).id;
    // The mic lives in the side panel: an extension page can hold microphone
    // permission of its own, where a content script would have to borrow the
    // page's.
    if (msg.voice) await chrome.storage.session.set({ 'tucky.voicePending': true });
    await chrome.sidePanel.open({ windowId });
    return { ok: true };
  },
  'ui.voicePending': async () => {
    const { 'tucky.voicePending': pending } = await chrome.storage.session.get('tucky.voicePending');
    if (pending) await chrome.storage.session.remove('tucky.voicePending');
    return { pending: Boolean(pending) };
  },
  'ui.openOptions': async () => {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
  'ui.disableHost': async ({ host, disabled }) => {
    const settings = await getSettings();
    const hosts = new Set(settings.disabledHosts || []);
    if (disabled) hosts.add(host); else hosts.delete(host);
    const next = await saveSettings({ disabledHosts: [...hosts] });
    await broadcast({ type: 'tucky.settingsChanged', settings: next });
    return next;
  },

  'page.context': async (_msg, sender) => {
    const settings = await getSettings();
    return { settings, url: sender?.tab?.url || '' };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler(message, sender))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({
      ok: false,
      error: String(err?.message || err),
      code: err?.code || null,
    }));
  return true; // keep the channel open for the async reply
});

// -------------------------------------------------------- agent streaming

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tucky-agent') return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'cancel') {
      activeRuns.get(port.name + msg.runId)?.abort();
      return;
    }
    if (msg.type !== 'ask') return;

    const runKey = port.name + msg.runId;
    const controller = new AbortController();
    activeRuns.set(runKey, controller);

    const send = (event) => {
      try {
        port.postMessage({ runId: msg.runId, ...event });
      } catch {
        controller.abort();
      }
    };

    try {
      let tabId = msg.tabId;
      if (tabId == null) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = tab?.id;
      }
      const result = await ask({
        messages: msg.messages,
        tabId,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'notes_changed') notesChanged();
          send(event);
        },
      });
      send({ type: 'complete', messages: result.messages, stopReason: result.stopReason });
    } catch (err) {
      send({
        type: 'error',
        error: controller.signal.aborted ? 'Stopped.' : String(err?.message || err),
        code: err?.code || null,
      });
    } finally {
      activeRuns.delete(runKey);
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [key, controller] of activeRuns) {
      if (key.startsWith(port.name)) controller.abort();
    }
  });
});

// -------------------------------------------------------------- shortcuts

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function toContentScript(payload, tab) {
  const target = tab || (await activeTab());
  if (!target?.id) return false;
  try {
    await chrome.tabs.sendMessage(target.id, payload);
    return true;
  } catch {
    return false;
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (command === 'open-panel') {
    const windowId = tab?.windowId ?? (await chrome.windows.getCurrent()).id;
    await chrome.sidePanel.open({ windowId });
    return;
  }
  const payload = {
    'toggle-fan': { type: 'tucky.toggleFan' },
    'ask-agent': { type: 'tucky.openAsk' },
    'quick-capture': { type: 'tucky.quickCapture' },
  }[command];
  if (!payload) return;

  const settings = await getSettings();
  const delivered = !isHostDisabled(settings, tab?.url || '')
    && await toContentScript(payload, tab);
  if (!delivered && tab?.windowId != null) {
    // Restricted page (chrome://, the Web Store, a PDF): the side panel is
    // the surface that always works.
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tucky-capture') {
    await vault.initDevice();
    try {
      await vault.createNote({
        body: info.selectionText || '',
        source: { url: info.pageUrl, title: tab?.title || '' },
      });
      await notesChanged();
      await toContentScript({ type: 'tucky.toast', text: 'Tucked away' }, tab);
    } catch (err) {
      await toContentScript({ type: 'tucky.toast', text: String(err.message) }, tab);
    }
  }
  if (info.menuItemId === 'tucky-ask') {
    const delivered = await toContentScript({
      type: 'tucky.openAsk',
      seed: info.selectionText || '',
    }, tab);
    if (!delivered && tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
