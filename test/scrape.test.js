import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractImages, stripWpSizeSuffix, largestFromSrcset, filenameFor, fetchPage, downloadImage } from '../src/scrape.js';
import { loadConfig } from '../src/config.js';

const BASE = 'https://flcannabisdeals.org/todays-florida-dispensary-deals/';
const html = await readFile(new URL('./fixtures/deals.html', import.meta.url), 'utf8');
const config = loadConfig([]);

test('extractImages finds full-size deal images and ignores chrome/icons', () => {
  const found = extractImages(html, {
    baseUrl: BASE,
    contentSelectors: config.contentSelectors,
    excludePattern: config.excludePattern,
  });
  const urls = found.map((f) => f.url);

  assert.deepEqual(urls, [
    'https://flcannabisdeals.org/wp-content/uploads/2026/09/trulieve-deals.jpg',
    'https://flcannabisdeals.org/wp-content/uploads/2026/09/curaleaf.png',
    'https://flcannabisdeals.org/wp-content/uploads/2026/09/muv-deals.jpeg',
    'https://flcannabisdeals.org/wp-content/uploads/2026/09/fluent.jpg',
    'https://flcannabisdeals.org/wp-content/uploads/2026/09/sunnyside-bg.jpg',
  ]);
});

test('extractImages attaches alt text and the nearest heading', () => {
  const found = extractImages(html, { baseUrl: BASE, contentSelectors: config.contentSelectors, excludePattern: config.excludePattern });
  const byUrl = Object.fromEntries(found.map((f) => [f.url, f]));
  assert.equal(byUrl['https://flcannabisdeals.org/wp-content/uploads/2026/09/trulieve-deals.jpg'].heading, 'Trulieve');
  assert.equal(byUrl['https://flcannabisdeals.org/wp-content/uploads/2026/09/trulieve-deals.jpg'].alt, 'Trulieve daily deals');
  assert.equal(byUrl['https://flcannabisdeals.org/wp-content/uploads/2026/09/muv-deals.jpeg'].heading, 'MUV');
  assert.equal(byUrl['https://flcannabisdeals.org/wp-content/uploads/2026/09/fluent.jpg'].heading, 'Fluent');
});

test('extractImages falls back to body when no selector matches', () => {
  const found = extractImages('<div><img src="/a/pic.jpg"></div>', { baseUrl: BASE, contentSelectors: ['.nope'] });
  assert.deepEqual(found.map((f) => f.url), ['https://flcannabisdeals.org/a/pic.jpg']);
});

test('stripWpSizeSuffix removes WordPress resize suffixes only', () => {
  assert.equal(stripWpSizeSuffix('https://x.org/u/a-768x1024.jpg'), 'https://x.org/u/a.jpg');
  assert.equal(stripWpSizeSuffix('https://x.org/u/a-768x1024.jpg?v=2'), 'https://x.org/u/a.jpg?v=2');
  assert.equal(stripWpSizeSuffix('https://x.org/u/deals-2026-09-14.png'), 'https://x.org/u/deals-2026-09-14.png');
  assert.equal(stripWpSizeSuffix('https://x.org/u/4x4.png'), 'https://x.org/u/4x4.png');
});

test('largestFromSrcset picks the widest candidate', () => {
  assert.equal(largestFromSrcset('a.jpg 300w, b.jpg 1024w, c.jpg 768w'), 'b.jpg');
  assert.equal(largestFromSrcset('a.jpg 1x, b.jpg 2x'), 'b.jpg');
  assert.equal(largestFromSrcset(''), null);
});

test('filenameFor derives a safe filename', () => {
  assert.equal(filenameFor('https://x.org/u/Trulieve%20Deals.jpg?x=1', 'image/jpeg'), 'Trulieve_Deals.jpg');
  assert.equal(filenameFor('https://x.org/image', 'image/png'), 'image.png');
});

test('fetchPage sends conditional headers and honours 304', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = init.headers;
    return { status: 304, ok: false, headers: new Headers() };
  };
  const res = await fetchPage(BASE, { etag: '"abc"', lastModified: 'Mon', fetchImpl });
  assert.equal(res.status, 'unchanged');
  assert.equal(captured['If-None-Match'], '"abc"');
  assert.equal(captured['If-Modified-Since'], 'Mon');
});

test('downloadImage hashes the bytes', async () => {
  const bytes = Buffer.from('hello');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/jpeg' }),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const res = await downloadImage('https://x.org/a.jpg', { fetchImpl });
  assert.equal(res.hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(res.contentType, 'image/jpeg');
});

test('extractImages skips images that link out to another website', () => {
  const doc = `
    <div class="entry-content">
      <a href="https://www.trulieve.com/"><img src="/wp-content/uploads/2026/09/sponsor.jpg" alt="Trulieve"></a>
      <a href="https://flcannabisdeals.org/wp-content/uploads/2026/09/flyer.jpg"><img src="/wp-content/uploads/2026/09/flyer.jpg" alt="flyer"></a>
      <a href="/some-page/"><img src="/wp-content/uploads/2026/09/internal.jpg" alt="internal"></a>
      <img src="/wp-content/uploads/2026/09/bare.jpg" alt="bare">
    </div>`;
  const found = extractImages(doc, { baseUrl: BASE, contentSelectors: ['.entry-content'] });
  assert.deepEqual(found.map((f) => f.url.split('/').pop()), ['flyer.jpg', 'internal.jpg', 'bare.jpg']);

  const kept = extractImages(doc, { baseUrl: BASE, contentSelectors: ['.entry-content'], skipOffsiteLinks: false });
  assert.equal(kept.length, 4);
});

test('fetchPage via Jina forces a fresh render, then reads the HTML of it', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const html = init.headers['X-Return-Format'] === 'html';
    return { ok: true, status: 200, text: async () => (html ? '<html><body><img src="/x.jpg"></body></html>' : 'Title: page') };
  };
  const res = await fetchPage(BASE, { etag: '"abc"', fetchImpl, proxy: 'jina', proxyToken: 'tok' });
  assert.equal(res.status, 'ok');
  assert.match(res.html, /x\.jpg/);
  assert.equal(res.etag, null);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://r.jina.ai/${BASE}`);
  assert.equal(calls[0].headers['X-No-Cache'], 'true');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].headers['X-Return-Format'], 'html');
  assert.equal(calls[1].headers['If-None-Match'], undefined);
});

test('fetchPage via Jina rejects a Cloudflare challenge page', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html><head><title>Just a moment...</title></head></html>' });
  await assert.rejects(fetchPage(BASE, { fetchImpl, proxy: 'jina' }), /challenge page/);
});
