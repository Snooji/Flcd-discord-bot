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

function makeSite(images) {
  // images: { [url]: Buffer }
  const html = `<html><body><div class="entry-content"><h2>Deals</h2>${Object.keys(images)
    .map((u) => `<img src="${u}" alt="deal">`)
    .join('')}</div></body></html>`;
  const posts = [];
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
    if (url.startsWith('https://discord.com/api/webhooks/')) {
      posts.push(init.body);
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, posts };
}

function bigBuffer(seed) {
  return Buffer.alloc(20000, seed);
}

async function freshConfig() {
  const dir = await mkdtemp(path.join(tmpdir(), 'flcd-'));
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/abc';
  process.env.STATE_FILE = path.join(dir, 'state.json');
  return loadConfig([]);
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

  // Same bytes again: nothing posted. (Use a fresh fetch so the ETag short-circuit is not what stops it.)
  state = await loadState(config.stateFile);
  state.etag = null;
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 0);
  assert.equal(site.posts.length, 1);

  // Same URL, new bytes (the site overwrote today's flyer): posted again.
  site = makeSite({ [url]: bigBuffer('b') });
  state = await loadState(config.stateFile);
  state.etag = null;
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 1);
  assert.equal(site.posts.length, 1);
  assert.match(JSON.parse(site.posts[0].get('payload_json')).content, /New deals for/);

  const saved = JSON.parse(await readFile(config.stateFile, 'utf8'));
  assert.equal(saved.seen.length, 2);
  assert.equal(saved.initialized, true);
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

test('more than ten images are split across messages', async () => {
  const config = await freshConfig();
  const images = {};
  for (let i = 0; i < 12; i += 1) images[`https://flcannabisdeals.org/wp-content/uploads/d${i}.jpg`] = bigBuffer(String(i % 10)).fill(i);
  const site = makeSite(images);
  const state = await loadState(config.stateFile);
  assert.equal(await checkOnce(config, state, { fetchImpl: site.fetchImpl }), 12);
  assert.equal(site.posts.length, 2);
});
