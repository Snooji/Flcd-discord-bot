import { loadConfig, validateConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { loadState, saveState, hasSeen, markSeen } from './state.js';
import { fetchPage, extractImages, downloadImage, filenameFor } from './scrape.js';
import { postImages, verifyDestination } from './discord.js';

function todayLabel() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

/**
 * One check: fetch page, find images, download + hash them, post the ones we
 * have not posted before, and persist state. Returns the number posted.
 */
export async function checkOnce(config, state, { fetchImpl = fetch } = {}) {
  log.debug(`Fetching ${config.dealsUrl}`);
  const page = await fetchPage(config.dealsUrl, {
    etag: state.etag,
    lastModified: state.lastModified,
    fetchImpl,
  });

  if (page.status === 'unchanged') {
    log.info('Page unchanged since last check (HTTP 304)');
    state.lastCheck = new Date().toISOString();
    await saveState(config.stateFile, state);
    return 0;
  }

  const found = extractImages(page.html, {
    baseUrl: config.dealsUrl,
    contentSelectors: config.contentSelectors,
    excludePattern: config.excludePattern,
  });
  log.info(`Found ${found.length} candidate image(s) on the page`);
  if (found.length === 0) {
    log.warn('No images found. If the page really has deal images, adjust CONTENT_SELECTOR / EXCLUDE_PATTERN or check the page is not blocking the bot.');
  }

  const fresh = [];
  for (const item of found) {
    let file;
    try {
      file = await downloadImage(item.url, { fetchImpl, referer: config.dealsUrl });
    } catch (err) {
      log.warn(`Could not download ${item.url}: ${err.message}`);
      continue;
    }
    if (file.buffer.length < config.minImageBytes) {
      log.debug(`Skipping ${item.url} (${file.buffer.length} bytes < MIN_IMAGE_BYTES)`);
      continue;
    }
    if (hasSeen(state, file.hash)) {
      log.debug(`Already posted: ${item.url}`);
      continue;
    }
    fresh.push({
      ...item,
      ...file,
      filename: filenameFor(item.url, file.contentType),
    });
  }

  const firstRun = !state.initialized;
  const shouldPost = fresh.length > 0 && (!firstRun || config.postOnFirstRun);

  if (fresh.length === 0) {
    log.info('No new deal images');
  } else if (!shouldPost) {
    log.info(`First run: remembering ${fresh.length} existing image(s) without posting (POST_ON_FIRST_RUN=false)`);
  } else if (config.dryRun) {
    log.info(`[dry-run] Would post ${fresh.length} new image(s):`);
    for (const f of fresh) log.info(`  - ${f.url}${f.heading ? `  [${f.heading}]` : ''}${f.alt ? `  (${f.alt})` : ''}`);
  } else {
    const header = firstRun
      ? `**Current deals** - <${config.dealsUrl}>`
      : `**New deals for ${todayLabel()}** - <${config.dealsUrl}>`;
    await postImages({ config, images: fresh, content: header, fetchImpl });
  }

  if (!config.dryRun) {
    for (const f of fresh) markSeen(state, { hash: f.hash, url: f.url, alt: f.alt, heading: f.heading });
    state.initialized = true;
    state.etag = page.etag;
    state.lastModified = page.lastModified;
    state.lastCheck = new Date().toISOString();
    await saveState(config.stateFile, state);
  }

  return shouldPost && !config.dryRun ? fresh.length : 0;
}

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  validateConfig(config);

  if (!config.dryRun) {
    const where = await verifyDestination(config);
    log.info(`Discord OK: ${where}`);
  }

  const state = await loadState(config.stateFile);
  log.info(`Watching ${config.dealsUrl} (state: ${config.stateFile}, ${state.seen.length} image(s) remembered)`);

  if (config.once) {
    await checkOnce(config, state);
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
    log.info('Shutting down');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (running) {
    try {
      await checkOnce(config, state);
    } catch (err) {
      log.error(`Check failed: ${err.message}`);
    }
    log.debug(`Next check in ${config.pollIntervalMs / 60000} minute(s)`);
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    log.error(err.stack || err.message);
    process.exit(1);
  });
}
