# Telegram Task Bot (Cloudflare Workers + D1, free tier)

Tracks tasks per Telegram chat (any group, supergroup, or DM). Everything is
scoped by Telegram's `chat_id`, so this works for unlimited groups/users
automatically — no per-group setup needed.

## Commands

### Simple tasks
| Command | What it does |
|---|---|
| `/start` | Registers the chat, shows help |
| `/addtask <text>` | Adds one task |
| `/addtasks` | Add many tasks at once — put one per line after the command |
| `/header <text>` | Sets a header shown above `/status` (no args = shows current) |
| `/footer <text>` | Sets a footer shown below `/status` (no args = shows current) |

### Reading plan (rotating multi-day roster)
| Command | What it does |
|---|---|
| `/newplan` | Create/replace the chat's plan — multi-line, see below |
| `/addreader <name> [position]` | Add someone to the rotation — at the end, or at a specific 1-based position |
| `/setposition <name> <position>` | Move an existing reader to a new position |
| `/removereader <name>` | Remove someone from the rotation |
| `/readers` | List the current rotation order |
| `/setincrement <n>` | Change chapters-per-reader-per-day (applies from next day on) |
| `/nextday` | Start Day 1, or force-advance to the next day |
| `/endplan` | Mark the plan finished early |

### Shared
| Command | What it does |
|---|---|
| `/status` | Shows the reading plan board if one is active in this chat, otherwise the generic task list |

To mark something done, just send a normal message — no command needed:

```
task 1 done       (generic task list)
chapter 3 done    (reading plan)
#2 completed
done 3
```

If a chat has an active reading plan, "N done" always refers to today's
reading item and **edits the existing board message in place** — no new
message is sent. If there's no active plan in that chat, "N done" falls
back to the generic task list as before.

## Setting up a reading plan

1. `/newplan` followed by a multi-line block, e.g.:
   ```
   /newplan
   Title: 40 Days Book Reading
   Days: 40
   Chapters: 40
   Increment: 2
   ```
2. Add readers in the order you want them to rotate:
   ```
   /addreader User1
   /addreader User2
   /addreader User3
   ```
   To insert someone into a specific slot instead of the end, add a
   position number:
   ```
   /addreader Linda 2
   ```
   This inserts Linda at position 2 and shifts everyone after her
   down by one — e.g. `Alex, James, James` becomes `Alex, Linda,
   James, James`. To reorder someone who's already in the rotation
   without removing them, use `/setposition`:
   ```
   /setposition James 1
   ```
3. `/nextday` — posts (and tries to pin) Day 1's board, e.g.:
   ```
   📚 40 Days Book Reading

   Day 01 - 20 JULY 2026

   01. 🔳 Chapter 01-User1
   02. 🔳 Chapter 02-User1
   03. 🔳 Chapter 03-User2
   04. 🔳 Chapter 04-User2
   ...

   0 Out of 6 Completed.

   Read the Chapter before the end of the working day.
   ```
4. As people finish, they send `chapter 1 done` (or `01 done`, `#1
   done`, etc.) — the board message updates in place with a ✅.
5. The plan auto-advances to the next day once every 24 hours via a
   Cron Trigger (default: midnight UTC — see `wrangler.toml` to change
   the time). An admin can also force it early anytime with
   `/nextday`.
6. Chapter numbers keep counting up across the whole plan and wrap
   around automatically once they pass your `Chapters` total, so a
   40-day plan over a 13-chapter book just cycles through the book
   again.

Readers persist across plans in the same chat, so starting a new
`/newplan` doesn't require re-adding everyone — just `/addreader` /
`/removereader` as needed.

## Enabling the daily auto-advance (Cron Trigger)

Cron Triggers are configured in `wrangler.toml`:

```toml
[triggers]
crons = ["0 0 * * *"]
```

This runs once daily and calls the Worker's `scheduled()` handler,
which advances every chat's active plan by one day. Change the cron
expression to adjust the time (it's UTC) — e.g. `"0 18 * * *"` for
6pm UTC. Redeploy after changing it. Cron Triggers are free on the
Workers free tier (subject to the same request-equivalent limits).

## 1. Prerequisites

- A Telegram bot token from [@BotFather](https://t.me/BotFather) (`/newbot`)
- Node.js installed locally
- `npm install -g wrangler` (or use `npx wrangler`)
- `wrangler login` — connects to your Cloudflare account

## 2. Install dependencies

```bash
cd telegram-task-bot
npm install
```

## 3. Create the D1 database

```bash
wrangler d1 create task_bot_db
```

This prints a `database_id`. Paste it into `wrangler.toml` under
`[[d1_databases]]`.

Then load the schema:

```bash
npm run db:init:remote
```

(`db:init:local` is there too if you want to test with `wrangler dev`'s
local D1 emulator first.)

## 4. Set secrets

```bash
wrangler secret put BOT_TOKEN
# paste the token from BotFather

wrangler secret put WEBHOOK_SECRET
# paste any random string you make up, e.g. output of:
# openssl rand -hex 24
```

`WEBHOOK_SECRET` is just used to verify incoming requests are really from
Telegram — Telegram will echo it back in a header on every webhook call.

## 5. Deploy

```bash
npm run deploy
```

Wrangler will print your Worker URL, e.g.
`https://telegram-task-bot.<your-subdomain>.workers.dev` — this already
works fine and is on the free tier, no custom domain required.

### Optional: use your own domain

Since you already have a domain on Cloudflare, you can serve the bot from
e.g. `bot.yourdomain.com` instead. Uncomment the `routes` block at the
bottom of `wrangler.toml`:

```toml
routes = [
  { pattern = "bot.yourdomain.com/*", custom_domain = true }
]
```

Make sure `bot.yourdomain.com` is a DNS name on that same Cloudflare zone
(Cloudflare will create/verify it for you on deploy), then run
`npm run deploy` again.

## 6. Point Telegram at your Worker

Tell Telegram to send updates to your Worker (replace both placeholders):

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://telegram-task-bot.<your-subdomain>.workers.dev",
    "secret_token": "<WEBHOOK_SECRET>"
  }'
```

(Use your custom domain URL instead if you set one up.) A successful
response looks like `{"ok":true,"result":true,...}`.

Verify anytime with:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## 7. Try it

1. Message your bot directly, or add it to a group
2. In groups, disable **Privacy Mode** in BotFather (`/setprivacy` → Disable)
   so the bot can see plain messages like "task 1 done", not just commands
   directed at it — otherwise it only sees `/commands`
3. Send `/start`, then `/addtask Buy milk`, then `/status`, then
   `task 1 done`

## Notes on the free tier

- **Workers free plan**: 100,000 requests/day — a personal/team task bot
  will use a tiny fraction of that.
- **D1 free tier**: 5 GB storage, 5M rows written/day, 25M rows read/day —
  far more than a task tracker needs.
- No cron/polling is used — Telegram pushes updates to your Worker via
  webhook, so there's no idle cost.

## Admin-only mode (optional)

By default anyone in a group can add/edit tasks. To restrict `/addtask`,
`/addtasks`, `/header`, and `/footer` to Telegram group admins/creators
(marking tasks done and `/status` stay open to everyone), set in
`wrangler.toml`:

```toml
[vars]
ADMIN_ONLY = "true"
```

then redeploy.

## Extending

- Task reminders: add a Cron Trigger in `wrangler.toml` and a `scheduled()`
  handler that queries pending tasks and calls `sendMessage`.
- Per-user task assignment: add an `assigned_to` column and an
  `/assign <task#> @user` command.
- Deleting/editing tasks: add `/deletetask <#>` and `/edittask <#> <text>`
  following the same pattern as the existing handlers.