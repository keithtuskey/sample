// Tucky at the edge of the page.
//
// Asleep, it is a thin stripe against the side of the window. Reach over and
// the notes fan out. Pick one and it opens. Nothing here touches the page's
// own DOM beyond a single host element with a closed-off shadow root.

(() => {
  if (window.__tuckyEdgeLoaded) return;
  if (window.top !== window) return; // one Tucky per page, never in frames
  window.__tuckyEdgeLoaded = true;

  const PAGE_CHAR_LIMIT = 12000;
  const state = {
    settings: null,
    notes: [],
    mode: 'closed', // closed | fan | sheet | ask
    activeId: null,
    thread: [],
    runId: 0,
    port: null,
    saveTimer: null,
    dragging: false,
    peeked: false, // fanned out by hover, so it tucks itself back in
  };

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (res) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(new Error(lastError.message));
        if (!res) return reject(new Error('Tucky did not answer.'));
        if (!res.ok) return reject(Object.assign(new Error(res.error), { code: res.code }));
        resolve(res.result);
      });
    });
  }

  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /** Just enough markdown for an answer in a small panel. */
  function renderText(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  // ------------------------------------------------------------- shadow UI

  const host = document.createElement('div');
  host.id = 'tucky-host';
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .layer {
        --edge: 18px;
        --paper: #fffdf8;
        --ink: #1c1917;
        --muted: #78716c;
        --line: rgba(28, 25, 23, .12);
        --shadow: 0 18px 45px -14px rgba(28, 25, 23, .38), 0 2px 8px rgba(28, 25, 23, .10);
        --accent: #d97706;
        --amber: #fcd34d; --rose: #fda4af; --sky: #93c5fd;
        --mint: #86efac; --violet: #c4b5fd; --stone: #d6d3d1;
        font: 400 13.5px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
        color: var(--ink);
        -webkit-font-smoothing: antialiased;
      }
      @media (prefers-color-scheme: dark) {
        .layer {
          --paper: #201d1b;
          --ink: #f5f5f4;
          --muted: #a8a29e;
          --line: rgba(245, 245, 244, .14);
          --shadow: 0 18px 45px -14px rgba(0, 0, 0, .7), 0 2px 8px rgba(0, 0, 0, .45);
          --accent: #fbbf24;
        }
      }

      /* ---- the stripe it sleeps as ---- */
      .stripe {
        position: fixed;
        top: 50%;
        width: 5px;
        height: 132px;
        border-radius: 6px;
        background: linear-gradient(180deg, var(--accent), #b45309);
        opacity: .55;
        cursor: grab;
        transition: width .18s cubic-bezier(.2,.8,.3,1), opacity .18s, height .18s, box-shadow .18s;
        touch-action: none;
      }
      .layer[data-side="right"] .stripe { right: 3px; transform: translateY(-50%); }
      .layer[data-side="left"] .stripe { left: 3px; transform: translateY(-50%); }
      .stripe:hover, .layer[data-open] .stripe { width: 9px; opacity: 1; height: 168px; }
      .stripe:active { cursor: grabbing; }
      .stripe .count {
        position: absolute; top: -9px; left: 50%; transform: translateX(-50%);
        min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px;
        background: var(--paper); color: var(--ink); border: 1px solid var(--line);
        font-size: 10px; font-weight: 600; line-height: 15px; text-align: center;
        opacity: 0; transition: opacity .18s; box-shadow: var(--shadow);
      }
      .stripe:hover .count, .layer[data-open] .stripe .count { opacity: 1; }

      /* ---- the fan ---- */
      .fan { position: fixed; top: 50%; width: 0; height: 0; pointer-events: none; }
      .layer[data-side="right"] .fan { right: 26px; }
      .layer[data-side="left"] .fan { left: 26px; }
      .card {
        position: absolute;
        width: 222px; min-height: 118px; max-height: 148px; padding: 12px 13px;
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 13px;
        box-shadow: var(--shadow);
        overflow: hidden;
        cursor: pointer;
        opacity: 0;
        transform: translate(28px, -50%) scale(.94);
        transition: transform .34s cubic-bezier(.2,.9,.25,1), opacity .22s ease, box-shadow .18s;
        will-change: transform, opacity;
      }
      /* Anchor the card's inner edge to the stripe so it fans into the page,
         never off the side of the window. */
      .layer[data-side="right"] .card { right: 0; }
      .layer[data-side="left"] .card { left: 0; transform: translate(-28px, -50%) scale(.94); }
      .layer[data-open="fan"] .card, .layer[data-open="sheet"] .card { opacity: 1; }
      .card.is-active { outline: 2px solid var(--accent); outline-offset: 1px; }
      .card:hover { z-index: 40; }
      .card .swatch { position: absolute; inset: 0 auto 0 0; width: 4px; }
      .card h4 {
        margin: 0 0 5px; font-size: 13px; font-weight: 600; line-height: 1.35;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      }
      .card p {
        margin: 0; font-size: 11.5px; color: var(--muted); line-height: 1.45;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
      }
      .card .meta { margin-top: 7px; font-size: 10px; color: var(--muted); letter-spacing: .01em; }
      .card .pin { position: absolute; top: 9px; right: 10px; font-size: 10px; color: var(--accent); }
      .card.new-note { display: flex; align-items: center; justify-content: center; min-height: 44px;
        color: var(--muted); font-size: 12px; font-weight: 500; border-style: dashed; }

      /* ---- the sheet a note opens into ---- */
      .sheet {
        position: fixed; top: 44px; bottom: 44px; width: 384px;
        background: var(--paper); border: 1px solid var(--line); border-radius: 16px;
        box-shadow: var(--shadow); display: none; flex-direction: column; overflow: hidden;
      }
      .layer[data-side="right"] .sheet { right: 26px; }
      .layer[data-side="left"] .sheet { left: 26px; }
      .layer[data-open="sheet"] .sheet { display: flex; animation: rise .22s cubic-bezier(.2,.9,.25,1); }
      @keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.985); } }
      .sheet header { display: flex; align-items: center; gap: 8px; padding: 11px 12px 9px; border-bottom: 1px solid var(--line); }
      .sheet input.title {
        flex: 1; border: 0; background: transparent; color: var(--ink);
        font: 600 14.5px/1.4 inherit; padding: 3px 2px; outline: none;
      }
      .sheet textarea {
        flex: 1; border: 0; resize: none; outline: none; padding: 12px 14px;
        background: transparent; color: var(--ink); font: inherit; line-height: 1.6;
      }
      .sheet footer {
        display: flex; align-items: center; gap: 6px; padding: 9px 11px;
        border-top: 1px solid var(--line); font-size: 11px; color: var(--muted);
        flex-wrap: nowrap;
      }
      .sheet footer .saved {
        flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .btn { white-space: nowrap; }
      .dots { display: flex; gap: 5px; margin-right: auto; }
      .dot { width: 13px; height: 13px; border-radius: 50%; border: 1px solid var(--line); cursor: pointer; }
      .dot[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--accent); }

      /* ---- ask anywhere ---- */
      .ask {
        position: fixed; top: 13vh; left: 50%; transform: translateX(-50%);
        width: min(660px, calc(100vw - 72px));
        background: var(--paper); border: 1px solid var(--line); border-radius: 16px;
        box-shadow: var(--shadow); display: none; overflow: hidden;
      }
      .layer[data-open="ask"] .ask { display: block; animation: rise .2s cubic-bezier(.2,.9,.25,1); }
      .ask .row { display: flex; align-items: center; gap: 9px; padding: 12px 14px; }
      .ask .spark { color: var(--accent); font-size: 15px; line-height: 1; }
      .ask input {
        flex: 1; border: 0; outline: none; background: transparent; color: var(--ink);
        font: 400 15px/1.5 inherit;
      }
      .ask .answer {
        display: none; max-height: 44vh; overflow: auto; padding: 4px 16px 14px;
        border-top: 1px solid var(--line);
      }
      .ask .answer.on { display: block; }
      .ask .answer p { margin: 9px 0; }
      .ask .answer code {
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
        background: rgba(120,113,108,.16); padding: 1px 5px; border-radius: 5px;
      }
      .trace { font-size: 11.5px; color: var(--muted); padding: 9px 16px 0; display: none; }
      .trace.on { display: block; }
      .actions { display: flex; gap: 6px; padding: 0 16px 12px; }

      /* ---- shared chrome ---- */
      .btn {
        border: 1px solid var(--line); background: transparent; color: var(--muted);
        border-radius: 8px; padding: 4px 9px; font: 500 11.5px/1.5 inherit; cursor: pointer;
        transition: color .15s, border-color .15s, background .15s;
      }
      .btn:hover { color: var(--ink); border-color: var(--accent); }
      .btn.primary { color: var(--ink); border-color: var(--accent); }
      .toast {
        position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%) translateY(10px);
        background: var(--ink); color: var(--paper); padding: 8px 15px; border-radius: 999px;
        font-size: 12px; font-weight: 500; opacity: 0; pointer-events: none;
        transition: opacity .2s, transform .2s;
      }
      .toast.on { opacity: .96; transform: translateX(-50%) translateY(0); }
      .hidden { display: none !important; }
    </style>

    <div class="layer" part="layer">
      <div class="stripe" role="button" tabindex="0" aria-label="Tucky — reach over for your notes" title="Tucky — drag to move, click to fan out">
        <span class="count">0</span>
      </div>
      <div class="fan"></div>

      <section class="sheet" aria-label="Note">
        <header>
          <input class="title" placeholder="Title" aria-label="Note title">
          <button class="btn pin-btn" title="Pin to the front of the fan">Pin</button>
          <button class="btn close-sheet" title="Close (Esc)">Close</button>
        </header>
        <textarea placeholder="Tuck something away…" aria-label="Note body"></textarea>
        <footer>
          <span class="dots"></span>
          <span class="saved">Saved locally</span>
          <button class="btn ask-note" title="Ask the agent about this note">Ask</button>
          <button class="btn delete-note">Delete</button>
        </footer>
      </section>

      <section class="ask" aria-label="Ask your agent">
        <div class="row">
          <span class="spark">✦</span>
          <input class="ask-input" placeholder="Ask your notes, this page, your tabs…" aria-label="Ask Tucky">
          <button class="btn mic" title="Talk to your notes (opens the side panel)">Voice</button>
          <button class="btn stop hidden">Stop</button>
        </div>
        <div class="trace"></div>
        <div class="answer"></div>
        <div class="actions hidden">
          <button class="btn tuck-answer">Tuck as note</button>
          <button class="btn copy-answer">Copy</button>
          <button class="btn new-thread">New thread</button>
        </div>
      </section>

      <div class="toast"></div>
    </div>
  `;

  const $ = (sel) => root.querySelector(sel);
  const layer = $('.layer');
  const stripe = $('.stripe');
  const fan = $('.fan');
  const sheet = $('.sheet');
  const titleInput = $('.sheet input.title');
  const bodyInput = $('.sheet textarea');
  const savedLabel = $('.saved');
  const dots = $('.dots');
  const askBox = $('.ask');
  const askInput = $('.ask-input');
  const answerBox = $('.answer');
  const traceBox = $('.trace');
  const actions = $('.actions');
  const stopBtn = $('.stop');
  const toast = $('.toast');

  const COLORS = ['amber', 'rose', 'sky', 'mint', 'violet', 'stone'];
  for (const color of COLORS) {
    const dot = document.createElement('button');
    dot.className = 'dot';
    dot.dataset.color = color;
    dot.style.background = `var(--${color})`;
    dot.title = color;
    dot.setAttribute('aria-pressed', 'false');
    dots.append(dot);
  }

  function mount() {
    if (!host.isConnected) (document.body || document.documentElement).append(host);
  }

  // ------------------------------------------------------------ rendering

  function positionEdge() {
    const offset = state.settings?.edgeOffset ?? 0.5;
    stripe.style.top = `${Math.round(offset * 100)}%`;
    fan.style.top = `${Math.round(offset * 100)}%`;
    layer.dataset.side = state.settings?.edgeSide === 'left' ? 'left' : 'right';
  }

  function renderFan() {
    const side = layer.dataset.side === 'left' ? -1 : 1;
    const limit = state.settings?.fanCount ?? 7;
    const notes = state.notes.slice(0, limit);
    fan.textContent = '';

    const items = [...notes.map((n) => ({ note: n })), { newNote: true }];
    // Enough overlap to read every title, but never taller than the window.
    const pitch = Math.min(86, (window.innerHeight * 0.82) / Math.max(items.length - 1, 1));
    items.forEach((item, i) => {
      const card = document.createElement('div');
      const spread = items.length > 1 ? (i - (items.length - 1) / 2) : 0;
      const angle = spread * 3.4 * side;
      const lift = spread * pitch;
      const depth = 6 + Math.abs(spread) * 5;

      if (item.newNote) {
        card.className = 'card new-note';
        card.textContent = '+  New note';
        card.addEventListener('click', (e) => { if (!onStripe(e)) createNote(); });
      } else {
        const note = item.note;
        card.className = 'card' + (note.id === state.activeId ? ' is-active' : '');
        card.innerHTML = `
          <span class="swatch" style="background: var(--${note.color})"></span>
          ${note.pinned ? '<span class="pin">●</span>' : ''}
          <h4>${escapeHtml(note.title || 'Untitled')}</h4>
          <p>${escapeHtml((note.body || '').slice(0, 220))}</p>
          <div class="meta">${escapeHtml(relativeTime(note.updatedAt))}</div>
        `;
        card.addEventListener('click', (e) => { if (!onStripe(e)) openNote(note.id); });
      }

      card.style.transformOrigin = side === 1 ? 'right center' : 'left center';
      card.style.zIndex = String(50 - Math.round(Math.abs(spread) * 4));
      card.dataset.rest = `translate(${-side * depth}px, calc(-50% + ${lift}px)) rotate(${angle}deg)`;
      // Cards overlap in the deck, so the one under the pointer slides clear.
      card.dataset.lifted = `translate(${-side * (depth + 26)}px, calc(-50% + ${lift}px)) rotate(${angle * 0.4}deg) scale(1.03)`;
      card.style.transitionDelay = `${Math.min(i * 22, 160)}ms`;
      card.addEventListener('mouseenter', () => {
        if (!isFanOpen()) return;
        card.style.transitionDelay = '0ms';
        card.style.transform = card.dataset.lifted;
      });
      card.addEventListener('mouseleave', () => {
        if (!isFanOpen()) return;
        card.style.transform = card.dataset.rest;
      });
      fan.append(card);
    });

    applyFanTransforms();
    $('.count').textContent = String(state.notes.length);
  }

  /** True when the click landed on the stripe itself, not on a card. */
  function onStripe(event) {
    const box = stripe.getBoundingClientRect();
    return event.clientX >= box.left - 6 && event.clientX <= box.right + 6
      && event.clientY >= box.top && event.clientY <= box.bottom;
  }

  function isFanOpen() {
    return layer.dataset.open === 'fan' || layer.dataset.open === 'sheet';
  }

  function applyFanTransforms() {
    const open = isFanOpen();
    const side = layer.dataset.side === 'left' ? -1 : 1;
    for (const card of fan.querySelectorAll('.card')) {
      card.style.pointerEvents = open ? 'auto' : 'none';
      card.style.transform = open
        ? card.dataset.rest
        : `translate(${side * 28}px, -50%) scale(.94)`;
    }
  }

  function setMode(mode) {
    if (mode !== 'fan') state.peeked = false;
    state.mode = mode;
    if (mode === 'closed') delete layer.dataset.open;
    else layer.dataset.open = mode;
    applyFanTransforms();
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('on');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('on'), 1900);
  }

  // --------------------------------------------------------------- notes

  async function loadNotes() {
    try {
      state.notes = await send({ type: 'notes.list' });
      renderFan();
    } catch (err) {
      if (err.code === 'LOCKED') {
        state.notes = [];
        renderFan();
      }
    }
  }

  async function createNote(seed = {}) {
    try {
      const note = await send({
        type: 'notes.create',
        note: {
          body: seed.body || '',
          title: seed.title || '',
          source: { url: location.href, title: document.title },
        },
      });
      await loadNotes();
      openNote(note.id);
    } catch (err) {
      showToast(err.code === 'LOCKED' ? 'Tucky is locked — unlock it first' : err.message);
    }
  }

  function openNote(id) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) return;
    state.activeId = id;
    titleInput.value = note.title;
    bodyInput.value = note.body;
    savedLabel.textContent = `Saved · ${relativeTime(note.updatedAt)}`;
    $('.pin-btn').textContent = note.pinned ? 'Unpin' : 'Pin';
    for (const dot of dots.querySelectorAll('.dot')) {
      dot.setAttribute('aria-pressed', String(dot.dataset.color === note.color));
    }
    renderFan();
    setMode('sheet');
    setTimeout(() => (note.title ? bodyInput : titleInput).focus(), 60);
  }

  function queueSave() {
    savedLabel.textContent = 'Saving…';
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNote, 450);
  }

  async function saveNote(patch = {}) {
    if (!state.activeId) return;
    try {
      await send({
        type: 'notes.update',
        id: state.activeId,
        patch: { title: titleInput.value, body: bodyInput.value, ...patch },
      });
      savedLabel.textContent = 'Saved locally';
      await loadNotes();
    } catch (err) {
      savedLabel.textContent = err.code === 'LOCKED' ? 'Locked' : 'Not saved';
    }
  }

  // ----------------------------------------------------------- the agent

  function ensurePort() {
    if (state.port) return state.port;
    state.port = chrome.runtime.connect({ name: 'tucky-agent' });
    state.port.onDisconnect.addListener(() => { state.port = null; });
    state.port.onMessage.addListener(onAgentEvent);
    return state.port;
  }

  let pendingAnswer = '';

  function onAgentEvent(event) {
    if (event.runId !== state.runId) return;
    switch (event.type) {
      case 'text':
        pendingAnswer += event.text;
        answerBox.classList.add('on');
        answerBox.innerHTML = renderText(pendingAnswer);
        answerBox.scrollTop = answerBox.scrollHeight;
        break;
      case 'tool_start':
        traceBox.classList.add('on');
        traceBox.textContent = {
          search_notes: 'Looking through your notes…',
          read_page: 'Reading this page…',
          list_tabs: 'Glancing at your tabs…',
          search_history: 'Checking your history…',
          search_bookmarks: 'Checking your bookmarks…',
          create_note: 'Tucking a note away…',
          update_note: 'Updating a note…',
          current_time: 'Checking the date…',
        }[event.name] || `${event.name}…`;
        break;
      case 'tool_result':
        traceBox.textContent = event.summary;
        break;
      case 'notes_changed':
        loadNotes();
        break;
      case 'refusal':
        answerBox.classList.add('on');
        answerBox.innerHTML = renderText('Claude declined that one.' + (event.explanation ? ` ${event.explanation}` : ''));
        break;
      case 'complete':
        state.thread = event.messages;
        finishRun();
        break;
      case 'error':
        answerBox.classList.add('on');
        answerBox.innerHTML = renderText(event.error);
        if (event.code === 'NO_API_KEY') {
          const open = document.createElement('button');
          open.className = 'btn primary';
          open.textContent = 'Open settings';
          open.addEventListener('click', () => send({ type: 'ui.openOptions' }));
          answerBox.append(open);
        }
        finishRun();
        break;
      default:
        break;
    }
  }

  function finishRun() {
    stopBtn.classList.add('hidden');
    traceBox.classList.remove('on');
    if (pendingAnswer.trim()) actions.classList.remove('hidden');
  }

  function askAgent(question) {
    if (!question.trim()) return;
    pendingAnswer = '';
    answerBox.classList.add('on');
    answerBox.innerHTML = '<p style="opacity:.6">Thinking…</p>';
    actions.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    state.runId += 1;
    state.thread = [...state.thread, { role: 'user', content: question }];
    ensurePort().postMessage({ type: 'ask', runId: state.runId, messages: state.thread });
  }

  function openAsk(seed = '') {
    setMode('ask');
    if (seed) askInput.value = seed;
    setTimeout(() => { askInput.focus(); askInput.select(); }, 50);
  }

  // ------------------------------------------------------------- wiring

  /** Click pins the fan open; if hover already opened it, click keeps it. */
  function toggleFan() {
    if (state.mode === 'closed' || state.peeked) {
      state.peeked = false;
      setMode('fan');
    } else {
      setMode('closed');
    }
  }

  let dragStart = null;
  stripe.addEventListener('pointerdown', (e) => {
    dragStart = { y: e.clientY, moved: false };
    try { stripe.setPointerCapture(e.pointerId); } catch { /* no capture, no matter */ }
  });
  stripe.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    if (Math.abs(e.clientY - dragStart.y) > 4) dragStart.moved = true;
    if (!dragStart.moved) return;
    state.dragging = true;
    const offset = Math.min(0.92, Math.max(0.08, e.clientY / window.innerHeight));
    state.settings.edgeOffset = offset;
    positionEdge();
  });
  stripe.addEventListener('pointerup', (e) => {
    try { stripe.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    if (dragStart?.moved) {
      send({ type: 'settings.save', patch: { edgeOffset: state.settings.edgeOffset } }).catch(() => {});
    } else {
      toggleFan();
    }
    dragStart = null;
    state.dragging = false;
  });
  stripe.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleFan();
    }
  });
  stripe.addEventListener('mouseenter', () => {
    if (state.settings?.peekOnHover && state.mode === 'closed') {
      state.peeked = true;
      setMode('fan');
    }
  });

  // Leaving the whole corner tucks the fan back in, unless a note is open.
  let leaveTimer = null;
  root.addEventListener('mouseleave', () => {
    clearTimeout(leaveTimer);
    if (state.mode !== 'fan' || !state.peeked) return;
    leaveTimer = setTimeout(() => {
      if (state.mode === 'fan' && state.peeked) setMode('closed');
    }, 420);
  }, true);
  root.addEventListener('mouseenter', () => clearTimeout(leaveTimer), true);

  titleInput.addEventListener('input', queueSave);
  bodyInput.addEventListener('input', queueSave);
  $('.close-sheet').addEventListener('click', () => { saveNote(); setMode('fan'); });
  $('.pin-btn').addEventListener('click', async () => {
    const note = state.notes.find((n) => n.id === state.activeId);
    if (!note) return;
    await saveNote({ pinned: !note.pinned });
    openNote(state.activeId);
  });
  $('.delete-note').addEventListener('click', async () => {
    if (!state.activeId) return;
    await send({ type: 'notes.delete', id: state.activeId }).catch(() => {});
    state.activeId = null;
    await loadNotes();
    setMode('fan');
    showToast('Note deleted');
  });
  $('.ask-note').addEventListener('click', () => {
    const note = state.notes.find((n) => n.id === state.activeId);
    setMode('ask');
    openAsk(note ? `About my note "${note.title}": ` : '');
  });
  dots.addEventListener('click', (e) => {
    const dot = e.target.closest('.dot');
    if (!dot) return;
    saveNote({ color: dot.dataset.color }).then(() => openNote(state.activeId));
  });

  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      askAgent(askInput.value);
      askInput.value = '';
    }
  });
  stopBtn.addEventListener('click', () => {
    state.port?.postMessage({ type: 'cancel', runId: state.runId });
    finishRun();
  });
  $('.mic').addEventListener('click', () => {
    send({ type: 'ui.openPanel', voice: true }).catch(() => {});
    setMode('closed');
  });
  $('.tuck-answer').addEventListener('click', async () => {
    await createNote({ body: pendingAnswer, title: '' });
    showToast('Tucked away');
  });
  $('.copy-answer').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pendingAnswer);
      showToast('Copied');
    } catch {
      showToast('Clipboard blocked on this page');
    }
  });
  $('.new-thread').addEventListener('click', () => {
    state.thread = [];
    pendingAnswer = '';
    answerBox.classList.remove('on');
    actions.classList.add('hidden');
    askInput.focus();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state.mode === 'closed') return;
    if (state.mode === 'sheet') { saveNote(); setMode('fan'); }
    else setMode('closed');
    e.stopPropagation();
  }, true);

  document.addEventListener('click', (e) => {
    if (state.mode === 'closed' || state.dragging) return;
    if (e.composedPath().includes(host)) return;
    if (state.mode === 'sheet') saveNote();
    setMode('closed');
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'tucky.readPage': {
        const pick = document.querySelector('article, main, [role="main"]') || document.body;
        const text = (pick?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
        sendResponse({
          title: document.title,
          url: location.href,
          selection: String(window.getSelection?.() || '').trim().slice(0, 4000),
          text: text.slice(0, PAGE_CHAR_LIMIT),
          truncated: text.length > PAGE_CHAR_LIMIT,
        });
        break;
      }
      case 'tucky.toggleFan':
        state.peeked = false;
        toggleFan();
        break;
      case 'tucky.openAsk':
        openAsk(message.seed || String(window.getSelection?.() || '').trim().slice(0, 600));
        break;
      case 'tucky.quickCapture':
        createNote({ body: String(window.getSelection?.() || '').trim() });
        break;
      case 'tucky.toast':
        showToast(message.text);
        break;
      case 'tucky.notesChanged':
        loadNotes();
        break;
      case 'tucky.settingsChanged':
        state.settings = message.settings;
        applyVisibility();
        positionEdge();
        renderFan();
        break;
      default:
        break;
    }
    return false;
  });

  function applyVisibility() {
    const hidden = !state.settings?.showEdge
      || (state.settings?.disabledHosts || []).includes(location.hostname);
    layer.classList.toggle('hidden', hidden);
  }

  async function boot() {
    mount();
    try {
      state.settings = (await send({ type: 'settings.get' }));
    } catch {
      state.settings = { edgeSide: 'right', edgeOffset: 0.5, showEdge: true, fanCount: 7, peekOnHover: true, disabledHosts: [] };
    }
    applyVisibility();
    positionEdge();
    await loadNotes();
    setMode('closed');
  }

  boot();
})();
