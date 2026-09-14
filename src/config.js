import 'dotenv/config';

const DEFAULT_CONTENT_SELECTORS = [
  '.entry-content',
  '.elementor-widget-container',
  'article',
  'main',
  '#content',
  '#primary',
  'body',
];

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(argv = process.argv.slice(2)) {
  const env = process.env;

  const webhookUrl = env.DISCORD_WEBHOOK_URL?.trim() || '';
  const botToken = env.DISCORD_BOT_TOKEN?.trim() || '';
  const channelId = env.DISCORD_CHANNEL_ID?.trim() || '';

  const contentSelectors = env.CONTENT_SELECTOR?.trim()
    ? env.CONTENT_SELECTOR.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CONTENT_SELECTORS;

  const excludeRaw =
    env.EXCLUDE_PATTERN ??
    'logo|icon|avatar|emoji|gravatar|favicon|spinner|placeholder|badge|button|wp-includes|/plugins/|/themes/';

  return {
    dealsUrl: env.DEALS_URL?.trim() || 'https://flcannabisdeals.org/todays-florida-dispensary-deals/',
    pollIntervalMs: num(env.POLL_INTERVAL_MINUTES, 15) * 60 * 1000,
    stateFile: env.STATE_FILE?.trim() || './data/state.json',
    contentSelectors,
    excludePattern: excludeRaw ? new RegExp(excludeRaw, 'i') : null,
    minImageBytes: num(env.MIN_IMAGE_BYTES, 15000),
    postOnFirstRun: bool(env.POST_ON_FIRST_RUN, true),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    discord: { webhookUrl, botToken, channelId },
    once: argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),
  };
}

export function validateConfig(config) {
  const { webhookUrl, botToken, channelId } = config.discord;
  if (config.dryRun) return;
  if (webhookUrl) return;
  if (botToken && channelId) return;
  throw new Error(
    'No Discord destination configured. Set DISCORD_WEBHOOK_URL, or both DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID (see .env.example).',
  );
}
