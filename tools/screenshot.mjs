// Loads the extension into Chromium, seeds a few notes, and photographs the
// edge with the fan open. Writes to docs/.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const OUT = fileURLToPath(new URL('../docs', import.meta.url));
mkdirSync(OUT, { recursive: true });

const PAGE = `<!doctype html><html><head><title>An article</title></head>
<body style="font:17px/1.7 Georgia,serif;max-width:660px;margin:60px auto;color:#292524">
<h1 style="font-size:30px">Working at the edge</h1>
<p>Notes are only useful where the work is. Anything that asks you to leave the page
first is a note you will not write down.</p>
<p>So the notes wait at the edge of the window instead — a stripe you can ignore until
you reach for it, and a fan of cards when you do.</p>
</body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(path.join(tmpdir(), 'tucky-shot-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1180, height: 760 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, '--no-sandbox'],
});

const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const seed = await context.newPage();
await seed.goto(`chrome-extension://${extensionId}/src/sidepanel/panel.html`);
await seed.evaluate(async () => {
  const notes = [
    { title: 'Ship the fan-out', body: 'Cards should splay from the stripe, not slide.', color: 'amber', pinned: true },
    { title: 'Dentist', body: 'Thursday 3pm, Dr Alvarez. Bring the referral.', color: 'rose' },
    { title: 'Reading list', body: 'Two papers on local-first software, plus the CRDT one.', color: 'sky' },
    { title: 'Groceries', body: 'oat milk, coffee, the good bread', color: 'mint' },
    { title: 'Interview notes', body: 'They wanted encryption on by default. Nobody wants a setup wizard.', color: 'violet' },
  ];
  for (const note of notes) {
    await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'notes.create', note }, resolve));
  }
});

const page = await context.newPage();
await page.goto(url);
await page.locator('#tucky-host .stripe').waitFor({ state: 'attached' });
await page.locator('#tucky-host .stripe').click({ force: true });
await page.waitForFunction(() => {
  const card = document.getElementById('tucky-host').shadowRoot.querySelector('.card');
  return card && getComputedStyle(card).opacity === '1';
});
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'edge-fan.png') });

// And the sheet a note opens into.
const dentist = page.locator('#tucky-host .card', { hasText: 'Dr Alvarez' });
await dentist.hover({ force: true });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, 'edge-hover.png') });
await dentist.locator('h4').click({ force: true });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'edge-note.png') });

await seed.screenshot({ path: path.join(OUT, 'side-panel.png') });

await context.close();
server.close();
rmSync(profile, { recursive: true, force: true });
console.log('wrote docs/edge-fan.png, docs/edge-note.png, docs/side-panel.png');
