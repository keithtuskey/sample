// The side panel: the whole of Tucky in one column — the notes, the agent,
// and the microphone. Voice lives here rather than in the page because an
// extension page can hold microphone permission of its own.

import { relativeTime, renderText, send } from '../ui/rpc.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['amber', 'rose', 'sky', 'mint', 'violet', 'stone'];

const state = {
  notes: [],
  query: '',
  activeId: null,
  thread: [],
  runId: 0,
  port: null,
  saveTimer: null,
  streamingEl: null,
  answer: '',
};

// ------------------------------------------------------------------ notes

function noteCard(note) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'note';
  btn.innerHTML = `
    <span class="swatch" style="background: var(--${note.color})"></span>
    ${note.pinned ? '<span class="pin">●</span>' : ''}
    <h3></h3><p></p><div class="meta"></div>
  `;
  btn.querySelector('h3').textContent = note.title || 'Untitled';
  btn.querySelector('p').textContent = (note.body || '').slice(0, 220);
  btn.querySelector('.meta').textContent = note.source?.title
    ? `${relativeTime(note.updatedAt)} · ${note.source.title.slice(0, 40)}`
    : relativeTime(note.updatedAt);
  btn.addEventListener('click', () => openNote(note.id));
  li.append(btn);
  return li;
}

async function refreshNotes() {
  try {
    state.notes = state.query
      ? await send({ type: 'notes.search', query: state.query, limit: 100 })
      : await send({ type: 'notes.list' });
  } catch (err) {
    if (err.code === 'LOCKED') return showLocked(true);
    throw err;
  }
  const list = $('note-list');
  list.textContent = '';
  for (const note of state.notes) list.append(noteCard(note));
  $('notes-empty').classList.toggle('hidden', state.notes.length > 0);
}

function openNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  state.activeId = id;
  $('note-title').value = note.title;
  $('note-body').value = note.body;
  $('note-pin').textContent = note.pinned ? 'Unpin' : 'Pin';
  $('note-status').textContent = `Saved · ${relativeTime(note.updatedAt)}`;
  for (const dot of $('dots').children) {
    dot.setAttribute('aria-pressed', String(dot.dataset.color === note.color));
  }
  $('editor').classList.remove('hidden');
  $('note-body').focus();
}

function closeEditor() {
  $('editor').classList.add('hidden');
  state.activeId = null;
}

function queueSave() {
  $('note-status').textContent = 'Saving…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveNote(), 450);
}

async function saveNote(patch = {}) {
  if (!state.activeId) return;
  await send({
    type: 'notes.update',
    id: state.activeId,
    patch: { title: $('note-title').value, body: $('note-body').value, ...patch },
  });
  $('note-status').textContent = 'Saved locally';
  await refreshNotes();
}

// -------------------------------------------------------------- the agent

function ensurePort() {
  if (state.port) return state.port;
  state.port = chrome.runtime.connect({ name: 'tucky-agent' });
  state.port.onDisconnect.addListener(() => { state.port = null; });
  state.port.onMessage.addListener(onAgentEvent);
  return state.port;
}

function addTurn(role, html) {
  const div = document.createElement('div');
  div.className = `turn ${role}`;
  div.innerHTML = html;
  const intro = document.querySelector('.intro');
  if (intro) intro.remove();
  $('thread').append(div);
  $('thread').scrollTop = $('thread').scrollHeight;
  return div;
}

function onAgentEvent(event) {
  if (event.runId !== state.runId) return;
  switch (event.type) {
    case 'text':
      state.answer += event.text;
      state.streamingEl.innerHTML = renderText(state.answer);
      $('thread').scrollTop = $('thread').scrollHeight;
      break;
    case 'tool_start':
    case 'tool_result':
      $('trace').classList.remove('hidden');
      $('trace').textContent = event.summary || `${event.name}…`;
      break;
    case 'notes_changed':
      refreshNotes();
      break;
    case 'refusal':
      state.streamingEl.innerHTML = renderText(
        `Claude declined that one.${event.explanation ? ` ${event.explanation}` : ''}`,
      );
      break;
    case 'complete':
      state.thread = event.messages;
      endRun();
      break;
    case 'error':
      state.streamingEl.innerHTML = renderText(event.error);
      if (event.code === 'NO_API_KEY') {
        const btn = document.createElement('button');
        btn.className = 'primary';
        btn.textContent = 'Add your API key';
        btn.addEventListener('click', () => send({ type: 'ui.openOptions' }));
        state.streamingEl.append(btn);
      }
      endRun();
      break;
    default:
      break;
  }
}

function endRun() {
  $('trace').classList.add('hidden');
  $('ask-stop').classList.add('hidden');
  $('ask-send').disabled = false;
  if (state.answer.trim() && state.streamingEl) {
    const bar = document.createElement('div');
    bar.className = 'turn-actions';
    const tuck = document.createElement('button');
    tuck.textContent = 'Tuck as note';
    const answer = state.answer;
    tuck.addEventListener('click', async () => {
      await send({ type: 'notes.create', note: { body: answer } });
      tuck.textContent = 'Tucked away';
      await refreshNotes();
    });
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => navigator.clipboard.writeText(answer));
    bar.append(tuck, copy);
    state.streamingEl.append(bar);
  }
  state.streamingEl = null;
}

async function askAgent(question) {
  const text = question.trim();
  if (!text) return;
  addTurn('user', renderText(text));
  state.answer = '';
  state.streamingEl = addTurn('agent', '<p class="muted">Thinking…</p>');
  state.runId += 1;
  state.thread = [...state.thread, { role: 'user', content: text }];
  $('ask-send').disabled = true;
  $('ask-stop').classList.remove('hidden');
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  ensurePort().postMessage({
    type: 'ask', runId: state.runId, messages: state.thread, tabId: tab?.id,
  });
}

// ------------------------------------------------------------------ voice

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let voiceActive = false;
let voiceBase = '';

function startVoice() {
  if (voiceActive) return;
  if (!Recognition) {
    $('mic-state').textContent = 'This Chrome build has no speech recognition.';
    return;
  }
  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  voiceBase = $('ask-input').value.trim();
  voiceActive = true;
  $('mic').classList.add('is-live');
  $('mic-state').textContent = 'Listening…';

  recognition.onresult = (event) => {
    let text = '';
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
    $('ask-input').value = (voiceBase ? `${voiceBase} ` : '') + text.trim();
  };
  recognition.onerror = (event) => {
    $('mic-state').textContent = event.error === 'not-allowed'
      ? 'Microphone blocked — allow it for this panel.'
      : `Voice error: ${event.error}`;
    stopVoice(false);
  };
  recognition.onend = () => {
    if (voiceActive) stopVoice(true);
  };
  try {
    recognition.start();
  } catch {
    stopVoice(false);
  }
}

function stopVoice(sendIt) {
  if (!voiceActive) return;
  voiceActive = false;
  $('mic').classList.remove('is-live');
  $('mic-state').textContent = '';
  try { recognition?.stop(); } catch { /* already stopped */ }
  recognition = null;
  if (sendIt && $('ask-input').value.trim()) {
    askAgent($('ask-input').value);
    $('ask-input').value = '';
  }
}

// ----------------------------------------------------------------- wiring

function showLocked(locked) {
  $('locked').classList.toggle('hidden', !locked);
  $('app').classList.toggle('hidden', locked);
  if (locked) $('passphrase').focus();
}

function switchTab(which) {
  $('tab-notes').classList.toggle('is-on', which === 'notes');
  $('tab-ask').classList.toggle('is-on', which === 'ask');
  $('view-notes').classList.toggle('hidden', which !== 'notes');
  $('view-ask').classList.toggle('hidden', which !== 'ask');
  if (which === 'ask') $('ask-input').focus();
}

function wire() {
  for (const color of COLORS) {
    const dot = document.createElement('button');
    dot.className = 'dot';
    dot.dataset.color = color;
    dot.style.background = `var(--${color})`;
    dot.title = color;
    dot.addEventListener('click', async () => {
      await saveNote({ color });
      openNote(state.activeId);
    });
    $('dots').append(dot);
  }

  $('tab-notes').addEventListener('click', () => switchTab('notes'));
  $('tab-ask').addEventListener('click', () => switchTab('ask'));
  $('settings').addEventListener('click', () => send({ type: 'ui.openOptions' }));
  $('lock').addEventListener('click', async () => {
    const res = await send({ type: 'vault.lock' });
    if (res.reason === 'device-mode') {
      $('lock').textContent = 'Set a passphrase →';
      send({ type: 'ui.openOptions' });
      return;
    }
    showLocked(true);
  });
  $('unlock').addEventListener('click', async () => {
    const res = await send({ type: 'vault.unlock', passphrase: $('passphrase').value });
    if (!res.ok) { $('unlock-error').textContent = res.error; return; }
    $('passphrase').value = '';
    $('unlock-error').textContent = '';
    showLocked(false);
    await refreshNotes();
  });
  $('passphrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlock').click(); });

  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    refreshNotes();
  });
  $('new-note').addEventListener('click', async () => {
    const note = await send({ type: 'notes.create', note: { body: '' } });
    await refreshNotes();
    openNote(note.id);
    $('note-title').focus();
  });
  $('note-title').addEventListener('input', queueSave);
  $('note-body').addEventListener('input', queueSave);
  $('editor-close').addEventListener('click', async () => { await saveNote(); closeEditor(); });
  $('note-pin').addEventListener('click', async () => {
    const note = state.notes.find((n) => n.id === state.activeId);
    await saveNote({ pinned: !note?.pinned });
    openNote(state.activeId);
  });
  $('note-delete').addEventListener('click', async () => {
    if (!state.activeId) return;
    await send({ type: 'notes.delete', id: state.activeId });
    closeEditor();
    await refreshNotes();
  });
  $('rewrite').addEventListener('change', async (e) => {
    const instruction = e.target.value;
    e.target.selectedIndex = 0;
    if (!instruction || !state.activeId) return;
    $('note-status').textContent = 'Asking the agent…';
    try {
      const rewritten = await send({
        type: 'agent.transform', instruction, text: $('note-body').value,
      });
      $('note-body').value = rewritten;
      await saveNote();
    } catch (err) {
      $('note-status').textContent = err.message;
    }
  });

  $('ask-send').addEventListener('click', () => {
    askAgent($('ask-input').value);
    $('ask-input').value = '';
  });
  $('ask-stop').addEventListener('click', () => {
    state.port?.postMessage({ type: 'cancel', runId: state.runId });
    endRun();
  });
  $('ask-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('ask-send').click();
    }
  });

  $('mic').addEventListener('pointerdown', startVoice);
  $('mic').addEventListener('pointerup', () => stopVoice(true));
  $('mic').addEventListener('pointerleave', () => { if (voiceActive) stopVoice(true); });

  // Hold Alt+Space and talk — the browser's answer to holding ⌥Space.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      switchTab('ask');
      startVoice();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' || e.key === 'Alt') stopVoice(true);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'tucky.notesChanged') refreshNotes();
    return false;
  });
}

async function boot() {
  wire();
  const vaultState = await send({ type: 'vault.state' });
  showLocked(vaultState.locked);
  if (!vaultState.locked) await refreshNotes();

  const { pending } = await send({ type: 'ui.voicePending' });
  if (pending && !vaultState.locked) {
    switchTab('ask');
    $('mic-state').textContent = 'Hold the mic button, or Alt+Space, and talk.';
  }
}

boot();
