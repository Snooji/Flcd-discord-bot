# FLCD Discord Bot

Watches [flcannabisdeals.org/todays-florida-dispensary-deals](https://flcannabisdeals.org/todays-florida-dispensary-deals/)
and forwards the daily deal images (the JPEG/PNG flyers on the page) to a Discord channel whenever they change.

How it works:

1. Every `POLL_INTERVAL_MINUTES` (default 15) it fetches the page.
2. It pulls out every image in the main content area, following WordPress lazy-load
   attributes, `srcset`, `<picture>` sources and `<noscript>` fallbacks, and swaps
   resized copies (`-768x1024.jpg`) for the full-size file.
3. It downloads each image and hashes the bytes. Anything it has not posted before is
   uploaded to your channel as an attachment, labelled with the dispensary heading / alt text.
   Because it compares bytes rather than filenames, it still notices when the site
   overwrites yesterday's flyer with today's under the same name.
4. What it has posted is remembered in `data/state.json`, so restarts do not re-post.

## Setup

Requires Node 20 or newer.

```bash
git clone <this repo>
cd Flcd-discord-bot
npm install
cp .env.example .env
```

Edit `.env` and pick one way to deliver to Discord:

- **Webhook (easiest).** In Discord: channel settings -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL.
  Put it in `DISCORD_WEBHOOK_URL`.
- **Bot user.** Create an application at <https://discord.com/developers/applications>, add a Bot, copy its token
  into `DISCORD_BOT_TOKEN`. Invite it to your server with the *Send Messages* and *Attach Files* permissions.
  Turn on Developer Mode in Discord (Settings -> Advanced), right-click the channel -> Copy Channel ID,
  and put that in `DISCORD_CHANNEL_ID`.

Then:

```bash
npm run dry-run   # fetch the page once and print what it WOULD post, without touching Discord
npm run once      # one real check + post, then exit (good for cron)
npm start         # run forever, checking every POLL_INTERVAL_MINUTES
```

On the first real run it posts everything currently on the page. Set `POST_ON_FIRST_RUN=false`
if you would rather it silently remember the current images and only post future changes.

## Running it permanently

Pick whichever you prefer.

**Docker**

```bash
docker compose up -d --build
```

**systemd** (Linux server): copy `flcd-discord-bot.service` to `/etc/systemd/system/`, edit
`User` and `WorkingDirectory`, then `sudo systemctl enable --now flcd-discord-bot`.

**cron** (anything with Node): run `npm run once` on a schedule, for example every 15 minutes:

```
*/15 * * * * cd /path/to/Flcd-discord-bot && /usr/bin/npm run --silent once >> bot.log 2>&1
```

## Tuning

All settings live in `.env` (see `.env.example` for the full list).

| Setting | What it does |
| --- | --- |
| `POLL_INTERVAL_MINUTES` | How often to check the page. 15 is plenty for a once-a-day update. |
| `CONTENT_SELECTOR` | Comma-separated CSS selectors, tried in order; only images inside the first match are considered. Defaults cover common WordPress layouts. Set it if the bot is picking up sidebar/ad images. |
| `EXCLUDE_PATTERN` | Regex; images whose URL or alt text matches are skipped (logos, icons, share buttons...). |
| `MIN_IMAGE_BYTES` | Images smaller than this are skipped. Raises the bar past icons and tracking pixels. |
| `POST_ON_FIRST_RUN` | Post the current page contents on the very first run, or just remember them. |
| `LOG_LEVEL` | `debug` shows every image considered and why it was skipped. |

If the bot reports `Found 0 candidate image(s)`, run with `LOG_LEVEL=debug`, look at the page's HTML
and adjust `CONTENT_SELECTOR` / `EXCLUDE_PATTERN`. If the site ever starts returning HTTP 403 to the
bot, the page is behind a bot-blocking CDN and a headless-browser fetch would be needed.

## Development

```bash
npm test
```

Tests exercise the HTML extraction against a fixture that mimics WordPress markup, plus the full
check-post-remember loop against a mocked site and Discord.
