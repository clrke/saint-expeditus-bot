# Saint Expeditus Bot

A Chrome extension + bridge server that monitors the **SAINT EXPEDITUS SUBDIVISION** Facebook Messenger group chat, detects `/expeditus` triggers, and responds via Claude with persistent community memory.

## Architecture

```
Chrome Extension (content script on messenger.com)
        |
        | HTTP POST { trigger, recentMessages, repliedToMessage }
        v
Bridge Server (Express, port 3141)
        |
        | @anthropic-ai/sdk (agentic tool loop)
        v
Claude API (claude-sonnet-4-6)
        |
        | tool calls: read_memory, write_memory
        v
memory/*.md files on disk
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure API key

```bash
cp .env .env  # edit this file
```

Set your Anthropic API key in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Start the bridge server

```bash
./scripts/dev.sh        # with auto-reload
# or
./scripts/start.sh      # production
```

Verify:

```bash
curl http://localhost:3141/health
```

### 4. Load the Chrome extension

```bash
npx tsx chrome-extension/build.ts
```

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `chrome-extension/` folder
4. Badge shows **ON** (green) when bridge is running

### 5. Use it

1. Open [messenger.com](https://www.messenger.com)
2. Navigate to the **SAINT EXPEDITUS SUBDIVISION** group chat
3. Type `/expeditus <question>` — bot responds in Taglish
4. Reply to a message with `/expeditus` — bot responds with that message as context

## Trigger Examples

| Input | Behavior |
|---|---|
| `/expeditus anong status ng water?` | Answers the question using memory + chat context |
| `/expeditus` (as a reply) | Responds based on the replied-to message |
| `/expeditus` (standalone) | Friendly greeting offering help |

## Project Structure

```
saint-expeditus/
├── shared/types.ts              # Shared TypeScript types
├── CLAUDE_PROMPT.md             # System prompt for the bot
├── memory/                      # Persistent memory (read/written by Claude)
│   ├── residents.md
│   ├── issues.md          # (shipped as an empty template)
│   └── decisions.md
├── bridge-server/
│   ├── src/
│   │   ├── index.ts             # Entry point
│   │   ├── app.ts               # Express app (DI for testing)
│   │   ├── claude.ts            # Anthropic SDK + agentic tool loop
│   │   ├── tools.ts             # Memory tool definitions + handlers
│   │   ├── prompt-builder.ts    # System prompt + user message builder
│   │   └── config.ts            # All configurable values
│   └── test/
├── chrome-extension/
│   ├── manifest.json
│   ├── popup.html
│   ├── build.ts                 # esbuild bundler
│   ├── src/
│   │   ├── main.ts              # Orchestrator
│   │   ├── element-discovery.ts # Heuristic DOM finders (no class names)
│   │   ├── message-parser.ts    # Parse message rows
│   │   ├── message-store.ts     # Rolling buffer with dedup
│   │   ├── trigger-registry.ts  # Pluggable trigger system
│   │   ├── request-queue.ts     # Async queue with cooldown
│   │   ├── bridge-client.ts     # HTTP client with retry
│   │   ├── response-injector.ts # Types into Messenger input
│   │   ├── dom-observer.ts      # MutationObserver + polling
│   │   ├── background.ts        # Badge status
│   │   └── popup.ts             # Popup UI
│   └── test/
├── test/
│   ├── e2e.test.ts              # Full pipeline integration
│   └── contract.test.ts         # API contract validation
└── scripts/
    ├── start.sh
    └── dev.sh
```

## Configuration

All settings are configurable via environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Your Anthropic API key |
| `PORT` | `3141` | Bridge server port |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model to use |
| `MAX_TOKENS` | `1024` | Max response tokens |
| `MAX_RPM` | `10` | Rate limit (requests/min) |
| `MAX_TOOL_ROUNDS` | `5` | Max tool-use loop iterations |
| `MAX_CONTEXT_MESSAGES` | `30` | Recent messages sent as context |
| `MEMORY_DIR` | `./memory` | Directory for memory files |
| `PROMPT_FILE` | `./CLAUDE_PROMPT.md` | System prompt file path |
| `REQUEST_TIMEOUT_MS` | `30000` | Request timeout |
| `RETRY_ATTEMPTS` | `2` | Retry count for failed API calls |
| `RETRY_DELAY_MS` | `1000` | Base delay between retries |

## Testing

```bash
npm test              # run all 68 tests
npm run test:watch    # watch mode
```

### Test coverage

| Layer | Tests |
|---|---|
| `tools.ts` | read/write/validation/size-cap with real filesystem (tmpdir) |
| `prompt-builder.ts` | Message formatting, truncation, token estimation |
| `claude.ts` | Text-only, single-tool, multi-tool, max-rounds (mocked SDK) |
| `app.ts` | 200/400/429/500 responses (supertest + mock askFn) |
| `element-discovery.ts` | Each finder with minimal ARIA/semantic HTML fixtures |
| `message-parser.ts` | Sender extraction, reply detection, context carry-over |
| `trigger-registry.ts` | Registration, detection, case-insensitive, multi-trigger |
| `message-store.ts` | Add, dedup, overflow, findBySender, clear |
| `request-queue.ts` | Enqueue, cooldown, error handling (fake timers) |
| `bridge-client.ts` | Success, retry, 429 handling, timeout (fetch mock) |
| Contract | Structural type validation for API payloads |
| E2E | Full pipeline: trigger → bridge → tools → response |

## How It Works

### DOM Discovery (No Class Names)

Facebook regenerates CSS class names on every deploy. The extension uses **zero class names**. Instead:

- **ARIA roles**: `role="row"`, `role="textbox"`, `role="grid"` — accessibility contracts
- **Semantic HTML**: `<h5>` for sender names, `dir="auto"` for message text, `<img alt>` for profile pics
- **Content heuristics**: Regex for timestamps, `fbcdn` domain for profile images

### Memory System

Claude reads/writes markdown files via `read_memory` and `write_memory` tools:

- **residents.md** — Resident names, roles, recurring concerns
- **issues.md** — Ongoing subdivision issues
- **decisions.md** — HOA decisions and announcements

Memory persists across conversations. Files are capped at 50KB with instructions to summarize when approaching the limit.

## API Endpoints

### `GET /health`

Returns server status and stats.

### `POST /ask`

```json
{
  "trigger": {
    "type": "inline",
    "query": "anong status ng water?",
    "sender": "Jane Dela Cruz",
    "replyTo": null,
    "originalMessage": "/expeditus anong status ng water?"
  },
  "recentMessages": [...],
  "repliedToMessage": null
}
```

Returns:

```json
{
  "response": "Kumusta po! Tungkol po sa water supply...",
  "timestamp": "2026-01-23T09:00:00.000Z",
  "toolsUsed": ["read_memory"]
}
```
