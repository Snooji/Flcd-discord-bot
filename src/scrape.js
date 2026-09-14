import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)(?=($|[?#]))/i;
const LAZY_SRC_ATTRS = [
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-full-url',
  'data-large_image',
  'data-orig-file',
  'data-image',
  'data-bg',
  'src',
];
const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'srcset'];

const JINA_READER = 'https://r.jina.ai/';

function looksLikeChallenge(html) {
  return /<title>\s*Just a moment/i.test(html) || /Attention Required!\s*\|\s*Cloudflare/i.test(html);
}

/**
 * Fetch the page through Jina's reader (r.jina.ai), for sites whose Cloudflare
 * settings reject datacenter IPs such as GitHub Actions runners. Jina renders the
 * page in a real browser. Asking for markdown with X-No-Cache forces a fresh render;
 * the HTML of that render is then available from Jina's cache, and that is what
 * we parse, so the normal extractor works unchanged.
 */
async function fetchPageViaJina(url, { fetchImpl, proxyToken }) {
  const auth = proxyToken ? { Authorization: `Bearer ${proxyToken}` } : {};
  const fresh = await fetchImpl(JINA_READER + url, { headers: { ...auth, 'X-No-Cache': 'true' } });
  if (!fresh.ok) throw new Error(`Fetching ${url} via Jina reader failed: HTTP ${fresh.status}`);
  await fresh.text().catch(() => '');

  const res = await fetchImpl(JINA_READER + url, { headers: { ...auth, 'X-Return-Format': 'html' } });
  if (!res.ok) throw new Error(`Fetching ${url} HTML via Jina reader failed: HTTP ${res.status}`);
  const html = await res.text();
  if (looksLikeChallenge(html)) {
    throw new Error(`Jina reader returned a Cloudflare challenge page for ${url} instead of the content`);
  }
  return { status: 'ok', html, etag: null, lastModified: null };
}

/**
 * Fetch the deals page HTML. Uses ETag / Last-Modified when available so an
 * unchanged page costs almost nothing.
 * Returns { status: 'unchanged' } or { status: 'ok', html, etag, lastModified }.
 */
export async function fetchPage(url, { etag, lastModified, fetchImpl = fetch, proxy = '', proxyToken = '' } = {}) {
  if (proxy === 'jina') return fetchPageViaJina(url, { fetchImpl, proxyToken });

  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  const res = await fetchImpl(url, { headers, redirect: 'follow' });
  if (res.status === 304) return { status: 'unchanged' };
  if (!res.ok) throw new Error(`Fetching ${url} failed: HTTP ${res.status}`);

  return {
    status: 'ok',
    html: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/** Pick the largest candidate from a srcset string. */
export function largestFromSrcset(srcset) {
  if (!srcset) return null;
  let best = null;
  for (const part of srcset.split(',')) {
    const [urlPart, descriptor] = part.trim().split(/\s+/);
    if (!urlPart) continue;
    const size = descriptor ? parseFloat(descriptor) || 0 : 0;
    if (!best || size > best.size) best = { url: urlPart, size };
  }
  return best?.url ?? null;
}

/**
 * WordPress writes resized copies as name-300x200.jpg next to the original.
 * Strip that suffix so we always look at the full-size file (and so two sizes
 * of the same picture don't count as two deals).
 */
export function stripWpSizeSuffix(url) {
  return url.replace(/-\d{2,5}x\d{2,5}(\.(jpe?g|png|webp|gif|avif))(?=($|[?#]))/i, '$1');
}

function isImageUrl(url) {
  if (!url) return false;
  if (url.startsWith('data:')) return false;
  return IMAGE_EXT.test(url);
}

function resolve(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

function nearestHeading($, el) {
  // Walk up and back through previous siblings to find a heading that labels this image.
  let node = $(el);
  for (let depth = 0; depth < 6 && node.length; depth += 1) {
    const prev = node.prevAll('h1,h2,h3,h4,h5,h6').first();
    if (prev.length) return prev.text().trim();
    const inner = node.find('h1,h2,h3,h4,h5,h6').first();
    if (inner.length && depth > 0) return inner.text().trim();
    node = node.parent();
  }
  return '';
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// An image wrapped in a link to another website is a sponsor banner, not a deal flyer.
function linksOffSite($, el, baseUrl) {
  const href = $(el).closest('a').attr('href');
  if (!href) return false;
  const target = resolve(baseUrl, href);
  const pageHost = hostOf(baseUrl);
  const targetHost = hostOf(target);
  return Boolean(pageHost && targetHost && targetHost !== pageHost);
}

function candidateUrlsForImg($, img, base) {
  const urls = [];
  for (const attr of LAZY_SRCSET_ATTRS) {
    const best = largestFromSrcset($(img).attr(attr));
    if (best) urls.push(best);
  }
  for (const attr of LAZY_SRC_ATTRS) {
    const v = $(img).attr(attr);
    if (v) urls.push(v);
  }
  // <picture><source srcset> siblings
  $(img)
    .closest('picture')
    .find('source')
    .each((_, s) => {
      for (const attr of LAZY_SRCSET_ATTRS) {
        const best = largestFromSrcset($(s).attr(attr));
        if (best) urls.push(best);
      }
    });
  // If the image is a link to a bigger version of itself, prefer that.
  const href = $(img).closest('a').attr('href');
  if (href && isImageUrl(href)) urls.unshift(href);

  return urls.map((u) => resolve(base, u)).filter(isImageUrl);
}

/**
 * Extract deal-image candidates from page HTML.
 * Returns [{ url, alt, heading }] de-duplicated by URL, in page order.
 */
export function extractImages(html, { baseUrl, contentSelectors = ['body'], excludePattern = null, skipOffsiteLinks = true } = {}) {
  const $ = cheerio.load(html);

  // WordPress lazy-load plugins keep a plain <img> inside <noscript>; unwrap it so it is parsed.
  $('noscript').each((_, n) => {
    const inner = $(n).html();
    if (inner && /<img/i.test(inner)) $(n).replaceWith(inner);
  });

  let scope = null;
  for (const sel of contentSelectors) {
    const found = $(sel).filter((_, el) => $(el).find('img').length > 0);
    if (found.length) {
      scope = found;
      break;
    }
  }
  if (!scope) scope = $('body');

  const seen = new Set();
  const results = [];

  scope.find('img').each((_, img) => {
    const alt = ($(img).attr('alt') || '').trim();
    const width = parseInt($(img).attr('width') || '0', 10);
    const height = parseInt($(img).attr('height') || '0', 10);
    // Tiny declared dimensions are icons/spacers, not deal flyers.
    if ((width && width < 100) || (height && height < 100)) return;
    if (skipOffsiteLinks && linksOffSite($, img, baseUrl)) return;

    const candidates = candidateUrlsForImg($, img, baseUrl);
    if (!candidates.length) return;

    const url = stripWpSizeSuffix(candidates[0]);
    if (seen.has(url)) return;
    if (excludePattern && (excludePattern.test(url) || excludePattern.test(alt))) return;

    seen.add(url);
    results.push({ url, alt, heading: nearestHeading($, img) });
  });

  // Also catch CSS background images inside the content scope (some builders use them for flyers).
  scope.find('[style*="background"]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
    if (!m) return;
    const abs = resolve(baseUrl, m[2]);
    if (!isImageUrl(abs)) return;
    const url = stripWpSizeSuffix(abs);
    if (seen.has(url)) return;
    if (excludePattern && excludePattern.test(url)) return;
    seen.add(url);
    results.push({ url, alt: '', heading: nearestHeading($, el) });
  });

  return results;
}

/** Download an image and hash its bytes so re-uploaded files with the same name are still detected. */
export async function downloadImage(url, { fetchImpl = fetch, referer } = {}) {
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Downloading ${url} failed: HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(buffer).digest('hex');
  return { buffer, hash, contentType };
}

export function filenameFor(url, contentType) {
  let name = 'deal';
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) name = decodeURIComponent(last);
  } catch {
    /* keep default */
  }
  if (!/\.[a-z0-9]{3,4}$/i.test(name)) {
    const ext = contentType.includes('png')
      ? 'png'
      : contentType.includes('webp')
        ? 'webp'
        : contentType.includes('gif')
          ? 'gif'
          : 'jpg';
    name = `${name}.${ext}`;
  }
  return name.replace(/[^\w.-]+/g, '_');
}
