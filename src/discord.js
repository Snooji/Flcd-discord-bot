import { log } from './log.js';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_FILES_PER_MESSAGE = 10;
// Discord's default upload cap for non-boosted servers.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postWithRetry(url, init, { fetchImpl = fetch, attempts = 5 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await fetchImpl(url, init);
    if (res.ok) return res;

    if (res.status === 429) {
      let wait = 2000;
      try {
        const body = await res.json();
        if (body.retry_after) wait = Math.ceil(body.retry_after * 1000) + 250;
      } catch {
        /* use default */
      }
      log.warn(`Discord rate limited; waiting ${wait}ms (attempt ${attempt}/${attempts})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (res.status >= 500 && attempt < attempts) {
      const wait = 1000 * 2 ** attempt;
      log.warn(`Discord returned ${res.status}; retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    const text = await res.text().catch(() => '');
    throw new Error(`Discord request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  throw new Error('Discord request failed after retries');
}

/**
 * Post images to Discord as file attachments, in batches of up to 10 per message.
 * images: [{ buffer, filename, contentType, alt, heading, url }]
 */
export async function postImages({ config, images, content, fetchImpl = fetch }) {
  const { webhookUrl, botToken, channelId } = config.discord;

  const usable = [];
  for (const img of images) {
    if (img.buffer.length > MAX_FILE_BYTES) {
      log.warn(`Skipping ${img.filename}: ${img.buffer.length} bytes exceeds Discord's upload limit; posting link instead`);
      usable.push({ ...img, linkOnly: true });
    } else {
      usable.push(img);
    }
  }

  const batches = chunk(usable, MAX_FILES_PER_MESSAGE);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const form = new FormData();

    const lines = [];
    if (i === 0 && content) lines.push(content);
    const links = batch.filter((b) => b.linkOnly).map((b) => b.url);
    if (links.length) lines.push(...links);

    const attachments = [];
    batch
      .filter((b) => !b.linkOnly)
      .forEach((img, idx) => {
        const description = [img.heading, img.alt].filter(Boolean).join(' - ').slice(0, 1024);
        attachments.push({ id: idx, filename: img.filename, ...(description ? { description } : {}) });
        form.append(`files[${idx}]`, new Blob([img.buffer], { type: img.contentType || 'application/octet-stream' }), img.filename);
      });

    const payload = {
      content: lines.join('\n').slice(0, 2000),
      attachments,
      allowed_mentions: { parse: [] },
    };
    form.append('payload_json', JSON.stringify(payload));

    let url;
    const headers = {};
    if (webhookUrl) {
      url = `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`;
    } else {
      url = `${DISCORD_API}/channels/${channelId}/messages`;
      headers.Authorization = `Bot ${botToken}`;
    }

    await postWithRetry(url, { method: 'POST', headers, body: form }, { fetchImpl });
    log.info(`Posted ${attachments.length} image(s) to Discord (batch ${i + 1}/${batches.length})`);
  }
}

/** Quick connectivity check so misconfiguration shows up at startup instead of on the first deal. */
export async function verifyDestination(config, { fetchImpl = fetch } = {}) {
  const { webhookUrl, botToken, channelId } = config.discord;
  if (webhookUrl) {
    const res = await fetchImpl(webhookUrl, { headers: { 'User-Agent': 'flcd-discord-bot' } });
    if (!res.ok) throw new Error(`Webhook check failed: HTTP ${res.status}. Is DISCORD_WEBHOOK_URL correct?`);
    const info = await res.json();
    return `webhook "${info.name}" in channel ${info.channel_id}`;
  }
  const res = await fetchImpl(`${DISCORD_API}/channels/${channelId}`, {
    headers: { Authorization: `Bot ${botToken}`, 'User-Agent': 'flcd-discord-bot' },
  });
  if (!res.ok) {
    throw new Error(
      `Bot check failed: HTTP ${res.status}. Check DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, and that the bot is in the server with access to the channel.`,
    );
  }
  const info = await res.json();
  return `bot posting to #${info.name ?? channelId}`;
}
