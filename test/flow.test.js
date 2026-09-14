import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkOnce } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { loadState } from '../src/state.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

const BASE = 'https://flcannabisdeals.org/todays-florida-dispensary-deals/';
const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';

function makeSite(images) {
  // images: { [url]: Buffer }
  const html = `<html><body><div class="entry-content"><h2>Deals</h2>${Object.keys(images)
    .map((u) => `<img src="${u}" alt="deal">`)
    .join('')}</div></body></html>`;
  const posts = [];
  const edits = [];
  const deletes = [];
  let nextMessage = 1;
  const fetchImpl = async (url, init = {}) => {
    if (url === BASE) {
      return { ok: true, status: 200, headers: new Headers({ etag: '"v1"' }), text: async () => html };
    }
    if (images[url]) {
      const b = images[url];
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      };
    }
    if (url.startsWith(WEBHOOK)) {
      const method = init.method ?? 'GET';
      if (method === 'POST') {
        posts.push(init.body);
        const payload = JSON.parse(init.body.get('payload_json'));
        const id = `m${nextMessage++}`;
        const message = {
          id,
          attachments: payload.attachments.map((a, i) => ({ id: `${id}-a${i}`, filename: a.filename })),
        };
        return { ok: true, status: 200, json: async () => message, text: async () => '' };
      }
      if (method === 'PATCH') {
        edits.push({ messageId: url.split('/').pop(), body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      }
      if (method === 'DELETE') {
        deletes.push(url.split('/').pop());
        return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
      }
    }
    throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url}`);
  };
  return { fetchImpl, posts, edits, deletes };
}

function bigBuffer(seed) {
  return Buffer.alloc(20000, seed);
}

async function freshConfig() {
  const dir = await mkdtemp(path.join(tmpdir(), 'flcd-'));
  process.env.DISCORD_WEBHOOK_URL = WEBHOOK;
  process.env.STATE_FILE = path.join(dir, 'state.json');
  return loadConfig([]);
}

async function reload(config) {
  // Fresh state from disk with the ETag cleared so the 304 short-circuit is not what stops a check.
  const state = await loadState(config.stateFile);
  state.etag = null;
  state.lastModified = null;
  return state;
}

test('posts new images once, then stays quiet until the image bytes change', async () => {
  const config = await freshConfig();
  const url = 'https://flcannabisdeals.org/wp-content/uploads/deals.jpg';

  let site = makeSite({ [url]: bigBuffer('a') });
  let state = await loadState(config.stateFile);

  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 1);
  assert.equal(site.posts.length, 1);
  const payload = JSON.parse(site.posts[0].get('payload_json'));
  assert.equal(payload.attachments.length, 1);
  assert.match(payload.content, /Current deals/);
  assert.match(payload.content, /Deals - deal/);

  // Same bytes again: nothing posted, nothing removed.
  state = await reload(config);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 0);
  assert.equal(site.posts.length, 1);
  assert.equal(site.deletes.length, 0);

  // Same URL, new bytes (the site overwrote today's flyer): old one taken down, new one posted.
  site = makeSite({ [url]: bigBuffer('b') });
  state = await reload(config);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 1);
  assert.equal(site.posts.length, 1);
  assert.match(JSON.parse(site.posts[0].get('payload_json')).content, /New deals for/);
  assert.deepEqual(site.deletes, ['m1']);

  const saved = JSON.parse(await readFile(config.stateFile, 'utf8'));
  assert.equal(saved.seen.length, 1);
  assert.equal(saved.seen[0].messageId, 'm1');
  assert.equal(saved.seen[0].attachmentId, 'm1-a0');
  assert.equal(saved.initialized, true);
});

test('images that leave the page have their Discord message deleted', async () => {
  const config = await freshConfig();
  const a = 'https://flcannabisdeals.org/wp-content/uploads/a.jpg';
  const b = 'https://flcannabisdeals.org/wp-content/uploads/b.jpg';
  const c = 'https://flcannabisdeals.org/wp-content/uploads/c.jpg';

  // Day 1: a and b each get their own message.
  let site = makeSite({ [a]: bigBuffer('a'), [b]: bigBuffer('b') });
  let state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 2);
  assert.equal(site.posts.length, 2);
  assert.deepEqual(state.seen.map((e) => e.messageId), ['m1', 'm2']);

  // Day 2: b is gone, a stays. Only b's message is deleted.
  site = makeSite({ [a]: bigBuffer('a') });
  state = await reload(config);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 0);
  assert.equal(site.posts.length, 0);
  assert.equal(site.edits.length, 0);
  assert.deepEqual(site.deletes, ['m2']);
  assert.deepEqual(state.seen.map((e) => e.url), [a]);

  // Day 3: a is gone too and c is new.
  site = makeSite({ [c]: bigBuffer('c') });
  state = await reload(config);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 1);
  assert.deepEqual(site.deletes, ['m1']);
  assert.equal(site.posts.length, 1);
  assert.deepEqual(state.seen.map((e) => e.url), [c]);
});

test('nothing is removed when the page comes back with no images at all', async () => {
  const config = await freshConfig();
  const a = 'https://flcannabisdeals.org/wp-content/uploads/a.jpg';

  let site = makeSite({ [a]: bigBuffer('a') });
  let state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 1);

  site = makeSite({});
  state = await reload(config);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 0);
  assert.equal(site.deletes.length, 0);
  assert.equal(site.edits.length, 0);
  assert.equal(state.seen.length, 1);
});

test('a download failure does not count as the image being gone', async () => {
  const config = await freshConfig();
  const a = 'https://flcannabisdeals.org/wp-content/uploads/a.jpg';
  const b = 'https://flcannabisdeals.org/wp-content/uploads/b.jpg';

  let site = makeSite({ [a]: bigBuffer('a'), [b]: bigBuffer('b') });
  let state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 2);

  // b is still on the page but its download fails this time.
  const good = makeSite({ [a]: bigBuffer('a'), [b]: bigBuffer('b') });
  const flaky = {
    ...good,
    fetchImpl: async (url, init) => {
      if (url === b) return { ok: false, status: 503, headers: new Headers(), text: async () => 'down' };
      return good.fetchImpl(url, init);
    },
  };
  state = await reload(config);
  assert.equal(await checkOnce(config, state, { fetchImpl: flaky.fetchImpl }), 0);
  assert.equal(good.deletes.length, 0);
  assert.equal(good.edits.length, 0);
  assert.equal(state.seen.length, 2);
});

test('dry run reports removals and posts without touching Discord or state', async () => {
  const config = await freshConfig();
  const a = 'https://flcannabisdeals.org/wp-content/uploads/a.jpg';
  const b = 'https://flcannabisdeals.org/wp-content/uploads/b.jpg';

  let site = makeSite({ [a]: bigBuffer('a') });
  let state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 1);

  site = makeSite({ [b]: bigBuffer('b') });
  state = await reload(config);
  assert.equal(await checkOnce({ ...config, dryRun: true }, state, { fetchImpl: site.fetchImpl }), 0);
  assert.equal(site.posts.length, 0);
  assert.equal(site.deletes.length, 0);
  assert.deepEqual(state.seen.map((e) => e.url), [a]);
});

test('POST_ON_FIRST_RUN=false remembers existing images silently', async () => {
  const config = { ...(await freshConfig()), postOnFirstRun: false };
  const site = makeSite({ 'https://flcannabisdeals.org/wp-content/uploads/x.jpg': bigBuffer('x') });
  const state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 0);
  assert.equal(site.posts.length, 0);
  assert.equal(state.seen.length, 1);
});

test('images below MIN_IMAGE_BYTES are ignored', async () => {
  const config = await freshConfig();
  const site = makeSite({ 'https://flcannabisdeals.org/wp-content/uploads/tiny.jpg': Buffer.alloc(100, 1) });
  const state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 0);
  assert.equal(site.posts.length, 0);
});

test('every image gets its own message', async () => {
  const config = await freshConfig();
  const images = {};
  for (let i = 0; i < 12; i += 1) images[`https://flcannabisdeals.org/wp-content/uploads/d${i}.jpg`] = bigBuffer(String(i % 10)).fill(i);
  const site = makeSite(images);
  const state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 12);
  assert.equal(site.posts.length, 12);
  assert.equal(new Set(state.seen.map((e) => e.messageId)).size, 12);
  // Only the first message carries the run header.
  assert.match(JSON.parse(site.posts[0].get('payload_json')).content, /Current deals/);
  assert.doesNotMatch(JSON.parse(site.posts[1].get('payload_json')).content, /Current deals/);
});
