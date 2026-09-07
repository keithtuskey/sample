// Cheap structural checks: every path the manifest and the HTML pages point at
// exists, and every getElementById in a page has a matching element.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../extension/', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('every file the manifest names is on disk', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const paths = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.action.default_popup,
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((cs) => [...cs.js, ...cs.css]),
  ];
  for (const rel of paths) {
    assert.ok(existsSync(path.join(ROOT, rel)), `${rel} is missing`);
  }
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  assert.ok(manifest.host_permissions.includes('https://api.anthropic.com/*'));
  assert.equal(Object.keys(manifest.commands).length, 4, 'Chrome allows four suggested shortcuts');
});

for (const page of ['sidepanel/panel.html', 'popup/popup.html', 'options/options.html']) {
  test(`${page} references real assets and every id it scripts`, () => {
    const html = read(`src/${page}`);
    const dir = path.dirname(path.join(ROOT, 'src', page));

    for (const [, href] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (href.startsWith('http')) continue;
      assert.ok(existsSync(path.resolve(dir, href)), `${page} points at a missing ${href}`);
    }

    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const scriptRel = html.match(/<script[^>]*src="([^"]+)"/)[1];
    const script = readFileSync(path.resolve(dir, scriptRel), 'utf8');
    for (const [, id] of script.matchAll(/\$\('([^']+)'\)/g)) {
      assert.ok(ids.has(id), `${page}: script uses #${id}, which the markup does not define`);
    }
  });
}

test('the content script only reaches the service worker through known handlers', () => {
  const worker = read('src/background/service-worker.js');
  const handlers = new Set([...worker.matchAll(/^\s{2}'([a-z]+\.[A-Za-z]+)':/gm)].map((m) => m[1]));
  const callers = ['src/content/edge.js', 'src/sidepanel/panel.js', 'src/popup/popup.js', 'src/options/options.js'];
  for (const rel of callers) {
    const source = read(rel);
    for (const [, type] of source.matchAll(/type:\s*'([a-z]+\.[A-Za-z]+)'/g)) {
      if (type.startsWith('tucky.')) continue; // broadcasts, not requests
      assert.ok(handlers.has(type), `${rel} sends "${type}", which no handler answers`);
    }
  }
});
