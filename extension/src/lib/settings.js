// Preferences that aren't secret: where the stripe sleeps, which model the
// agent uses, which connectors it may reach for. The API key is not here —
// that lives inside the encrypted vault.

const KEY = 'tucky.settings';

export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Best judgement — the default' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Faster, cheaper' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Quickest, for short asks' },
];

export const DEFAULTS = {
  model: 'claude-opus-5',
  effort: 'high',
  edgeSide: 'right',
  edgeOffset: 0.5,
  showEdge: true,
  fanCount: 7,
  peekOnHover: true,
  disabledHosts: [],
  connectors: { page: true, tabs: true, history: false, bookmarks: false },
  autoLockMinutes: 0,
  onboarded: false,
};

export async function getSettings() {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return {
    ...DEFAULTS,
    ...(stored || {}),
    connectors: { ...DEFAULTS.connectors, ...(stored?.connectors || {}) },
  };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  if (patch.connectors) {
    next.connectors = { ...DEFAULTS.connectors, ...patch.connectors };
  }
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isHostDisabled(settings, url) {
  const host = hostOf(url);
  return Boolean(host) && (settings.disabledHosts || []).includes(host);
}
