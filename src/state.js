import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_SEEN = 1000;

export async function loadState(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      initialized: Boolean(parsed.initialized),
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      lastCheck: parsed.lastCheck ?? null,
      etag: parsed.etag ?? null,
      lastModified: parsed.lastModified ?? null,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { initialized: false, seen: [], lastCheck: null, etag: null, lastModified: null };
    }
    throw err;
  }
}

export async function saveState(file, state) {
  // Keep the most recent entries only so the file never grows unbounded.
  const seen = state.seen.slice(-MAX_SEEN);
  const out = { ...state, seen };
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2));
  await rename(tmp, file);
}

export function hasSeen(state, hash) {
  return state.seen.some((entry) => entry.hash === hash);
}

export function markSeen(state, entry) {
  state.seen.push({ ...entry, at: new Date().toISOString() });
}
