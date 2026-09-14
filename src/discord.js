import { log } from './log.js';

const DISCORD_API = 'https://discord.com/api/v10';
// One flyer per message: Discord shows a lone attachment at full width, but shrinks
// several attachments in one message into small tiles that cannot be read.
const MAX_FILES_PER_MESSAGE = 1;
// Discord's default upload cap for non-boosted servers.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function requestWithRetry(url, init, { fetchImpl = fetch, attempts = 5, okStatuses = [] } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await fetchImpl(url, init);
    if (res.ok || okStatuses.includes(res.status)) return res;

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

function authHeaders(config) {
  const { webhookUrl, botToken } = config.discord;
  return webhookUrl ? {} : { Authorization: `Bot ${botToken}` };
}

function createEndpoint(config) {
  const { webhookUrl, channelId } = config.discord;
  if (webhookUrl) return `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`;
  return `${DISCORD_API}/channels/${channelId}/messages`;
}

function messageEndpoint(config, messageId) {
  const { webhookUrl, channelId } = config.discord;
  // Webhooks may edit and delete their own messages at <webhook url>/messages/<id>.
  if (webhookUrl) return `${webhookUrl.replace(/\?.*$/, '')}/messages/${messageId}`;
  return `${DISCORD_API}/channels/${channelId}/messages/${messageId}`;
}

// Discord identifies attachments in its response by filename, so make sure no two
// files in one message share a name.
function uniqueFilenames(batch) {
  const used = new Set();
  return batch.map((img) => {
    let name = img.filename;
    for (let i = 2; used.has(name); i += 1) {
      name = img.filename.replace(/(\.[a-z0-9]{3,4})?$/i, `-${i}$1`);
    }
    used.add(name);
    return { ...img, filename: name };
  });
}

/**
 * Post images to Discord as file attachments, one message per image, captioned with
 * the heading / alt text found next to it on the page.
 * images: [{ buffer, filename, contentType, alt, heading, url, hash }]
 * Returns [{ hash, url, messageId, attachmentId }] so the caller can later remove
 * individual images again.
 */
export async function postImages({ config, images, content, fetchImpl = fetch }) {
  const usable = [];
  for (const img of images) {
    if (img.buffer.length > MAX_FILE_BYTES) {
      log.warn(`Skipping ${img.filename}: ${img.buffer.length} bytes exceeds Discord's upload limit; posting link instead`);
      usable.push({ ...img, linkOnly: true });
    } else {
      usable.push(img);
    }
  }

  const results = [];
  const batches = chunk(usable, MAX_FILES_PER_MESSAGE);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = uniqueFilenames(batches[i]);
    const form = new FormData();

    const lines = [];
    if (i === 0 && content) lines.push(content);
    for (const img of batch) {
      const caption = [img.heading, img.alt].filter(Boolean).join(" - ");
      if (caption) lines.push(caption);
    }
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

    const res = await requestWithRetry(
      createEndpoint(config),
      { method: 'POST', headers: authHeaders(config), body: form },
      { fetchImpl },
    );

    let message = null;
    try {
      message = await res.json();
    } catch {
      message = null;
    }
    const attachmentIdByName = new Map((message?.attachments ?? []).map((a) => [a.filename, String(a.id)]));
    if (!message?.id) log.warn('Discord did not return a message id; these images cannot be removed automatically later');

    for (const img of batch) {
      results.push({
        hash: img.hash,
        url: img.url,
        messageId: message?.id ? String(message.id) : null,
        attachmentId: img.linkOnly ? null : (attachmentIdByName.get(img.filename) ?? null),
      });
    }
    log.info(`Posted ${attachments.length} image(s) to Discord (batch ${i + 1}/${batches.length})`);
  }
  return results;
}

/**
 * Take images that are no longer on the site out of Discord.
 * stale: state entries to remove. keep: state entries that remain current.
 * A message loses just the outdated attachments, or is deleted outright once
 * nothing current is left in it.
 */
export async function removeImages({ config, stale, keep, fetchImpl = fetch }) {
  const headers = authHeaders(config);

  const byMessage = new Map();
  for (const entry of stale) {
    if (!entry.messageId) {
      log.warn(`Cannot remove ${entry.url} from Discord automatically (posted before message tracking); delete it by hand`);
      continue;
    }
    if (!byMessage.has(entry.messageId)) byMessage.set(entry.messageId, []);
    byMessage.get(entry.messageId).push(entry);
  }

  for (const [messageId, entries] of byMessage) {
    const remaining = keep.filter((e) => e.messageId === messageId);
    const url = messageEndpoint(config, messageId);

    if (remaining.length === 0) {
      const res = await requestWithRetry(url, { method: 'DELETE', headers }, { fetchImpl, okStatuses: [404] });
      log.info(`Deleted Discord message holding ${entries.length} outdated image(s)${res.status === 404 ? ' (already gone)' : ''}`);
      continue;
    }

    if (remaining.some((e) => !e.attachmentId)) {
      log.warn(`Leaving message ${messageId} untouched: cannot tell its current attachments apart. Remove the outdated image(s) by hand.`);
      continue;
    }

    const body = JSON.stringify({ attachments: remaining.map((e) => ({ id: e.attachmentId })) });
    const res = await requestWithRetry(
      url,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body },
      { fetchImpl, okStatuses: [404] },
    );
    if (res.status === 404) {
      log.warn(`Message ${messageId} no longer exists in Discord; forgetting its images`);
    } else {
      log.info(`Removed ${entries.length} outdated image(s) from a Discord message (${remaining.length} still current)`);
    }
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
