// Just enough of the chrome.* surface for the vault to run under `node --test`.
const local = new Map();
const session = new Map();

function area(map) {
  return {
    async get(keys) {
      const names = keys == null ? [...map.keys()] : (Array.isArray(keys) ? keys : [keys]);
      const out = {};
      for (const name of names) if (map.has(name)) out[name] = map.get(name);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) map.delete(k);
    },
    async clear() { map.clear(); },
  };
}

globalThis.chrome = {
  storage: { local: area(local), session: area(session) },
  runtime: { lastError: null, id: 'test' },
};

export function resetStorage() {
  local.clear();
  session.clear();
}

export const storage = { local, session };
