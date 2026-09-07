// The vault: every note, and the API key, live inside one encrypted blob in
// chrome.storage.local. The key itself is either a device key (generated at
// install, kept on this machine) or derived from a passphrase you type, in
// which case it is never written to disk — only held in chrome.storage.session
// until you lock, or until the browser restarts.

import {
  decryptJSON, deriveKey, encryptJSON, exportRawKey, fromB64,
  generateKey, importRawKey, PBKDF2_ITERATIONS, randomBytes, toB64,
} from './crypto.js';

const META_KEY = 'tucky.vault.meta';
const DATA_KEY = 'tucky.vault.data';
const DEVICE_KEY = 'tucky.vault.deviceKey';
const SESSION_KEY = 'tucky.vault.sessionKey';

export class VaultLockedError extends Error {
  constructor() {
    super('Tucky is locked. Unlock it with your passphrase.');
    this.name = 'VaultLockedError';
    this.code = 'LOCKED';
  }
}

const EMPTY_VAULT = { version: 1, notes: [], secrets: {}, chats: [] };

function uid() {
  return 'n_' + toB64(randomBytes(9)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

export async function getMeta() {
  const { [META_KEY]: meta } = await localGet(META_KEY);
  return meta || null;
}

/** Creates the vault on first run. Device mode needs no passphrase. */
export async function initDevice() {
  const existing = await getMeta();
  if (existing) return existing;
  const key = await generateKey();
  const meta = { version: 1, mode: 'device', createdAt: Date.now() };
  await chrome.storage.local.set({
    [META_KEY]: meta,
    [DEVICE_KEY]: toB64(await exportRawKey(key)),
    [DATA_KEY]: await encryptJSON(key, EMPTY_VAULT),
  });
  return meta;
}

async function loadKey() {
  const meta = await getMeta();
  if (!meta) return null;
  if (meta.mode === 'device') {
    const { [DEVICE_KEY]: raw } = await localGet(DEVICE_KEY);
    return raw ? importRawKey(fromB64(raw)) : null;
  }
  const { [SESSION_KEY]: raw } = await chrome.storage.session.get(SESSION_KEY);
  return raw ? importRawKey(fromB64(raw)) : null;
}

export async function getState() {
  const meta = await getMeta();
  if (!meta) return { initialized: false, mode: null, locked: false };
  const key = await loadKey();
  return { initialized: true, mode: meta.mode, locked: !key };
}

export async function isUnlocked() {
  return Boolean(await loadKey());
}

/** Reads and decrypts the whole vault. Throws when locked. */
export async function read() {
  const key = await loadKey();
  if (!key) throw new VaultLockedError();
  const { [DATA_KEY]: blob } = await localGet(DATA_KEY);
  if (!blob) return { ...EMPTY_VAULT };
  return { ...EMPTY_VAULT, ...(await decryptJSON(key, blob)) };
}

/** Applies `mutate` to the decrypted vault and writes it back encrypted. */
export async function write(mutate) {
  const key = await loadKey();
  if (!key) throw new VaultLockedError();
  const vault = await read();
  const result = await mutate(vault);
  await chrome.storage.local.set({ [DATA_KEY]: await encryptJSON(key, vault) });
  return result;
}

export async function lock() {
  const meta = await getMeta();
  if (meta?.mode !== 'passphrase') return { locked: false, reason: 'device-mode' };
  await chrome.storage.session.remove(SESSION_KEY);
  return { locked: true };
}

export async function unlock(passphrase) {
  const meta = await getMeta();
  if (!meta) throw new Error('No vault yet.');
  if (meta.mode !== 'passphrase') return { ok: true, mode: 'device' };
  const key = await deriveKey(passphrase, fromB64(meta.salt), meta.iterations);
  const { [DATA_KEY]: blob } = await localGet(DATA_KEY);
  try {
    if (blob) await decryptJSON(key, blob);
  } catch {
    return { ok: false, error: 'Wrong passphrase.' };
  }
  await chrome.storage.session.set({ [SESSION_KEY]: toB64(await exportRawKey(key)) });
  return { ok: true, mode: 'passphrase' };
}

/**
 * Switches the vault to passphrase mode, re-encrypting the existing notes
 * under the derived key and dropping the on-disk device key.
 */
export async function setPassphrase(passphrase, currentPassphrase) {
  if (!passphrase || passphrase.length < 8) {
    return { ok: false, error: 'Use at least 8 characters.' };
  }
  const meta = await getMeta();
  if (!meta) await initDevice();
  const current = await getMeta();
  if (current.mode === 'passphrase') {
    const check = await unlock(currentPassphrase || '');
    if (!check.ok) return { ok: false, error: 'Current passphrase is wrong.' };
  }
  const data = await read(); // needs the old key, so do this before swapping
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  await chrome.storage.local.set({
    [META_KEY]: {
      version: 1, mode: 'passphrase', salt: toB64(salt),
      iterations: PBKDF2_ITERATIONS, createdAt: current.createdAt || Date.now(),
    },
    [DATA_KEY]: await encryptJSON(key, data),
  });
  await chrome.storage.local.remove(DEVICE_KEY);
  await chrome.storage.session.set({ [SESSION_KEY]: toB64(await exportRawKey(key)) });
  return { ok: true };
}

/** Drops back to a device key, so the vault opens without typing anything. */
export async function removePassphrase(currentPassphrase) {
  const meta = await getMeta();
  if (!meta || meta.mode !== 'passphrase') return { ok: true };
  const check = await unlock(currentPassphrase || '');
  if (!check.ok) return { ok: false, error: 'Current passphrase is wrong.' };
  const data = await read();
  const key = await generateKey();
  await chrome.storage.local.set({
    [META_KEY]: { version: 1, mode: 'device', createdAt: meta.createdAt },
    [DEVICE_KEY]: toB64(await exportRawKey(key)),
    [DATA_KEY]: await encryptJSON(key, data),
  });
  await chrome.storage.session.remove(SESSION_KEY);
  return { ok: true };
}

// ---------------------------------------------------------------- notes

export const NOTE_COLORS = ['amber', 'rose', 'sky', 'mint', 'violet', 'stone'];

function normalize(note) {
  return {
    id: note.id,
    title: note.title || '',
    body: note.body || '',
    color: NOTE_COLORS.includes(note.color) ? note.color : 'amber',
    pinned: Boolean(note.pinned),
    source: note.source || null,
    createdAt: note.createdAt || Date.now(),
    updatedAt: note.updatedAt || Date.now(),
  };
}

/** Pinned first, then most recently touched — the order they fan out in. */
export function sortNotes(notes) {
  return [...notes].sort((a, b) => (
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt
  ));
}

export async function listNotes() {
  const vault = await read();
  return sortNotes(vault.notes.map(normalize));
}

export async function getNote(id) {
  const vault = await read();
  const note = vault.notes.find((n) => n.id === id);
  return note ? normalize(note) : null;
}

export async function createNote(patch = {}) {
  return write(async (vault) => {
    const note = normalize({
      ...patch,
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!note.title && note.body) note.title = deriveTitle(note.body);
    vault.notes.unshift(note);
    return note;
  });
}

export async function updateNote(id, patch = {}) {
  return write(async (vault) => {
    const i = vault.notes.findIndex((n) => n.id === id);
    if (i === -1) return null;
    const merged = normalize({ ...vault.notes[i], ...patch, id });
    if (patch.append) {
      merged.body = `${vault.notes[i].body || ''}${vault.notes[i].body ? '\n\n' : ''}${patch.append}`;
    }
    merged.updatedAt = Date.now();
    if (!merged.title && merged.body) merged.title = deriveTitle(merged.body);
    vault.notes[i] = merged;
    return merged;
  });
}

export async function deleteNote(id) {
  return write(async (vault) => {
    const before = vault.notes.length;
    vault.notes = vault.notes.filter((n) => n.id !== id);
    return { deleted: before !== vault.notes.length };
  });
}

export function deriveTitle(body) {
  const line = (body || '').split('\n').find((l) => l.trim()) || 'Untitled';
  return line.replace(/^#+\s*/, '').trim().slice(0, 80);
}

/** Plain substring scoring — every note is already in memory once decrypted. */
export async function searchNotes(query, limit = 20) {
  const notes = await listNotes();
  const q = (query || '').trim().toLowerCase();
  if (!q) return notes.slice(0, limit);
  const terms = q.split(/\s+/);
  return notes
    .map((note) => {
      const title = note.title.toLowerCase();
      const body = note.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 3;
        if (body.includes(term)) score += 1;
      }
      return { note, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
    .slice(0, limit)
    .map((r) => r.note);
}

// -------------------------------------------------------------- secrets

export async function getApiKey() {
  const vault = await read();
  return vault.secrets?.apiKey || '';
}

export async function setApiKey(apiKey) {
  return write(async (vault) => {
    vault.secrets = { ...(vault.secrets || {}), apiKey: apiKey || '' };
    return true;
  });
}

// ------------------------------------------------------ export / import

export async function exportAll() {
  const vault = await read();
  return { exportedAt: new Date().toISOString(), version: 1, notes: vault.notes };
}

export async function importNotes(notes, { replace = false } = {}) {
  if (!Array.isArray(notes)) return { imported: 0 };
  return write(async (vault) => {
    const incoming = notes.map((n) => normalize({ ...n, id: n.id || uid() }));
    if (replace) {
      vault.notes = incoming;
      return { imported: incoming.length };
    }
    const known = new Set(vault.notes.map((n) => n.id));
    const fresh = incoming.filter((n) => !known.has(n.id));
    vault.notes = [...fresh, ...vault.notes];
    return { imported: fresh.length };
  });
}
