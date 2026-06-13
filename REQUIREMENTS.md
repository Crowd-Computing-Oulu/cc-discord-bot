# Sissy Bot — Requirements

## Provider
- **AI Backend**: OpenRouter (`https://openrouter.ai/api/v1`)
- **Model**: `qwen/qwen3-plus` (supports vision/image input)
- **API Key**: stored in `config.json` as `openrouter-apikey`

## Core AI Capabilities
- [x] Full tool-calling loop (model can call tools, results fed back, loop until done)
- [x] Image understanding — bot reads images attached to Discord messages (via vision)
- [x] Responds to `@Sissy` mentions in channels
- [x] Responds to DMs (whitelist-gated)
- [x] `/say` slash command with configurable history limit

## Passive Triggering (non-mention messages)
- [x] Bot evaluates every channel message with a lightweight NLP heuristic (keyword + pattern matching, no LLM)
- [x] If the heuristic returns positive, Sissy is called; she can still respond with `NULL_RESPONSE` to stay silent
- [x] Heuristic factors: keyword triggers (help, remind, search, etc.), question marks, being in an active conversation, factual claims, funny/emoji-heavy messages, welcome messages

## Proactive Behaviour
- [x] Welcomes new members when join/intro patterns are detected
- [x] Occasionally corrects misinformation or factual claims (stochastic, ~1 in 3 chance when pattern matched)
- [x] Occasionally joins funny conversations briefly (~1 in 5 chance when emoji/laughter patterns matched)
- [x] Stays engaged in a conversation if she has recently replied (tracks recent bot message count)
- [x] Always allowed to respond with `NULL_RESPONSE` to pass on a turn even when triggered
- Not super active — light-touch, shows up naturally a few times in a conversation

## Tools Available to the AI

### Reminders
- [x] Set a one-shot reminder (date/time + optional ping user)
- [x] Set a repeating reminder (cron schedule: daily, weekly, monthly, weekdays, weekends, hourly, or custom cron)
- [x] List reminders for a user
- [x] Cancel a reminder by ID
- [x] Reminder delivery via Discord DM

### File Reading
- [x] Read attached PDF files
- [x] Read attached DOCX files
- [x] Read attached Markdown files
- [x] Read attached CSV files
- [x] Read attached plain text files
- Files are fetched from Discord CDN URLs

### Web Search & Fetch
- [x] `web_search` — Search via DuckDuckGo (no API key needed), returns top results with titles, URLs, snippets
- [x] `fetch_url` — Fetch and read full text content of any URL

### Delayed / Scheduled Tasks
- [x] `delay_task` — Schedule any natural-language task to run later (e.g. "look up weather tomorrow morning and summarise it")
- Stored in DB, executed by the bot at the scheduled time, result posted to the original channel

### Direct Messaging
- [x] `send_dm` — Bot can DM any Discord user by their user ID

### Cross-Channel Reading
- [x] `read_channel` — Read recent messages from any accessible channel in the server
- [x] `list_channels` — List all accessible text channels with IDs and names
- [x] `search_messages` — Full-text search messages across all accessible channels or a specific one
- Bot can look up information across channels when answering questions

### Memory & Long-Term Context
- [x] `summarise_and_store_history` — Summarise a channel's message history into a compact summary stored in DB
- [x] Per-channel summaries stored in SQLite, recalled at conversation start as system context
- [x] Bot injects stored channel summary so it "remembers" years of history without burning tokens
- [x] `get_channel_summary` — Retrieve stored summary for a channel
- [x] `/summarise` slash command — triggers a manual history summarisation and storage

## Context Window
- Active messages sent to model: up to **50** recent messages per channel (up from 5/10)
- Plus stored channel summary (compressed history) prepended as system context
- Per-channel in-memory conversation state (separate per channel and per DM user)
- Context trimmed to last 60 messages to avoid token bloat

## Slash Commands
- `/ping` — health check
- `/say <message> [limit]` — talk to Sissy with optional history limit (default 20, max 50)
- `/remind <name> <month> <day> [hour] [minute] [user]` — one-shot reminder
- `/timer <name> [days] [hours] [minutes] [seconds] [user]` — duration timer
- `/summarise [limit]` — ask Sissy to summarise and store the current channel's history

## Config Fields (`config.json`)
```json
{
  "openrouter-apikey": "sk-or-v1-...",
  "discord-clientid": "",
  "discord-apikey": ""
}
```

## Database Tables
- `Reminders` — one-shot reminders (userId, title, remindAt, channelId, pingUserId)
- `RepeatReminders` — repeating reminders (userId, title, cronExpr, channelId, pingUserId, lastSentAt, nextRunAt)
- `ScheduledTasks` — delayed AI tasks (prompt, channelId, userId, runAt)
- `ChannelSummaries` — compressed channel history (channelId, summary, updatedAt, messageCount)

## Message Length
- Discord 2000-char limit handled: long responses are auto-split into chunks
