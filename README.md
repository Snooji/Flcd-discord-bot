# FLCD Discord Bot

Watches [flcannabisdeals.org/todays-florida-dispensary-deals](https://flcannabisdeals.org/todays-florida-dispensary-deals/)
and mirrors the daily deal images (the JPEG/PNG flyers on the page) into a Discord channel: new flyers are posted,
and flyers that drop off the page are removed again, so the channel always shows what is on the site right now.

How it works:

1. Every `POLL_INTERVAL_MINUTES` (default 120, i.e. every 2 hours) it fetches the page.
2. It pulls out every image in the main content area, following WordPress lazy-load
   attributes, `srcset`, `<picture>` sources and `<noscript>` fallbacks, and swaps
   resized copies (`-768x1024.jpg`) for the full-size file.
3. It downloads each image and hashes the bytes. Anything it has not posted before is
   uploaded to your channel, one message per flyer so Discord shows it full width, captioned with
   the dispensary heading / alt text.
   Because it compares bytes rather than filenames, it still notices when the site
   overwrites yesterday's flyer with today's under the same name.
4. Anything it posted earlier that is no longer on the page is taken back out of Discord by
   deleting its message.
   A failed download or a page that comes back with no images at all is treated as a glitch, not as
   "everything was removed", so a flaky fetch never wipes the channel.
5. What it has posted, and which Discord message each image lives in, is remembered in
   `data/state.json`, so restarts do not re-post.

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

**GitHub Actions (free, no server).** `.github/workflows/deals.yml` runs `npm run once` every 2 hours on
GitHub's machines and commits `data/state.json` back so the bot remembers what it posted. To turn it on:

1. Push this repo to GitHub (the workflow must be on the default branch).
2. In the repo: Settings -> Secrets and variables -> Actions -> New repository secret. Name it
   `DISCORD_WEBHOOK_URL` and paste your webhook URL.
3. Actions tab -> "Post daily deals" -> Run workflow, to do the first run by hand and check the log.

After that it runs on its own. GitHub may start scheduled runs a few minutes late, and it pauses schedules
on repos with no activity for 60 days, but the bot's own state commits count as activity. Do not also run
the bot on your PC at the same time; two copies would fight over the channel.

**Docker**

```bash
docker compose up -d --build
```

**systemd** (Linux server): copy `flcd-discord-bot.service` to `/etc/systemd/system/`, edit
`User` and `WorkingDirectory`, then `sudo systemctl enable --now flcd-discord-bot`.

**cron** (anything with Node): run `npm run once` on a schedule, for example every 2 hours:

```
0 */2 * * * cd /path/to/Flcd-discord-bot && /usr/bin/npm run --silent once >> bot.log 2>&1
```

## Tuning

All settings live in `.env` (see `.env.example` for the full list).

| Setting | What it does |
| --- | --- |
| `POLL_INTERVAL_MINUTES` | How often to check the page. 120 (every 2 hours) is plenty for a once-a-day update. |
| `CONTENT_SELECTOR` | Comma-separated CSS selectors, tried in order; only images inside the first match are considered. Defaults cover common WordPress layouts. Set it if the bot is picking up sidebar/ad images. |
| `EXCLUDE_PATTERN` | Regex; images whose URL or alt text matches are skipped (logos, icons, share buttons...). |
| `MIN_IMAGE_BYTES` | Images smaller than this are skipped. Raises the bar past icons and tracking pixels. |
| `POST_ON_FIRST_RUN` | Post the current page contents on the very first run, or just remember them. |
| `SKIP_OFFSITE_LINKS` | Skip images wrapped in a link to another website. Those are rotating sponsor banners, not deal flyers. |
| `PAGE_PROXY` | Empty fetches the page directly. `jina` fetches it through Jina's reader, for networks the site's Cloudflare protection blocks (see below). |
| `JINA_API_KEY` | Optional, raises Jina's rate limit. Not needed at a 2-hour cadence. |
| `LOG_LEVEL` | `debug` shows every image considered and why it was skipped. |

If the bot reports `Found 0 candidate image(s)`, run with `LOG_LEVEL=debug`, look at the page's HTML
and adjust `CONTENT_SELECTOR` / `EXCLUDE_PATTERN`. If the site ever starts returning HTTP 403 to the
bot, the page is behind a bot-blocking CDN and a headless-browser fetch would be needed.

## When the site blocks the bot's network

The site sits behind Cloudflare, which returns HTTP 403 to requests from datacenter networks such as
GitHub Actions runners (it serves home connections normally). Set `PAGE_PROXY=jina` and the bot fetches
the page HTML through Jina's reader at r.jina.ai, which renders it in a real browser, then downloads the
images directly (image files are not blocked). The GitHub Actions workflow already sets this. If Jina is
ever down the run fails and nothing in Discord is touched; the next scheduled run tries again.

## Notes on removal

Removal only works for images the bot posted itself, because it needs the Discord message ID it
recorded at post time. Images posted by an older version of the bot (before message tracking) or
with `POST_ON_FIRST_RUN=false` have no message to edit; when they leave the site the bot logs a
warning and forgets them, and you delete them in Discord by hand. To migrate an existing channel,
delete the old messages in Discord, delete `data/state.json`, and run `npm run once` so everything is
re-posted with tracking.

Webhooks can edit and delete their own messages, so no extra permission is needed. In bot-user mode
the bot only ever edits and deletes its own messages, so *Send Messages* and *Attach Files* remain enough.

## Development

```bash
npm test
```

Tests exercise the HTML extraction against a fixture that mimics WordPress markup, plus the full
check-post-remember loop against a mocked site and Discord.
