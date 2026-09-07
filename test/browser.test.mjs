// Loads the unpacked extension into Chromium and drives the real UI: the
// stripe at the edge, the fan, the sheet, and the round trip through the
// service worker into encrypted storage.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
} catch {
  try {
    ({ chromium } = require('playwright'));
  } catch {
    chromium = null;
  }
}

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));

const PAGE = `<!doctype html><html><head><title>A page to tuck notes on</title></head>
<body style="font:16px system-ui;padding:40px"><h1>Reading something</h1>
<p id="para">The quick brown fox jumps over the lazy dog.</p></body></html>`;

async function startServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test('the extension loads and works end to end in Chromium', { skip: chromium ? false : 'playwright is not installed' }, async (t) => {
  const { server, url } = await startServer();
  const profile = mkdtempSync(path.join(tmpdir(), 'tucky-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium', // the headless shell has no extension support
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--no-sandbox',
    ],
  });

  t.after(async () => {
    await context.close().catch(() => {});
    server.close();
    rmSync(profile, { recursive: true, force: true });
  });

  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 15000 });
  assert.match(worker.url(), /service-worker\.js$/, 'the service worker registered');

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(url);

  // The stripe is asleep at the edge.
  const stripe = page.locator('#tucky-host .stripe');
  await stripe.waitFor({ state: 'attached', timeout: 10000 });
  const width = await stripe.evaluate((el) => getComputedStyle(el).width);
  assert.equal(width, '5px', 'it sleeps as a thin stripe');

  // Reach over: the notes fan out.
  await stripe.click({ force: true });
  await page.waitForFunction(
    () => document.getElementById('tucky-host').shadowRoot.querySelector('.layer').dataset.open === 'fan',
  );
  const newCard = page.locator('#tucky-host .card.new-note');
  await newCard.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForFunction(() => {
    const card = document.getElementById('tucky-host').shadowRoot.querySelector('.card.new-note');
    return getComputedStyle(card).opacity === '1';
  }, null, { timeout: 5000 });

  // Pick one: it opens.
  await newCard.click();
  const body = page.locator('#tucky-host .sheet textarea');
  await body.waitFor({ state: 'visible' });
  await page.locator('#tucky-host .sheet input.title').fill('Kept at the edge');
  await body.fill('This note went through AES-GCM on the way to disk.');
  await page.waitForFunction(
    () => document.getElementById('tucky-host').shadowRoot.querySelector('.saved').textContent === 'Saved locally',
    null, { timeout: 5000 },
  );

  // It is on disk, and it is not readable there.
  const stored = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return JSON.stringify(all);
  });
  assert.ok(!stored.includes('AES-GCM on the way to disk'), 'the note is encrypted at rest');

  // The side panel — an extension page — sees the same vault.
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/panel.html`);
  await panel.locator('.note h3', { hasText: 'Kept at the edge' }).waitFor({ timeout: 5000 });

  const notes = await panel.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'notes.list' }, (res) => resolve(res.result));
  }));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'Kept at the edge');
  assert.equal(notes[0].body, 'This note went through AES-GCM on the way to disk.');

  // A second page finds the same note waiting in the fan.
  const second = await context.newPage();
  await second.goto(url);
  await second.locator('#tucky-host .stripe').click({ force: true });
  await second.locator('#tucky-host .card h4', { hasText: 'Kept at the edge' })
    .waitFor({ state: 'visible', timeout: 5000 });

  // The page connector reads what the user is looking at.
  await second.bringToFront();
  const secondTabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url.startsWith('http://127.0.0.1'))?.id;
  });
  const pageRead = await panel.evaluate(async (tabId) => {
    const tools = await import(chrome.runtime.getURL('src/lib/tools.js'));
    return tools.runTool('read_page', {}, { tabId });
  }, secondTabId);
  assert.match(pageRead.title, /A page to tuck notes on/);
  assert.match(pageRead.text, /quick brown fox/);

  // Escape tucks everything back in.
  await second.keyboard.press('Escape');
  await second.waitForFunction(
    () => !document.getElementById('tucky-host').shadowRoot.querySelector('.layer').dataset.open,
  );

  assert.deepEqual(errors, [], 'no page errors from the content script');
});
