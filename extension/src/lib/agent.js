// The agent inside. Talks to the Claude Messages API over raw HTTPS from the
// service worker — no bundler, no SDK, so the folder you load into Chrome is
// the folder that runs. The key is read out of the encrypted vault for the
// length of one request and never persisted anywhere else.

import { runTool, toolsFor } from './tools.js';
import { getSettings } from './settings.js';
import { getApiKey } from './vault.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 16000;
const MAX_TOOL_ROUNDS = 8;

const SYSTEM_PROMPT = `You are the agent inside Tucky, a notes app that lives at the edge of the user's browser window.

The user's notes are private and encrypted on their machine; you are the only thing that reads them on their behalf. Work from what is actually in the notes and on the page in front of them — search before you answer, and say plainly when you find nothing rather than inventing something.

How to behave:
- Reach for tools first. If the question touches what they wrote down, call search_notes. If it touches "this page", "this article" or "what I'm reading", call read_page. If it touches dates or deadlines, call current_time.
- When they ask you to remember, capture, save or write something down, actually call create_note or update_note — don't just reply that you will.
- Answer in a couple of short paragraphs at most. This is a panel at the edge of a window, not a document. No headers, no bullet lists unless the user asks for a list.
- Never fabricate note contents, URLs or dates. Quote the note title when you use one.`;

function paramsForModel(model, effort) {
  // Haiku predates adaptive thinking and rejects `effort`; the Opus and Sonnet
  // 5 families take both.
  if (model.startsWith('claude-haiku')) return {};
  const params = { thinking: { type: 'adaptive', display: 'omitted' } };
  if (effort) params.output_config = { effort };
  return params;
}

function supportsServerFallback(model) {
  return model.startsWith('claude-opus') || model.startsWith('claude-fable');
}

/** Reads one SSE stream, yielding parsed event objects. */
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // A partial frame we can't use; the next chunk will carry the rest.
        }
      }
    }
  }
}

async function errorFromResponse(response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    detail = await response.text().catch(() => '');
  }
  const err = new Error(detail || `Request failed (${response.status}).`);
  err.status = response.status;
  return err;
}

/**
 * Streams one assistant turn. Returns the assembled assistant message plus the
 * stop reason, so the tool loop can decide whether to go round again.
 */
async function streamTurn({ apiKey, model, messages, tools, effort, useFallback, onEvent, signal }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // Required for calls made from a browser context, which is what an
    // extension service worker is.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system: SYSTEM_PROMPT,
    messages,
    tools,
    ...paramsForModel(model, effort),
  };
  if (useFallback) {
    headers['anthropic-beta'] = FALLBACK_BETA;
    body.fallbacks = 'default';
  }

  const response = await fetch(API_URL, {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw await errorFromResponse(response);

  const content = [];
  let stopReason = null;
  let stopDetails = null;
  let usage = null;

  for await (const event of readEvents(response)) {
    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        content[event.index] = block.type === 'tool_use'
          ? { ...block, input: {}, _json: '' }
          : { ...block };
        if (block.type === 'tool_use') onEvent({ type: 'tool_start', name: block.name });
        break;
      }
      case 'content_block_delta': {
        const block = content[event.index];
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          block.text = (block.text || '') + delta.text;
          onEvent({ type: 'text', text: delta.text });
        } else if (delta.type === 'thinking_delta') {
          block.thinking = (block.thinking || '') + delta.thinking;
        } else if (delta.type === 'signature_delta') {
          block.signature = delta.signature;
        } else if (delta.type === 'input_json_delta') {
          block._json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const block = content[event.index];
        if (block?.type === 'tool_use') {
          try {
            block.input = block._json ? JSON.parse(block._json) : {};
          } catch {
            block.input = {};
          }
          delete block._json;
        }
        break;
      }
      case 'message_delta':
        stopReason = event.delta?.stop_reason ?? stopReason;
        stopDetails = event.delta?.stop_details ?? stopDetails;
        usage = event.usage || usage;
        break;
      case 'error':
        throw new Error(event.error?.message || 'The stream failed.');
      default:
        break;
    }
  }

  return { content: content.filter(Boolean), stopReason, stopDetails, usage };
}

function summarizeResult(name, result) {
  if (result && result.error) return `${name}: ${result.error}`;
  if (Array.isArray(result)) return `${name}: ${result.length} result${result.length === 1 ? '' : 's'}`;
  if (name === 'create_note') return `Tucked "${result.title || 'note'}" away`;
  if (name === 'update_note') return `Updated "${result.title || 'note'}"`;
  if (name === 'read_page') return `Read "${result?.title || 'the page'}"`;
  return name;
}

/**
 * Runs a full agent turn: stream, execute any tools Claude asked for, stream
 * again, until it stops asking. `onEvent` receives deltas as they arrive.
 */
export async function ask({ messages, tabId, onEvent = () => {}, signal }) {
  const settings = await getSettings();
  const apiKey = await getApiKey();
  if (!apiKey) {
    const err = new Error('Add your Anthropic API key in Tucky\'s settings to wake the agent.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const model = settings.model;
  const tools = toolsFor(settings);
  const convo = [...messages];
  let useFallback = supportsServerFallback(model);

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let turn;
    try {
      turn = await streamTurn({
        apiKey, model, tools, signal, onEvent,
        messages: convo,
        effort: settings.effort,
        useFallback,
      });
    } catch (err) {
      // Some organisations don't have the server-side fallback beta enabled.
      // Drop it and take the turn without refusal routing rather than failing.
      if (useFallback && /beta|fallback/i.test(err.message || '')) {
        useFallback = false;
        round--;
        continue;
      }
      throw err;
    }

    convo.push({ role: 'assistant', content: turn.content });

    if (turn.stopReason === 'refusal') {
      onEvent({
        type: 'refusal',
        category: turn.stopDetails?.category || null,
        explanation: turn.stopDetails?.explanation || '',
      });
      return { messages: convo, stopReason: 'refusal' };
    }

    if (turn.stopReason !== 'tool_use') {
      onEvent({ type: 'done', usage: turn.usage });
      return { messages: convo, stopReason: turn.stopReason, usage: turn.usage };
    }

    const calls = turn.content.filter((b) => b.type === 'tool_use');
    // Parallel calls come back in one assistant message; run them together and
    // return every result in a single user message.
    const results = await Promise.all(calls.map(async (call) => {
      try {
        const result = await runTool(call.name, call.input, { tabId });
        onEvent({ type: 'tool_result', name: call.name, summary: summarizeResult(call.name, result) });
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result ?? null),
        };
      } catch (err) {
        onEvent({ type: 'tool_result', name: call.name, summary: `${call.name} failed`, error: true });
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: true,
          content: String(err?.message || err),
        };
      }
    }));
    convo.push({ role: 'user', content: results });
    if (results.some((r) => r.content?.includes('"created":true') || r.content?.includes('"updated":true'))) {
      onEvent({ type: 'notes_changed' });
    }
  }

  onEvent({ type: 'done', truncated: true });
  return { messages: convo, stopReason: 'max_tool_rounds' };
}

/** A single, non-streaming call used for one-shot rewrites of a note. */
export async function transform({ instruction, text, signal }) {
  const settings = await getSettings();
  const apiKey = await getApiKey();
  if (!apiKey) throw Object.assign(new Error('Add your Anthropic API key in settings.'), { code: 'NO_API_KEY' });

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const response = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: MAX_TOKENS,
      system: 'You rewrite a single note for the user. Return only the rewritten note text — no preamble, no explanation, no code fences.',
      messages: [{ role: 'user', content: `${instruction}\n\n---\n${text}` }],
      ...paramsForModel(settings.model, settings.effort),
    }),
  });
  if (!response.ok) throw await errorFromResponse(response);
  const message = await response.json();
  if (message.stop_reason === 'refusal') {
    throw new Error('Claude declined that rewrite.');
  }
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
