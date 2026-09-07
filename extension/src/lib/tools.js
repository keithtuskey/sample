// The connectors. On a Mac, Tucky reaches into Calendar and Mail; in a browser
// the equivalent surface is the page you're on, the tabs you have open, and —
// if you grant them — history and bookmarks. Notes are always readable and
// writable, because that's the point.

import * as vault from './vault.js';

const PAGE_CHAR_LIMIT = 12000;

const NOTE_TOOLS = [
  {
    name: 'search_notes',
    description: 'Search the user\'s tucked notes by keyword. Returns matching notes with ids, titles and a body excerpt. Call this before answering anything about what the user has written down.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match. Empty string returns the most recent notes.' },
        limit: { type: 'integer', description: 'Maximum notes to return (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_note',
    description: 'Read one note in full by its id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_note',
    description: 'Tuck a new note away for the user. Use this when they ask you to write something down, save, remember, or capture something.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        color: { type: 'string', enum: vault.NOTE_COLORS },
      },
      required: ['body'],
    },
  },
  {
    name: 'update_note',
    description: 'Edit an existing note. Pass `append` to add to the end of the body without rewriting it.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Replaces the whole body.' },
        append: { type: 'string', description: 'Text to add to the end of the body.' },
      },
      required: ['id'],
    },
  },
];

const PAGE_TOOL = {
  name: 'read_page',
  description: 'Read the page the user is looking at: its title, URL, any text they have selected, and the readable body text.',
  input_schema: { type: 'object', properties: {} },
};

const TABS_TOOL = {
  name: 'list_tabs',
  description: 'List the tabs open in the current window, with titles and URLs.',
  input_schema: {
    type: 'object',
    properties: { all_windows: { type: 'boolean', description: 'Include every window, not just the current one.' } },
  },
};

const HISTORY_TOOL = {
  name: 'search_history',
  description: 'Search the user\'s browsing history for pages they have visited.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      days: { type: 'integer', description: 'How far back to look (default 14).' },
      limit: { type: 'integer' },
    },
    required: ['query'],
  },
};

const BOOKMARKS_TOOL = {
  name: 'search_bookmarks',
  description: 'Search the user\'s bookmarks.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    required: ['query'],
  },
};

const TIME_TOOL = {
  name: 'current_time',
  description: 'The current local date and time. Use it before answering anything about "today", "this week" or deadlines.',
  input_schema: { type: 'object', properties: {} },
};

export function toolsFor(settings) {
  const tools = [...NOTE_TOOLS, TIME_TOOL];
  const c = settings.connectors || {};
  if (c.page) tools.push(PAGE_TOOL);
  if (c.tabs) tools.push(TABS_TOOL);
  if (c.history) tools.push(HISTORY_TOOL);
  if (c.bookmarks) tools.push(BOOKMARKS_TOOL);
  return tools;
}

async function hasPermission(name) {
  try {
    return await chrome.permissions.contains({ permissions: [name] });
  } catch {
    return false;
  }
}

/** Asks the content script for the page first; falls back to injecting. */
async function readPage(tabId) {
  if (!tabId) return { error: 'No page is in focus right now.' };
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { error: 'That tab is gone.' };
  }
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'tucky.readPage' });
    if (res) return res;
  } catch {
    // No content script on this page (a restricted URL, or the page predates
    // the install). Try a one-off injection instead.
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPage,
      args: [PAGE_CHAR_LIMIT],
    });
    if (result) return result;
  } catch (err) {
    return {
      error: `Can't read this page (${err.message}). Chrome blocks extensions on its own pages and the Web Store.`,
      title: tab.title,
      url: tab.url,
    };
  }
  return { title: tab.title, url: tab.url, text: '' };
}

/** Runs inside the page. Kept self-contained so it can be injected. */
export function extractPage(limit) {
  const pick = document.querySelector('article, main, [role="main"]') || document.body;
  const text = (pick?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  const selection = String(window.getSelection?.() || '').trim();
  return {
    title: document.title,
    url: location.href,
    selection: selection.slice(0, 4000),
    text: text.slice(0, limit),
    truncated: text.length > limit,
  };
}

export async function runTool(name, input = {}, ctx = {}) {
  switch (name) {
    case 'search_notes': {
      const notes = await vault.searchNotes(input.query || '', input.limit || 10);
      return notes.map((n) => ({
        id: n.id,
        title: n.title,
        excerpt: n.body.slice(0, 400),
        pinned: n.pinned,
        updated: new Date(n.updatedAt).toISOString(),
        source: n.source?.url || null,
      }));
    }
    case 'read_note': {
      const note = await vault.getNote(input.id);
      return note || { error: `No note with id ${input.id}.` };
    }
    case 'create_note': {
      const note = await vault.createNote({
        title: input.title,
        body: input.body,
        color: input.color,
        source: ctx.page ? { url: ctx.page.url, title: ctx.page.title } : null,
      });
      return { created: true, id: note.id, title: note.title };
    }
    case 'update_note': {
      const note = await vault.updateNote(input.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.append !== undefined ? { append: input.append } : {}),
      });
      return note ? { updated: true, id: note.id, title: note.title } : { error: 'No such note.' };
    }
    case 'current_time': {
      const now = new Date();
      return {
        iso: now.toISOString(),
        local: now.toLocaleString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }
    case 'read_page':
      return readPage(ctx.tabId);
    case 'list_tabs': {
      const tabs = await chrome.tabs.query(input.all_windows ? {} : { currentWindow: true });
      return tabs
        .filter((t) => t.url && !t.url.startsWith('chrome://'))
        .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    }
    case 'search_history': {
      if (!(await hasPermission('history'))) {
        return { error: 'History is not connected. Turn it on in Tucky\'s settings.' };
      }
      const days = input.days || 14;
      const results = await chrome.history.search({
        text: input.query || '',
        startTime: Date.now() - days * 864e5,
        maxResults: input.limit || 25,
      });
      return results.map((h) => ({
        title: h.title, url: h.url, visits: h.visitCount,
        lastVisit: new Date(h.lastVisitTime).toISOString(),
      }));
    }
    case 'search_bookmarks': {
      if (!(await hasPermission('bookmarks'))) {
        return { error: 'Bookmarks are not connected. Turn them on in Tucky\'s settings.' };
      }
      const results = await chrome.bookmarks.search({ query: input.query || '' });
      return results
        .filter((b) => b.url)
        .slice(0, input.limit || 25)
        .map((b) => ({ title: b.title, url: b.url }));
    }
    default:
      return { error: `Unknown tool ${name}.` };
  }
}
