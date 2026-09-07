import test from 'node:test';
import assert from 'node:assert/strict';
import { resetStorage, storage } from './chrome-shim.mjs';

const vault = await import('../extension/src/lib/vault.js');

test.beforeEach(() => resetStorage());

test('a fresh vault starts in device mode and opens unlocked', async () => {
  await vault.initDevice();
  const state = await vault.getState();
  assert.deepEqual(state, { initialized: true, mode: 'device', locked: false });
});

test('notes round-trip through encryption and never sit in plaintext', async () => {
  await vault.initDevice();
  const note = await vault.createNote({ body: 'buy oat milk on the way home' });
  assert.equal(note.title, 'buy oat milk on the way home');

  const listed = await vault.listNotes();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].body, 'buy oat milk on the way home');

  const onDisk = JSON.stringify([...storage.local.entries()]);
  assert.ok(!onDisk.includes('oat milk'), 'note text must not be readable on disk');
});

test('updates, appends, pins and deletes', async () => {
  await vault.initDevice();
  const note = await vault.createNote({ title: 'Standup', body: 'shipped the fan-out' });
  await vault.updateNote(note.id, { append: 'next: the ask bar' });
  const updated = await vault.getNote(note.id);
  assert.match(updated.body, /shipped the fan-out\n\nnext: the ask bar/);

  await vault.updateNote(note.id, { pinned: true });
  const second = await vault.createNote({ body: 'later note' });
  const order = await vault.listNotes();
  assert.equal(order[0].id, note.id, 'pinned notes fan out first');

  await vault.deleteNote(second.id);
  assert.equal((await vault.listNotes()).length, 1);
});

test('search scores titles above bodies', async () => {
  await vault.initDevice();
  await vault.createNote({ title: 'Roadmap', body: 'nothing about launch' });
  await vault.createNote({ title: 'Random', body: 'roadmap appears in the body' });
  const hits = await vault.searchNotes('roadmap');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, 'Roadmap');
  assert.equal((await vault.searchNotes('nonexistent')).length, 0);
});

test('the API key lives inside the encrypted blob', async () => {
  await vault.initDevice();
  await vault.setApiKey('sk-ant-secret-value');
  assert.equal(await vault.getApiKey(), 'sk-ant-secret-value');
  const onDisk = JSON.stringify([...storage.local.entries()]);
  assert.ok(!onDisk.includes('sk-ant-secret-value'), 'the key must not be readable on disk');
});

test('setting a passphrase re-encrypts, drops the device key, and gates reads', async () => {
  await vault.initDevice();
  await vault.createNote({ body: 'sensitive thought' });

  const set = await vault.setPassphrase('correct horse battery');
  assert.equal(set.ok, true);
  assert.equal(storage.local.has('tucky.vault.deviceKey'), false);
  assert.equal((await vault.listNotes())[0].body, 'sensitive thought');

  await vault.lock();
  assert.equal((await vault.getState()).locked, true);
  await assert.rejects(() => vault.listNotes(), { code: 'LOCKED' });

  assert.equal((await vault.unlock('wrong one')).ok, false);
  assert.equal((await vault.getState()).locked, true);

  assert.equal((await vault.unlock('correct horse battery')).ok, true);
  assert.equal((await vault.listNotes())[0].body, 'sensitive thought');
});

test('a short passphrase is refused, and the passphrase can be removed', async () => {
  await vault.initDevice();
  assert.equal((await vault.setPassphrase('short')).ok, false);

  await vault.setPassphrase('a long enough passphrase');
  await vault.createNote({ body: 'still here' });
  assert.equal((await vault.removePassphrase('nope')).ok, false);
  assert.equal((await vault.removePassphrase('a long enough passphrase')).ok, true);
  assert.equal((await vault.getState()).mode, 'device');
  assert.equal((await vault.listNotes())[0].body, 'still here');
});

test('export and import survive a round trip without duplicating', async () => {
  await vault.initDevice();
  await vault.createNote({ body: 'one' });
  const dump = await vault.exportAll();
  assert.equal((await vault.importNotes(dump.notes)).imported, 0, 'same ids are not re-imported');
  assert.equal((await vault.importNotes([{ body: 'two' }])).imported, 1);
  assert.equal((await vault.listNotes()).length, 2);
});
