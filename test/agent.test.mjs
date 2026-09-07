// Exercises the agent loop against a canned SSE stream: no network, no key,
// but the same parsing, tool dispatch and message assembly the real one uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetStorage } from './chrome-shim.mjs';

chrome.tabs = { query: async () => [], get: async () => ({}), sendMessage: async () => null };
chrome.permissions = { contains: async () => false };
chrome.scripting = { executeScript: async () => [{ result: null }] };

const vault = await import('../extension/src/lib/vault.js');
const { ask } = await import('../extension/src/lib/agent.js');

function sse(events) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new Blob([body]).stream(), { status: 200 });
}

const TOOL_TURN = [
  { type: 'message_start', message: { id: 'msg_1' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search_notes' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"dentist"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
  { type: 'message_stop' },
];

const TEXT_TURN = [
  { type: 'message_start', message: { id: 'msg_2' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Your dentist ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is on Thursday.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
];

test.beforeEach(() => resetStorage());

test('streams text, runs the tool Claude asked for, and feeds the result back', async () => {
  await vault.initDevice();
  await vault.setApiKey('sk-ant-test');
  await vault.createNote({ title: 'Dentist', body: 'Thursday 3pm, Dr Alvarez' });

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return sse(requests.length === 1 ? TOOL_TURN : TEXT_TURN);
  };

  const events = [];
  const result = await ask({
    messages: [{ role: 'user', content: 'when is the dentist?' }],
    onEvent: (e) => events.push(e),
  });

  assert.equal(requests.length, 2, 'one turn for the tool call, one for the answer');
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(requests[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(requests[0].body.model, 'claude-opus-5');
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.thinking, { type: 'adaptive', display: 'omitted' });
  assert.ok(requests[0].body.tools.some((t) => t.name === 'search_notes'));
  assert.equal(requests[0].body.fallbacks, 'default', 'refusal fallbacks are on by default');
  assert.equal(requests[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');

  // The second request carries the assistant's tool_use and our tool_result.
  const followUp = requests[1].body.messages;
  const toolUse = followUp[1].content.find((b) => b.type === 'tool_use');
  assert.deepEqual(toolUse.input, { query: 'dentist' }, 'partial JSON deltas are reassembled');
  const toolResult = followUp[2].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'toolu_1');
  assert.match(toolResult.content, /Dr Alvarez/);

  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, 'Your dentist is on Thursday.');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(result.stopReason, 'end_turn');
});

test('a create_note tool call actually writes to the vault', async () => {
  await vault.initDevice();
  await vault.setApiKey('sk-ant-test');

  const createTurn = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_9', name: 'create_note' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"body":"pick up the parcel"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ];
  let call = 0;
  globalThis.fetch = async () => sse(call++ === 0 ? createTurn : TEXT_TURN);

  const events = [];
  await ask({ messages: [{ role: 'user', content: 'remember to pick up the parcel' }], onEvent: (e) => events.push(e) });

  const notes = await vault.listNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, 'pick up the parcel');
  assert.ok(events.some((e) => e.type === 'notes_changed'), 'the UI is told to refresh');
});

test('a missing API key is reported, not swallowed', async () => {
  await vault.initDevice();
  globalThis.fetch = async () => { throw new Error('should not be called'); };
  await assert.rejects(
    () => ask({ messages: [{ role: 'user', content: 'hi' }] }),
    (err) => err.code === 'NO_API_KEY',
  );
});

test('an API error surfaces the message Anthropic sent back', async () => {
  await vault.initDevice();
  await vault.setApiKey('sk-ant-bad');
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'invalid x-api-key' } }),
    { status: 401 },
  );
  await assert.rejects(
    () => ask({ messages: [{ role: 'user', content: 'hi' }] }),
    /invalid x-api-key/,
  );
});

test('a refusal ends the turn instead of looping', async () => {
  await vault.initDevice();
  await vault.setApiKey('sk-ant-test');
  globalThis.fetch = async () => sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
  ]);
  const events = [];
  const result = await ask({ messages: [{ role: 'user', content: '…' }], onEvent: (e) => events.push(e) });
  assert.equal(result.stopReason, 'refusal');
  assert.equal(events.at(-1).type, 'refusal');
  assert.equal(events.at(-1).category, 'cyber');
});

test('an org without the fallback beta gets the turn anyway', async () => {
  await vault.initDevice();
  await vault.setApiKey('sk-ant-test');

  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.fallbacks ?? null);
    if (body.fallbacks) {
      return new Response(
        JSON.stringify({ error: { message: 'beta feature server-side-fallback-2026-07-01 is not enabled' } }),
        { status: 400 },
      );
    }
    return sse(TEXT_TURN);
  };

  const events = [];
  const result = await ask({ messages: [{ role: 'user', content: 'hi' }], onEvent: (e) => events.push(e) });
  assert.deepEqual(seen, ['default', null], 'it retries once without the beta');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Your dentist is on Thursday.');
});

test('haiku gets neither adaptive thinking nor effort', async () => {
  await vault.initDevice();
  await vault.setApiKey('sk-ant-test');
  await chrome.storage.local.set({ 'tucky.settings': { model: 'claude-haiku-4-5', effort: 'high' } });

  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return sse(TEXT_TURN);
  };
  await ask({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
  assert.equal(body.fallbacks, undefined);
});
