# Tucky for Chrome

A recreation of [Tucky](https://tucky.io) — *notes at the edge, an agent inside* — as an
unpacked Chrome extension. Notes sleep as a thin stripe at the edge of every tab; reach over
and they fan out; pick one and it opens. The agent can be asked from anywhere, and everything
is encrypted on your machine.

## Install

1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → choose this `extension/` folder.
3. Tucky opens its settings page. Notes work immediately; paste an
   [Anthropic API key](https://console.anthropic.com/settings/keys) to wake the agent.

No build step, no bundler, no dependencies — the folder you load is the code that runs.

## What it does

| | |
|---|---|
| **Sleeps as a stripe** | A 5px stripe on the right edge of every page. Drag it up or down; it remembers where you put it. |
| **Fans out** | Hover or click and your notes splay out as a deck of cards. The card under the pointer slides clear of the others. |
| **Opens in place** | Click a card and it opens into a sheet at the edge — title, body, six colours, pin, delete. It autosaves as you type. |
| **Ask from anywhere** | `Alt+Shift+Space` on any page opens the ask bar. The answer streams in, and you can tuck it away as a note. |
| **Voice** | Hold the mic button (or `Alt+Space`) in the side panel and talk to your notes. |
| **Connectors** | The agent can read the page you're on, list your tabs, and — if you grant them — search your history and bookmarks. |
| **Encrypted locally** | Every note and your API key live in one AES-256-GCM blob in `chrome.storage.local`. Nothing syncs, nothing is sent anywhere except your own prompts to Anthropic. |

### Shortcuts

| Keys | |
|---|---|
| `Alt+Shift+T` | Fan out the notes |
| `Alt+Shift+Space` | Ask the agent |
| `Alt+Shift+N` | Tuck the current selection away |
| `Alt+Shift+P` | Open the side panel |
| `Alt+Space` (held, in the panel) | Talk |
| `Esc` | Tuck everything back in |

Right-click a selection for **Tuck selection into Tucky** and **Ask Tucky about this**.

## Encryption

Two modes, switchable in settings at any time — changing mode re-encrypts the notes in place.

- **Device key** (default). A random AES-256 key is generated at install and kept on this
  machine. Notes open without typing anything. This protects the notes from anything reading
  extension storage casually; it does not protect them from someone with your unlocked profile.
- **Passphrase.** The key is derived with PBKDF2-SHA256 (600,000 iterations) and is *never*
  written to disk — it lives in `chrome.storage.session`, which is memory-only and cleared when
  Chrome restarts or you hit **Lock**. Lose the passphrase and the notes are gone; there is no
  recovery, which is the point.

The API key lives inside the same encrypted blob, so locking Tucky also locks the agent.

## How it fits together

```
manifest.json              MV3, no build step
src/background/            the only privileged context: vault keys, API key, network
  service-worker.js        message router, shortcuts, context menus, streaming ports
src/lib/
  crypto.js                AES-GCM + PBKDF2 over WebCrypto
  vault.js                 the encrypted blob: notes, secrets, lock/unlock
  settings.js              non-secret preferences
  tools.js                 the connectors the agent may call
  agent.js                 Claude Messages API: SSE streaming + the tool loop
src/content/edge.js        the stripe, the fan, the sheet, the ask bar (shadow DOM)
src/sidepanel/             the whole app in a column, plus voice
src/popup/                 quick capture, unlock, per-site toggle
src/options/               API key, model, connectors, edge, encryption, export/import
```

Every UI surface talks to the service worker by message; none of them ever holds a key. The
content script draws into a shadow root, so no page stylesheet reaches in and nothing Tucky
draws leaks out.

### The agent

Requests go straight to `https://api.anthropic.com/v1/messages` from the service worker with
`anthropic-dangerous-direct-browser-access: true`, streamed as SSE. Default model
`claude-opus-5` with adaptive thinking and `effort: high`; Sonnet 5 and Haiku 4.5 are offered
in settings (Haiku is sent without thinking or effort, which it does not accept). Refusal
fallbacks are on by default and dropped automatically if your organisation does not have that
beta. The tool loop runs up to 8 rounds and returns every parallel tool result in a single
user message.

## Tests

```bash
npm test              # everything, including a real Chromium run
npm run test:unit     # vault, agent loop and wiring only — no browser
```

- `test/vault.test.mjs` — encryption at rest, notes CRUD, passphrase switching, export/import.
- `test/agent.test.mjs` — the SSE parser, tool dispatch, the fallback retry, refusals, per-model request shape, all against a canned stream.
- `test/wiring.test.mjs` — every manifest and HTML path exists; every `$('id')` has an element; every message the UI sends has a handler.
- `test/browser.test.mjs` — loads the unpacked extension into Chromium, clicks the stripe, writes a note through the real UI, and checks it is unreadable in `chrome.storage.local`.

`npm run icons` regenerates the PNGs; `npm run screenshot` retakes the images in `docs/`.

## Where it differs from the Mac app

Tucky proper is a native macOS app. Some things do not translate, and were replaced with the
browser-native equivalent rather than faked:

- **The edge is per-tab, not per-screen.** An extension cannot draw outside the browser
  window, so the stripe lives on the right edge of each page. Chrome forbids content scripts on
  `chrome://` pages and the Web Store; there the popup and side panel take over automatically.
- **Connectors are browser things** — the current page, your tabs, history and bookmarks —
  rather than Calendar and Mail.
- **Voice lives in the side panel**, not in the page. An extension page can hold microphone
  permission of its own; a content script would have to borrow the permission of whatever site
  you happened to be on.
- **Bring your own key.** There is no Plus tier and no server; you pay Anthropic directly for
  what you use.
