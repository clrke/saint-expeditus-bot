import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirnameBoot = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirnameBoot, '../../.env') });

// Prevent duplicate instances — exit if another bot is already running
const LOCK_FILE = path.resolve(__dirnameBoot, '../../.discord-bot.lock');
try {
  const existingPid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
  try {
    process.kill(Number(existingPid), 0); // Check if process exists
    console.error(`[Discord] Another instance already running (PID ${existingPid}). Exiting.`);
    process.exit(0);
  } catch {
    // Process doesn't exist — stale lock file, continue
  }
} catch {
  // No lock file — continue
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
// Deliberately NOT a graceful drain (unlike bridge's SIGTERM handler): the lock-file guard
// above is PID-liveness based, so delaying exit to drain in-flight requests would keep this
// PID alive and make a pm2-spawned replacement instance see "another instance running" and
// immediately quit — the opposite of a clean restart. If a drain is ever added here, the
// lock file must be unlinked FIRST (decoupled from the drain), same as bridge releases its
// port before draining. See the tldr-envelope restart discussion, 2026-08-04.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

import { EventSource } from 'eventsource';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';

import { askBridgeStream, fetchProjects, checkHealth, fetchBudget, stopBridgeSession, emergencyResetSession } from './bridge-client.js';
import { extractVideoPaths, findExistingByContent, uploadAndRecord, isYouTubeConfigured, checkYouTubeAuth, type UploadOpts } from './youtube-uploader.js';
import { isMetaConfigured, checkMetaAuth, uploadToMeta, INSTAGRAM_MAX_DURATION_S, getVideoDurationSync } from './meta-uploader.js';
import { debug, describeError, causeSuffix } from './debug.js';

/** Emoji that, when reacted by the user on a bot message, triggers pm2 restart all */
const RESTART_EMOJI = '🔄';

/** Emoji that rolls the thread's project session over: write HANDOFF.md → reset → reseed a fresh session */
const HANDOVER_EMOJI = '♻️';

/** Emoji that force-stops the in-flight turn for the thread's project (kills the CLI process tree) */
const STOP_EMOJI = '🛑';

/** Must match STOPPED_BY_USER in bridge-server/src/session-manager.ts (crosses the HTTP boundary as a string) */
const STOPPED_BY_USER_PREFIX = 'Stopped by user';

/**
 * Emergency full reset: kills the in-flight turn AND discards the session, in one shot.
 * For when a session is genuinely stuck (compaction spiral, wedged tool call) rather than
 * just slow — 🛑 alone would kill the turn but the next message still resumes the same
 * (possibly poisoned) conversation. Deliberately a DIFFERENT emoji/endpoint from ♻️ handover,
 * which asks the stuck session to write its own HANDOFF.md first — not usable when the
 * session is exactly what's unresponsive. Emergency use only: the conversation and any
 * un-handed-off context are gone, not archived.
 */
const EMERGENCY_RESET_EMOJI = '🆘';

/**
 * React 📺 on a "YouTube upload failed" message to retry it. Bound to the same emoji the
 * upload status lines already use as their prefix, so it reads as "the YouTube one" rather
 * than needing a separate mnemonic. Verified unused elsewhere (GAME_SHORTCUTS, XP_SHORTCUTS,
 * shell-shortcuts.json all checked 2026-09-06 — sweep them again before rebinding it).
 */
const YOUTUBE_RETRY_EMOJI = '📺';

/**
 * Game-launch reactions: react with the mapped emoji on a bot message to `open` the app
 * directly (no LLM round-trip, no slug). Same "must be the bot's message" gate as 🔄/shell
 * shortcuts below. Full absolute .app paths on purpose — `open -a "Hades"` is ambiguous on
 * this machine (Hades vs Hades II, plus a separate Steam-installed copy at
 * ~/Library/Application Support/Steam/steamapps/common/Hades/Game.macOS.app).
 *
 * Mega Man X Regenesis was originally requested as ❌, but ❌ already means "no" in
 * XP_SHORTCUTS below and fires on every project thread — rebound to 🎮 instead (2026-08-28,
 * user-confirmed) to avoid breaking that. Verified 🎮 is unused anywhere else in the repo.
 */
const GAME_SHORTCUTS: Record<string, { label: string; appPath: string }> = {
  '🎮': { label: 'Mega Man X Regenesis', appPath: '/Applications/Mega Man X Regenesis.app' },
  '😈': { label: 'Hades', appPath: '/Users/arke/Applications/Hades.app' },
  '🌈': { label: 'Super Hexagon', appPath: '/Applications/Super Hexagon.app' },
};

/** Shortcut emojis: when user reacts with one on a bot message, the mapped text is sent to /xp */
const XP_SHORTCUTS: Record<string, string> = {
  '👀': 'did you get to finish? I got cut off.',
  '⛓️‍💥': 'did you get to finish? I got cut off.',
  '👍': 'yes',
  '✅': 'yes',
  '❌': 'no',
  '⭐': 'merge PR and deploy',
  '🔧': 'fix it',
  '💭': "what's your recommendation?",
};

/** Pre-react 🔄 on /xp bot messages so the user can click once to trigger pm2 restart all (fire-and-forget) */
function preReactRestart(msg: Message): void {
  msg.react(RESTART_EMOJI).catch(err => {
    console.warn(`[Discord] pre-react ${RESTART_EMOJI} failed:`, (err as Error).message);
  });
}

/**
 * Project-scoped shell shortcuts: emoji → { slug, command, label }.
 * Reacting with the emoji on a bot message runs the shell command directly (no LLM round-trip).
 * Keep `cmd` as an absolute path so PATH/cwd quirks don't matter.
 */
// Load machine-local shell shortcuts from .saint-expeditus/shell-shortcuts.json (gitignored).
// Each machine keeps its own copy — missing file = no shortcuts registered.
// Format: { "emoji": { "slug": "project-slug", "cmd": "shell command", "label": "display name" } }
const SHORTCUTS_PATH = path.resolve(__dirnameBoot, '../../.saint-expeditus/shell-shortcuts.json');
let PROJECT_SHELL_SHORTCUTS: Record<string, { slug: string; cmd: string; label: string }> = {};
try {
  PROJECT_SHELL_SHORTCUTS = JSON.parse(fs.readFileSync(SHORTCUTS_PATH, 'utf-8'));
  console.log(`[Discord] Loaded ${Object.keys(PROJECT_SHELL_SHORTCUTS).length} shell shortcut(s) from ${SHORTCUTS_PATH}`);
} catch {
  console.log(`[Discord] No shell-shortcuts.json found — emoji shortcuts disabled`);
}

/** Pre-react the project's shortcut emoji on a bot message (fire-and-forget). No-op if no shortcut bound. */
function preReactProjectShortcut(msg: Message, slug: string): void {
  const entry = Object.entries(PROJECT_SHELL_SHORTCUTS).find(([, v]) => v.slug === slug);
  if (!entry) return;
  const [emoji] = entry;
  msg.react(emoji).catch(err => {
    console.warn(`[Discord] pre-react ${emoji} failed:`, (err as Error).message);
  });
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const NOTIFY_USER_ID = process.env.DISCORD_NOTIFY_USER_ID; // primary user — used for @mentions
const ALLOWED_USER_IDS: Set<string> = new Set(
  (process.env.DISCORD_ALLOWED_USER_IDS ?? process.env.DISCORD_NOTIFY_USER_ID ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
);
const userTag = NOTIFY_USER_ID ? `<@${NOTIFY_USER_ID}>` : '';
console.log(`[Discord] NOTIFY_USER_ID=${NOTIFY_USER_ID ?? 'NOT SET'}, allowlist=${[...ALLOWED_USER_IDS].join(',') || 'open'}`);

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required. Set it in .env or environment.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
  ],
});

// Known commands and project slugs
let knownCommands = new Set<string>();
let knownSlugs = new Set<string>();

// Thread ID → project slug mapping
const threadToSlug = new Map<string, string>();

// Slug → thread ID mapping
const slugToThread = new Map<string, string>();

// ── Input debounce ────────────────────────────────────────────────────────────
// Accumulates consecutive messages from the same channel before sending to the
// bridge, so a "thread of messages" arrives as a single combined request.
interface MessageBuffer {
  /** null when paused via "hold on" — no timer running, waiting indefinitely */
  timer: ReturnType<typeof setTimeout> | null;
  /** parts[0] = full originalMessage with /slug prefix; parts[1+] = raw text */
  parts: string[];
  attachmentUrls: string[];
  sender: string;
  replyChannel: TextChannel | ThreadChannel;
  slug?: string;
}
const messageBuffers = new Map<string, MessageBuffer>();
const DEBOUNCE_MS = 10_000;  // wait after last message before sending
const HOLD_ON_RE  = /^hold\s*on[\s.!?]*$/i;
// A message ending in "!" skips the debounce and flushes the buffer immediately.
const BANG_FLUSH_RE = /!\s*$/;
// A message that is ONLY "!"(s) is a pure "send now" trigger — no content to append.
const LONE_BANG_RE  = /^\s*!+\s*$/;

function flushMessageBuffer(channelId: string): void {
  const buf = messageBuffers.get(channelId);
  if (!buf) return;
  messageBuffers.delete(channelId);
  if (buf.parts.length === 0) return; // "hold on" with no follow-up — discard
  const combined = buf.parts.join('\n\n');
  console.log(`[Discord] debounce flush /${buf.slug ?? 'global'}: ${buf.parts.length} part(s), ${combined.length} chars`);
  debug('discord', `flush /${buf.slug ?? 'global'} sender=${buf.sender} channel=${buf.replyChannel.id} isThread=${buf.replyChannel.isThread?.() ?? false} archived=${(buf.replyChannel as { archived?: boolean }).archived ?? 'n/a'}`);
  sendBridgeRequest(combined, buf.sender, buf.replyChannel, buf.attachmentUrls, buf.slug)
    .catch(err => handleBridgeError(err, buf.replyChannel, `debounce flush /${buf.slug ?? 'global'}`));
}

/**
 * Drop the pending (un-flushed) debounce buffer for a channel without sending it.
 * Used by the 🛑 force-stop: killing the running turn while a buffered message is
 * still counting down would just start a new turn seconds later.
 * Returns how many message parts were discarded (0 if nothing was pending).
 */
function cancelPendingInput(channelId: string): number {
  const buf = messageBuffers.get(channelId);
  if (!buf) return 0;
  if (buf.timer) clearTimeout(buf.timer);
  messageBuffers.delete(channelId);
  const n = buf.parts.length;
  if (n > 0) console.log(`[Discord] cancelled ${n} pending debounced part(s) for channel ${channelId}`);
  return n;
}

/**
 * Buffer a project message. Consecutive messages on the same channel are
 * accumulated and flushed together after DEBOUNCE_MS of silence.
 * Pass textPart=null for "hold on" — pauses the timer indefinitely until
 * the next real message arrives.
 */
function bufferMessage(
  channelId: string,
  textPart: string | null,
  attachmentUrls: string[],
  sender: string,
  replyChannel: TextChannel | ThreadChannel,
  slug: string | undefined,
): void {
  const isHoldOn = textPart === null;
  const isBangFlush = !isHoldOn && BANG_FLUSH_RE.test(textPart!);
  const isLoneBang  = !isHoldOn && LONE_BANG_RE.test(textPart!);

  const existing = messageBuffers.get(channelId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    if (isHoldOn) {
      // "hold on" on an existing buffer — pause timer indefinitely
      existing.timer = null;
      return;
    }
    // A bare "!" is just a flush trigger — don't append it as content.
    if (!isLoneBang) existing.parts.push(textPart!);
    existing.attachmentUrls.push(...attachmentUrls);
    existing.sender = sender;
    if (isBangFlush) {
      existing.timer = null;
      flushMessageBuffer(channelId);  // skip the debounce — send now
    } else {
      // Resume: start a fresh 10s window now that the user has sent something
      existing.timer = setTimeout(() => flushMessageBuffer(channelId), DEBOUNCE_MS);
    }
    return;
  }

  // A lone "!" with nothing buffered yet has nothing to flush — ignore it.
  if (isLoneBang) return;

  const buf: MessageBuffer = {
    parts: isHoldOn ? [] : [textPart!],
    attachmentUrls: [...attachmentUrls],
    sender,
    replyChannel,
    slug,
    timer: null,
  };
  messageBuffers.set(channelId, buf);
  if (isBangFlush) {
    flushMessageBuffer(channelId);  // ends with "!" — skip the debounce, send immediately
  } else if (!isHoldOn) {
    // Normal message: flush after DEBOUNCE_MS of silence.
    // ("hold on" as the first message: leave timer null — wait indefinitely for content.)
    buf.timer = setTimeout(() => flushMessageBuffer(channelId), DEBOUNCE_MS);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if the text warrants pinging the notify user */
function requiresUserTag(text: string): boolean {
  if (!userTag) return false;
  if (['⏳', '🛑', '⏸️'].some(e => text.includes(e))) return true;
  // ⚡ pings for completion/nudge notices, but NOT progress ticks (⚡ Auto-decided (N/M))
  // which now stream per-iteration and would flood the user with pings
  if (text.includes('⚡') && !/^⚡ \*\*Auto-decided \(\d+\/\d+\)/.test(text)) return true;
  return false;
}

/** Remove both cache maps entries for a slug/thread pair */
function evictThreadCache(slug: string, threadId: string): void {
  slugToThread.delete(slug);
  threadToSlug.delete(threadId);
}

/** Acknowledge receipt of a message with 👀 — signals "I saw it, working on it" */
function ackSeen(message: Message): void {
  message.react('👀').catch(err => {
    console.warn('[Discord] react 👀 failed:', (err as Error).message);
  });
}

/**
 * Echo the exact prompt being sent to Claude back to the channel — gives the user
 * visibility into bot-prepended slug commands and bot-appended attachment instructions,
 * so what Claude receives is never a black box. Truncated to fit Discord's 2000-char limit.
 */
function echoFinalPrompt(fullMessage: string, channel: TextChannel | ThreadChannel): void {
  const MAX_BODY = 1700;
  // Defuse any stray ``` in user content so the code fence doesn't break.
  const safe = fullMessage.replace(/```/g, '​```');
  const body = safe.length > MAX_BODY
    ? `${safe.slice(0, MAX_BODY)}…[+${safe.length - MAX_BODY} chars]`
    : safe;
  const out = `-# 📨 sent to Claude:\n\`\`\`\n${body}\n\`\`\``;
  // Queue the echo through the channel's FIFO queue so it lands AFTER any pending
  // response chunks. Especially important for the pros/cons re-prompt echo which
  // fires while the previous response is still streaming — direct channel.send()
  // would race the in-flight chunks and surface mid-response.
  enqueueOnChannel(channel, () => channel.send(out))
    .then(sent => {
      // Pre-react 🛑 so force-stopping the turn is one click. This echo is the ideal
      // anchor: it posts exactly once, right as the turn starts, and is the last bot
      // message in the channel for as long as Claude is thinking with nothing to show.
      (sent as Message | undefined)?.react(STOP_EMOJI).catch(err => {
        console.warn(`[Discord] pre-react ${STOP_EMOJI} failed:`, (err as Error).message);
      });
    })
    .catch(err => {
      console.warn('[Discord] echo prompt failed:', (err as Error).message);
    });
}

// Commands that don't need a project thread
const GLOBAL_COMMANDS = new Set(['list', 'info', 'details', 'register', 'update', 'vacation', 'unvacation', 'auto-decide-extend', 'reset', 'compact', 'nudge', 'help']);
/** Commands handled entirely within the bot — never forwarded to the bridge */
const DISCORD_ONLY_COMMANDS = new Set(['budget']);
// Thread names that route to the command router rather than a project session
const THREAD_COMMANDS = new Set(['register', 'update']);

async function refreshPrefixes() {
  try {
    const { slugs, commands } = await fetchProjects();
    knownCommands = new Set(commands);
    knownSlugs = new Set(slugs);
    console.log(`[Discord] Refreshed: ${slugs.length} projects, ${commands.length} commands`);
  } catch (err) {
    console.warn('[Discord] Failed to refresh prefixes:', (err as Error).message);
  }
}

function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/([a-z0-9-]+)\s*([\s\S]*)$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2].trim() };
}

function isKnownPrefix(command: string): boolean {
  return knownCommands.has(command) || knownSlugs.has(command);
}

const STATUS_ICON: Record<string, string> = { completed: '✅', in_progress: '🔄', pending: '⬜' };
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
const UPLOAD_EXTS = [
  // Tabular / structured data
  '.csv', '.xlsx', '.xls', '.tsv', '.json', '.xml',
  // Documents
  '.pdf', '.docx',
  // Plain text / markup / config — added because Markdown/notes are the same
  // category of "user-facing data file" as csv/pdf and were being missed
  '.md', '.txt', '.log', '.yaml', '.yml', '.toml', '.html',
  // Audio — Discord renders an inline player for these, so they're playable in-channel
  // (video is deliberately excluded: .mp4 goes to YouTube/Meta via extractVideoPaths).
  '.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac', '.opus',
  // Archives
  '.zip',
];
/** Tools whose output details may contain local file paths worth uploading */
const UPLOAD_SCAN_TOOLS = new Set(['Write', 'Bash', 'Edit', 'MultiEdit', 'Read', 'Glob', 'NotebookEdit']);

/**
 * Auto-reprompt loop-guard. When a session's response mentions an `.mp4` but emits no
 * full absolute path (so `extractVideoPaths` finds nothing to upload), the bot fires ONE
 * follow-up asking the session to restate the absolute path. This Map caps retries per
 * slug so a session that keeps eliding the path can't trigger an infinite reprompt loop.
 * Persists across `sendBridgeRequest` calls (each reprompt is a fresh request); cleared
 * for a slug once a usable path is seen so future genuine renders can reprompt again.
 */
const MAX_VIDEO_PATH_REPROMPTS = 1;
const videoPathRepromptAttempts = new Map<string, number>();

/**
 * Try to downsize an oversized image so it fits under Discord's 8MB upload cap.
 * Iterates through progressively smaller scale factors (75% → 10%); stops at the
 * first one that fits. Returns the temp file path + outcome metadata, or null if
 * even 10% scale doesn't fit. Caller is responsible for cleaning up `outPath`.
 */
async function downsizeImageForDiscord(
  srcPath: string,
  maxBytes: number,
): Promise<{ outPath: string; outBytes: number; scalePct: number } | null> {
  const ext = path.extname(srcPath).toLowerCase() || '.png';
  const tmp = path.join(os.tmpdir(), `discord-resize-${Date.now()}-${process.pid}-${path.basename(srcPath, ext)}${ext}`);
  for (const scale of [75, 50, 30, 20, 10]) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('convert', [srcPath, '-resize', `${scale}%`, tmp], {
          timeout: 30_000, // hard cap so a runaway convert can't tie up resources
        });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`convert exited ${code}`)));
        proc.on('error', reject);
      });
      const stat = fs.statSync(tmp);
      if (stat.size > 0 && stat.size <= maxBytes) {
        return { outPath: tmp, outBytes: stat.size, scalePct: scale };
      }
    } catch (err) {
      console.warn(`[Discord] downsize attempt @${scale}% failed:`, (err as Error).message);
    }
  }
  // Couldn't get under the cap — clean up the last temp file if it exists
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  return null;
}

/**
 * Upload any file paths detected in `text` to the given Discord channel.
 * Resolves relatives via `projectDirectory`, dedups via the caller-owned `uploaded` set
 * (per-request) AND the persistent FILE_CACHE (cross-request, MD5-based, 1h TTL).
 * Skips missing/empty/over-8MB files, and uses 800ms disk-flush delay when called from tool-detail context.
 */
function uploadDetectedFilesIn(
  text: string,
  channel: TextChannel | ThreadChannel,
  projectDirectory: string | null,
  uploaded: Set<string>,
): void {
  // Never upload files from sensitive system dirs regardless of extension
  const BLOCKED_DIRS = [
    path.join(process.env.HOME ?? '', '.saint-expeditus'),
    path.join(process.env.HOME ?? '', '.claude'),
    path.join(process.env.HOME ?? '', '.ssh'),
    path.join(process.env.HOME ?? '', '.aws'),
  ];
  for (const filePath of extractUploadPaths(text, projectDirectory)) {
    if (uploaded.has(filePath)) continue;
    if (BLOCKED_DIRS.some(d => filePath.startsWith(d + '/'))) continue; // block secrets dirs
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0 || stat.size > 8 * 1024 * 1024) continue; // Discord 8MB limit
      uploaded.add(filePath);

      // Cross-request dedup: if the same bytes (by MD5) crossed the Discord boundary in
      // the past hour — either the user just uploaded it, or the bot already pushed it —
      // stay silent. Common case: user attaches data.csv, asks "summarize", Claude's
      // response mentions the path → without dedup, we'd re-upload the same file.
      const md5 = md5SyncOfFile(filePath);
      const recent = md5 ? fileCacheCheck(md5) : null;
      if (recent) {
        const minsAgo = Math.round((Date.now() - recent.ts) / 60_000);
        const sourceLabel = recent.source === 'user' ? 'user uploaded' : 'bot sent';
        console.log(`[Discord] file dedup (${sourceLabel} ${minsAgo}m ago, md5=${md5!.slice(0, 8)}): skipping ${filePath}`);
        continue;
      }

      console.log(`[Discord] Uploading detected file: ${filePath} (${stat.size} bytes)`);
      // Queue through the channel's FIFO so file uploads land in order with response chunks
      enqueueOnChannel(channel, () => withRetry(() => channel.send({ files: [filePath] }))).catch(console.error);
      // Record immediately (don't wait for the network round-trip) so a quick subsequent
      // mention of the same path within this same response also dedups correctly.
      if (md5) fileCacheRecord(md5, 'bot', filePath);
    } catch { /* skip on error */ }
  }
}

/** Extract file paths with known upload extensions from text. Resolves relative paths against projectDirectory if provided. */
function extractUploadPaths(text: string, projectDirectory?: string | null, exts: string[] = UPLOAD_EXTS): string[] {
  const extAlt = exts.map(e => e.slice(1)).join('|');
  // Strip ONLY fenced code blocks (multi-line ``` … ```) — those usually contain example
  // code. Do NOT strip inline single-backtick spans — Claude consistently wraps real file
  // references in inline backticks ("saved to `out/data.csv`"), and stripping them was
  // silently dropping every backticked path. The qualified-path regex requires a `/`, so
  // prose like "use the `foo.csv` format" can't false-positive.
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  // Match paths that contain at least one '/' (excludes bare filenames like analysis.csv).
  // Handles absolute (/foo/bar.csv), home (~/foo.csv), explicit-relative (./foo.csv),
  // and dir-relative (dir/file.csv). Code blocks/backticks already stripped above.
  const qualifiedPattern = new RegExp(`([~.]?/[\\w\\-./]+\\.(?:${extAlt})|[\\w][\\w\\-]*/[\\w\\-./]+\\.(?:${extAlt}))`, 'gi');
  const matches = [...stripped.matchAll(qualifiedPattern)].map(m => m[1]);
  const resolved = new Set<string>();
  for (const raw of matches) {
    let abs: string;
    if (raw.startsWith('/')) abs = raw;
    else if (raw.startsWith('~')) abs = raw.replace(/^~/, process.env.HOME ?? '~');
    else if (projectDirectory) abs = path.resolve(projectDirectory, raw);
    else continue; // relative path with no project dir — skip
    resolved.add(abs);
  }

  // Bare-filename detection: only when paired with an action verb (created/updated/etc.)
  // within ~80 chars AND the file actually exists in projectDirectory. Picks up status
  // lines like "Updated foo.xlsx" without false-positiving on prose like "package.json error".
  if (projectDirectory) {
    const bareWithVerbPattern = new RegExp(
      `\\b(?:created|generated|updated|modified|wrote|wrote\\s+to|saved|exported|produced|added|new)\\b[^\\n]{0,80}?\\b([\\w][\\w\\-.]*\\.(?:${extAlt}))\\b`,
      'gi',
    );
    for (const m of stripped.matchAll(bareWithVerbPattern)) {
      const filename = m[1];
      const abs = path.resolve(projectDirectory, filename);
      if (resolved.has(abs)) continue;
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          resolved.add(abs);
        }
      } catch { /* skip on stat error */ }
    }
  }

  return [...resolved];
}

/**
 * Like extractUploadPaths but for image extensions (png/jpg/…). Used to auto-upload images
 * PRODUCED by Bash/Write tools (cp, magick, sips, etc.) — the Read-tool branch only handles
 * images opened for viewing, so a created/copied image would otherwise never reach Discord.
 */
function extractImagePaths(text: string, projectDirectory?: string | null): string[] {
  return extractUploadPaths(text, projectDirectory, IMAGE_EXTS);
}

/**
 * Upload an image to Discord if the same bytes haven't crossed the channel in the past hour
 * (MD5 dedup via FILE_CACHE). Handles the 8MB cap by auto-downsizing via ImageMagick. The
 * `headerPrefix` is the `-#` subtext label shown above the image. Shared by the Read-tool
 * branch and the Bash/Write tool-output scan so viewed AND produced images upload identically.
 */
function uploadImageIfNew(
  filePath: string,
  channel: TextChannel | ThreadChannel,
  headerPrefix: string,
): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const md5 = md5SyncOfFile(filePath);
    const recent = md5 ? fileCacheCheck(md5) : null;
    if (recent) {
      const minsAgo = Math.round((Date.now() - recent.ts) / 60_000);
      const sourceLabel = recent.source === 'user' ? 'you uploaded' : 'I sent';
      console.log(`[Discord] image dedup (${sourceLabel} ${minsAgo}m ago, md5=${md5!.slice(0, 8)}): skipping ${filePath}`);
      const sameName = recent.filePath === filePath;
      const matchNote = sameName ? '' : ` — identical to \`${recent.filePath}\``;
      enqueueOnChannel(channel, () =>
        channel.send(`-# ${headerPrefix}${filePath} (already on Discord, ${sourceLabel} ${minsAgo}m ago${matchNote})`),
      ).catch(console.error);
      return;
    }

    const stat = fs.statSync(filePath);
    const MAX = 8 * 1024 * 1024; // Discord's non-Nitro upload cap
    if (!stat.isFile() || stat.size === 0) return;

    if (stat.size <= MAX) {
      enqueueOnChannel(channel, () => channel.send(`-# ${headerPrefix}${filePath}`)).catch(console.error);
      enqueueOnChannel(channel, () => channel.send({ files: [filePath] })).catch(console.error);
      if (md5) fileCacheRecord(md5, 'bot', filePath);
      return;
    }

    // Oversized: downsize → notify → upload as ONE atomic queue item so it can't interleave
    // with subsequent tool messages (holds the queue for the resize duration — the right
    // tradeoff for ordering).
    const origMb = (stat.size / 1024 / 1024).toFixed(1);
    enqueueOnChannel(channel, () => channel.send(`-# ${headerPrefix}${filePath}`)).catch(console.error);
    enqueueOnChannel(channel, () =>
      channel.send(`-# 🗜️ Downsizing ${origMb} MB image to fit 8 MB Discord cap...`),
    ).catch(console.error);
    enqueueOnChannel(channel, async () => {
      const result = await downsizeImageForDiscord(filePath, MAX);
      if (!result) {
        await channel.send(`-# ⚠️ Couldn't downsize ${filePath} below 8 MB even at 10% scale; skipping upload.`).catch(() => {});
        return;
      }
      const reducedMb = (result.outBytes / 1024 / 1024).toFixed(1);
      await channel.send(`-# 🗜️ ${origMb} MB → ${reducedMb} MB at ${result.scalePct}% scale`).catch(() => {});
      try {
        await channel.send({ files: [result.outPath] });
        // Record by ORIGINAL md5 (not the downsized derivative) so future reads of the same
        // source file dedup correctly.
        if (md5) fileCacheRecord(md5, 'bot', filePath);
      } catch (err) {
        console.error('[Discord] downsized upload failed:', err);
      } finally {
        try { fs.unlinkSync(result.outPath); } catch { /* ignore */ }
      }
    }).catch(console.error);
  } catch { /* skip on error */ }
}

/** Prominent CJK historical/cultural figures for subagent identification */
const AGENT_NAMES = [
  // Chinese (中国)
  '孔子', '老子', '孫子', '李白', '杜甫', '諸葛亮', '曹操', '関羽',
  '武則天', '花木蘭', '屈原', '司馬遷', '王羲之', '蔡倫', '張衡',
  '鄭和', '林則徐', '魯迅', '孟子', '荘子',
  // Japanese (日本)
  '宮本武蔵', '織田信長', '豊臣秀吉', '徳川家康', '坂本龍馬',
  '紫式部', '清少納言', '松尾芭蕉', '葛飾北斎', '千利休',
  '聖徳太子', '源義経', '伊達政宗', '上杉謙信', '武田信玄',
  '西郷隆盛', '福沢諭吉', '夏目漱石', '黒澤明', '手塚治虫',
  // Korean (한국)
  '세종대왕', '이순신', '장영실', '허준', '신사임당',
  '이황', '이이', '정약용', '김유신', '을지문덕',
  '광개토대왕', '대조영', '최무선', '장보고', '유관순',
];

/** Shared pool tracker — persists across requests so names don't repeat within a session */
let usedAgentNames = new Set<string>();

function assignAgentName(): string {
  const available = AGENT_NAMES.filter(n => !usedAgentNames.has(n));
  const pool = available.length > 0 ? available : AGENT_NAMES;
  const name = pool[Math.floor(Math.random() * pool.length)];
  usedAgentNames.add(name);
  // Reset when 80% exhausted — seed new set with the just-used name to prevent immediate repeat
  if (usedAgentNames.size > AGENT_NAMES.length * 0.8) usedAgentNames = new Set([name]);
  return name;
}

/** Retry a Discord API call up to `retries` times with exponential backoff */
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 2000): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isTransient = msg.includes('Timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('fetch failed');
      if (!isTransient || i === retries) throw err;
      const wait = delayMs * (i + 1) + Math.random() * 1000;
      console.log(`[Discord] Retry ${i + 1}/${retries} after ${Math.round(wait)}ms: ${msg.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('unreachable');
}

/**
 * Per-channel send queue. Streaming callbacks (`onMessage`, `onToolUse`, SSE handlers)
 * fire concurrently and previously used fire-and-forget `.send().catch()` patterns,
 * which let messages interleave out-of-order on the wire. All such sends now go
 * through `enqueueOnChannel` so each channel sees a strictly FIFO chain.
 *
 * Keyed by `channel.id` (string), NOT the channel object — discord.js may hand out
 * different ThreadChannel instances for the same logical channel after cache evictions
 * or re-fetches via `findOrCreateThread`, which would create a fresh queue and let
 * parallel sends bypass the FIFO chain. Especially visible with intermittent internet
 * because retries widen the window for racing handlers to fetch fresh thread objects.
 *
 * Callers MUST enqueue synchronously (no `await` between enqueues) so all work for
 * one event reaches the queue before the next event's callback runs.
 */
const channelSendQueue = new Map<string, Promise<unknown>>();
function enqueueOnChannel<T>(
  channel: TextChannel | ThreadChannel,
  work: () => Promise<T>,
): Promise<T> {
  const key = channel.id;
  const prev = channelSendQueue.get(key) ?? Promise.resolve();
  // Run work even if the previous step rejected; swallow errors in the stored chain
  // so a single failure doesn't poison the queue for future sends.
  const next = prev.catch(() => undefined).then(work);
  channelSendQueue.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Remembers what to retry when a user reacts 📺 on a "YouTube upload failed" message.
 * Keyed by that message's id, process-lifetime only (same tradeoff as
 * `videoPathRepromptAttempts` below) — a bridge/discord-bot restart drops it, which just
 * means the reaction silently no-ops instead of retrying; re-running the render/mention
 * that produced the video re-triggers the normal upload path anyway.
 */
interface YouTubeRetryPayload { filePath: string; opts: UploadOpts; createdAt: number }
const youtubeRetryPayloads = new Map<string, YouTubeRetryPayload>();
const YOUTUBE_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // matches the .attachments/dedup-cache sweep order of magnitude

function pruneYoutubeRetryPayloads(): void {
  const cutoff = Date.now() - YOUTUBE_RETRY_MAX_AGE_MS;
  for (const [id, payload] of youtubeRetryPayloads) {
    if (payload.createdAt < cutoff) youtubeRetryPayloads.delete(id);
  }
}

/**
 * Attempt (or retry) a YouTube upload and post the result to `channel`. On failure, pre-reacts
 * 📺 on the failure message and remembers {filePath, opts} so reacting 📺 on that same message
 * retries without re-running whatever render/detection produced the video in the first place.
 */
async function attemptYouTubeUpload(
  filePath: string,
  opts: UploadOpts,
  md5: string,
  channel: TextChannel | ThreadChannel,
): Promise<void> {
  try {
    const result = await uploadAndRecord(filePath, opts, md5);
    await enqueueOnChannel(channel, () => channel.send(`-# 📺 ✅ ${result.url}`));
  } catch (err) {
    const msg = ((err as Error).message + causeSuffix(err)).slice(0, 250);
    console.warn(`[Discord] YouTube upload failed for ${filePath}: ${msg}`);
    const failureMsg = await enqueueOnChannel(channel, () =>
      channel.send(`-# 📺 ⚠️ YouTube upload failed for ${path.basename(filePath)}: ${msg}\n-# React ${YOUTUBE_RETRY_EMOJI} to try again.`),
    );
    pruneYoutubeRetryPayloads();
    youtubeRetryPayloads.set(failureMsg.id, { filePath, opts, createdAt: Date.now() });
    failureMsg.react(YOUTUBE_RETRY_EMOJI).catch(err2 => {
      console.warn(`[Discord] pre-react ${YOUTUBE_RETRY_EMOJI} failed:`, (err2 as Error).message);
    });
  }
}

/**
 * Discord file dedup cache. Tracks the MD5 of each file (image OR data file like
 * xlsx/csv/json/pdf/etc.) that has crossed the Discord boundary in either direction:
 *   - user attachment download → recorded as `user`
 *   - bot-uploaded Read result for an image → recorded as `bot`
 *   - bot-uploaded data file via `uploadDetectedFilesIn` → recorded as `bot`
 *
 * When the bot would later upload the SAME bytes within `FILE_CACHE_TTL_MS`, we
 * skip the re-send so the channel doesn't get the same attachment twice in close
 * succession (e.g. user uploads `data.csv`, asks "summarize", Claude's response
 * mentions the path → without dedup, the bot would re-upload the same file).
 *
 * Storage: `~/.saint-expeditus/discord-file-cache.json`, chmod 600. Lazy expiry
 * on save (entries older than TTL get pruned). Survives bot restarts.
 *
 * Hashing is sync via `fs.readFileSync` capped at 50 MB — anything bigger skips
 * the dedup check (returns null) so very large files aren't a blocking concern.
 */
const FILE_CACHE_PATH = path.join(os.homedir(), '.saint-expeditus', 'discord-file-cache.json');
const FILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FILE_CACHE_MAX_HASH_BYTES = 50 * 1024 * 1024;

interface FileCacheEntry {
  ts: number;
  source: 'user' | 'bot';
  filePath: string;
}
type FileCacheJson = Record<string /* md5 hex */, FileCacheEntry>;

function md5SyncOfFile(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > FILE_CACHE_MAX_HASH_BYTES) return null; // skip dedup for very large files
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function loadFileCache(): FileCacheJson {
  try {
    return JSON.parse(fs.readFileSync(FILE_CACHE_PATH, 'utf-8')) as FileCacheJson;
  } catch {
    return {};
  }
}

function saveFileCache(cache: FileCacheJson): void {
  // Lazy cleanup — drop entries older than TTL on every write.
  const cutoff = Date.now() - FILE_CACHE_TTL_MS;
  for (const k of Object.keys(cache)) {
    if (cache[k].ts < cutoff) delete cache[k];
  }
  try {
    fs.mkdirSync(path.dirname(FILE_CACHE_PATH), { recursive: true, mode: 0o700 });
    const tmp = FILE_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE_CACHE_PATH);
  } catch (err) {
    console.warn('[Discord] file cache save failed:', (err as Error).message);
  }
}

/** Returns the cache entry if md5 was seen in the past hour, else null. */
function fileCacheCheck(md5: string): FileCacheEntry | null {
  const cache = loadFileCache();
  const entry = cache[md5];
  if (!entry) return null;
  if (Date.now() - entry.ts > FILE_CACHE_TTL_MS) return null;
  return entry;
}

function fileCacheRecord(md5: string, source: 'user' | 'bot', filePath: string): void {
  const cache = loadFileCache();
  cache[md5] = { ts: Date.now(), source, filePath };
  saveFileCache(cache);
}

function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  // When a split falls mid-fence, we close the fence at the end of the chunk and
  // store the opener here so the next chunk starts with a reopened fence.
  let fenceReopener = '';

  while (remaining.length > 0) {
    // Prepend the reopener if the previous chunk ended mid-fence
    const prefix = fenceReopener ? fenceReopener + '\n' : '';
    const full = prefix + remaining;

    if (full.length <= maxLength) {
      chunks.push(full);
      break;
    }

    // Reserve 4 chars ('\n```') in case we need to close a fence at the split point
    const cap = maxLength - 4;
    let splitAt = full.lastIndexOf('\n', cap);
    if (splitAt < cap / 2) splitAt = full.lastIndexOf(' ', cap);
    if (splitAt < cap / 2) splitAt = cap;

    const slice = full.slice(0, splitAt);

    // Scan the slice for fence transitions.
    // Invariant: we always start a chunk outside a fence (we closed it at the end
    // of the previous chunk and will reopen it via the prefix above).
    let inFence = false;
    let currentOpener = '```';
    for (const m of slice.matchAll(/```(\w*)/g)) {
      if (inFence) {
        inFence = false; // closing ```
      } else {
        inFence = true;  // opening ```lang
        currentOpener = '```' + (m[1] ?? '');
      }
    }

    if (inFence) {
      // The split falls mid-fence — close it here and reopen it next iteration
      chunks.push(slice + '\n```');
      fenceReopener = currentOpener;
    } else {
      chunks.push(slice);
      fenceReopener = '';
    }

    remaining = full.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Split text into discrete Discord messages by structural units (paragraphs, top-level
 * bullets, numbered items, headers, code blocks) — each becomes its own message so
 * users can copy individual pieces off Discord without dragging across messages.
 *
 * Boundaries:
 * - Code blocks (```…```) are atomic, one message
 * - Top-level bullets (`- ` / `* `) and numbers (`1. `) split into separate messages;
 *   indented sub-bullets stay with their parent
 * - Headers (`# ` / `## ` / …) split into their own message
 * - Blank lines separate paragraphs
 *
 * Long single units fall back to length-based splitting via splitMessage.
 */
function splitMessageStructured(text: string, maxLength = 2000): string[] {
  // 1. Replace code blocks with single-line placeholders so they survive line-splitting intact
  const codeBlocks: string[] = [];
  const NUL = '\x00';
  const placeholderText = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `${NUL}CB${codeBlocks.length - 1}${NUL}`;
  });

  const lines = placeholderText.split('\n');
  const units: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const unit = buffer.join('\n').trim();
    if (unit) units.push(unit);
    buffer = [];
  };

  // Top-level only — indented bullets stay glued to their parent (preserves nesting)
  const isTopBullet = (s: string) => /^[-*]\s/.test(s) || /^\d+\.\s/.test(s);
  const isHeader = (s: string) => /^#+\s/.test(s);
  const codeOnlyLine = new RegExp(`^\\s*${NUL}CB\\d+${NUL}\\s*$`);

  for (const line of lines) {
    if (line.trim() === '') {
      flush();
    } else if (codeOnlyLine.test(line)) {
      flush();
      buffer.push(line);
      flush();
    } else if (isTopBullet(line) || isHeader(line)) {
      flush();
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();

  // Restore code-block placeholders to their original ```...``` content
  const placeholderPattern = new RegExp(`${NUL}CB(\\d+)${NUL}`, 'g');
  const restored = units.map(unit =>
    unit.replace(placeholderPattern, (_, idx) => codeBlocks[parseInt(idx, 10)])
  );

  // Length cap: any single unit over maxLength falls back to length-based split
  const messages: string[] = [];
  for (const unit of restored) {
    if (unit.length <= maxLength) {
      messages.push(unit);
    } else {
      messages.push(...splitMessage(unit, maxLength));
    }
  }

  return messages;
}

async function findOrCreateThread(channel: TextChannel, slug: string): Promise<ThreadChannel> {
  // Check cache
  const cachedThreadId = slugToThread.get(slug);
  if (cachedThreadId) {
    try {
      const thread = await channel.threads.fetch(cachedThreadId);
      if (thread) {
        if (!thread.joined) await thread.join();
        return thread;
      }
      evictThreadCache(slug, cachedThreadId);
    } catch (err) {
      console.warn(`[Discord] Cached thread ${cachedThreadId} for /${slug} inaccessible, evicting: ${(err as Error).message}`);
      evictThreadCache(slug, cachedThreadId);
    }
  }

  // Search existing threads
  const activeThreads = await channel.threads.fetchActive();
  for (const [, thread] of activeThreads.threads) {
    const threadSlug = threadNameToSlug(thread.name);
    if (threadSlug === slug) {
      threadToSlug.set(thread.id, slug);
      slugToThread.set(slug, thread.id);
      if (!thread.joined) await thread.join();
      return thread;
    }
  }

  // Search archived threads
  const archivedThreads = await channel.threads.fetchArchived();
  for (const [, thread] of archivedThreads.threads) {
    const threadSlug = threadNameToSlug(thread.name);
    if (threadSlug === slug) {
      // Unarchive it
      await thread.setArchived(false);
      if (!thread.joined) await thread.join();
      threadToSlug.set(thread.id, slug);
      slugToThread.set(slug, thread.id);
      return thread;
    }
  }

  // Create new thread — use slug as name, will be readable
  const threadName = `/${slug}`;
  const thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 10080, // 7 days
  });

  threadToSlug.set(thread.id, slug);
  slugToThread.set(slug, thread.id);
  console.log(`[Discord] Created thread "${threadName}" for project ${slug}`);

  return thread;
}

function threadNameToSlug(name: string): string {
  // Thread names are like "/squat" or "/rfp"
  return name.replace(/^\//, '').toLowerCase();
}

/** Anthropic API per-image dimension cap for many-image requests */
const MAX_IMAGE_DIMENSION = 2000;

/**
 * If the file is an image larger than 2000px on either side, shrink it in place via ImageMagick.
 * The `>` flag in `-resize "2000x2000>"` only shrinks (never enlarges) and preserves aspect ratio.
 * Failures are logged and swallowed — the original file is preserved so Claude can still try to Read it.
 */
function clampImageDimensions(localPath: string): void {
  const ext = path.extname(localPath).toLowerCase();
  if (!IMAGE_EXTS.includes(ext)) return;
  // SVGs are vector — no fixed pixel dimensions to clamp
  if (ext === '.svg') return;
  try {
    const dims = execSync(`identify -format "%wx%h" ${JSON.stringify(localPath)}`, { timeout: 10_000 })
      .toString()
      .trim();
    const [wStr, hStr] = dims.split('x');
    const w = parseInt(wStr, 10);
    const h = parseInt(hStr, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    if (w <= MAX_IMAGE_DIMENSION && h <= MAX_IMAGE_DIMENSION) return;
    execSync(
      `convert ${JSON.stringify(localPath)} -resize "${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}>" ${JSON.stringify(localPath)}`,
      { timeout: 30_000 },
    );
    console.log(`[Discord] Resized image ${path.basename(localPath)} from ${w}x${h} (>${MAX_IMAGE_DIMENSION}px API cap)`);
  } catch (err) {
    console.warn(`[Discord] dimension-clamp failed for ${path.basename(localPath)}: ${(err as Error).message}`);
  }
}

/** Files older than this in .attachments/ get swept on every download call. Bounds growth
 *  now that files a Claude turn actually Read are kept past end-of-turn cleanup (see
 *  `referencedAttachments` in sendBridgeRequest) instead of being unconditionally unlinked. */
const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Delete any file in tmpDir older than ATTACHMENT_MAX_AGE_MS. Best-effort; a failed
 *  stat/unlink just leaves that file for the next sweep rather than throwing. */
function sweepStaleAttachments(tmpDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - ATTACHMENT_MAX_AGE_MS;
  for (const entry of entries) {
    const p = path.join(tmpDir, entry);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      /* ignore — file may have been removed concurrently */
    }
  }
}

/** Download Discord attachments to temp dir, return local paths */
async function downloadAttachments(urls: string[]): Promise<string[]> {
  if (urls.length === 0) return [];
  const tmpDir = path.resolve(__dirnameBoot, '../../.attachments');
  fs.mkdirSync(tmpDir, { recursive: true });
  sweepStaleAttachments(tmpDir);

  const results = await Promise.allSettled(urls.map(async (url, i) => {
    const filename = url.split('/').pop()?.split('?')[0] ?? 'attachment';
    const localPath = path.join(tmpDir, `${Date.now()}-${i}-${filename}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${filename}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    console.log(`[Discord] Downloaded attachment: ${localPath} (${buffer.length} bytes)`);
    // Cap image dimensions to satisfy Anthropic's 2000px per-image limit for multi-image requests
    clampImageDimensions(localPath);
    // Record MD5 for EVERY user-uploaded attachment (image OR data file) so the bot
    // doesn't re-upload the same content back to Discord within the next hour. Covers
    // both the image-in-Read path and the bot-mentions-path-in-response path.
    {
      const md5 = md5SyncOfFile(localPath);
      if (md5) fileCacheRecord(md5, 'user', localPath);
    }
    return localPath;
  }));

  return results.flatMap(r => {
    if (r.status === 'fulfilled') return [r.value];
    console.error(`[Discord] Failed to download attachment: ${r.reason.message}`);
    return [];
  });
}

async function sendBridgeRequest(
  originalMessage: string,
  sender: string,
  replyChannel: TextChannel | ThreadChannel,
  attachmentUrls: string[] = [],
  slug?: string,
) {
  // Typing is cosmetic and MUST NOT fail the request. Discord 500s on sendTyping for an
  // archived thread (send() un-archives and succeeds, so only typing breaks) — unguarded,
  // that threw DiscordAPIError "Internal Server Error" out of here before the bridge was
  // ever called, and handleBridgeError reported it as if the bridge had failed. The
  // repeating call below was already guarded; this one was the gap.
  await replyChannel.sendTyping().catch((err: unknown) => {
    debug('discord', `sendTyping failed (non-fatal) for /${slug ?? 'global'}: ${describeError(err)}`);
  });

  // Keep typing indicator alive during long requests
  const typingInterval = setInterval(() => {
    replyChannel.sendTyping().catch(() => {});
  }, 8000);

  // Don't send recentMessages — project sessions use resume which already has full context
  const sentMessages = new Set<string>(); // dedup intermediate messages
  const uploadedFiles = new Set<string>(); // dedup file uploads per request
  let projectDirectory: string | null = null; // set by onMeta from SSE

  // Auto-reprompt tracking: did this turn mention an .mp4, and did we ever extract a
  // usable absolute path from it? If mentioned-but-not-extractable, reprompt the session.
  let sawVideoMention = false;
  let sawExtractablePath = false;

  /** Upload files found in text if they exist and haven't been uploaded yet */
  const uploadDetectedFiles = (text: string) => {
    uploadDetectedFilesIn(text, replyChannel, projectDirectory, uploadedFiles);
  };

  /**
   * Detect .mp4 paths in text and async-upload to YouTube. Per-request dedup via
   * `videoUploadAttempts` (in-process); cross-request dedup via the persistent MD5
   * ledger inside `uploadVideoIfNew`. Status messages routed through the channel
   * queue so they preserve order with surrounding response chunks.
   */
  const videoUploadAttempts = new Set<string>();
  const tryYouTubeUpload = (text: string) => {
    const filePaths = extractVideoPaths(text, projectDirectory);
    if (filePaths.length > 0) sawExtractablePath = true;
    for (const filePath of filePaths) {
      if (videoUploadAttempts.has(filePath)) continue;
      if (!fs.existsSync(filePath)) continue;
      videoUploadAttempts.add(filePath);

      // Fire-and-forget: upload happens off-thread, status messages enqueue on the
      // channel queue so they land in order even when the response is still streaming.
      (async () => {
        try {
          if (!(await isYouTubeConfigured())) {
            enqueueOnChannel(replyChannel, () =>
              replyChannel.send(`-# 📺 YouTube upload skipped for ${path.basename(filePath)}: not configured. Run \`npx --prefix discord-bot tsx src/youtube-auth.ts\` once.`),
            ).catch(() => {});
            return;
          }

          // Precheck the ledger BEFORE posting anything to Discord. If this video has
          // already been uploaded (matched by MD5), stay silent — the link surfaced
          // when it was first uploaded; re-announcing on every mention is noise.
          const { md5, existing } = await findExistingByContent(filePath);
          if (existing) {
            console.log(`[Discord] YouTube dedup (silent): ${filePath} → ${existing.url}`);
            return;
          }

          const filename = path.basename(filePath, path.extname(filePath));
          const projectName = projectDirectory ? path.basename(projectDirectory) : 'saint-expeditus';
          enqueueOnChannel(replyChannel, () =>
            replyChannel.send(`-# 📺 Uploading ${path.basename(filePath)} to YouTube…`),
          ).catch(() => {});

          await attemptYouTubeUpload(filePath, {
            title: filename.slice(0, 100),
            description: `Source: ${filePath}\nProject: ${projectName}\nUploaded: ${new Date().toISOString()}`,
            privacy: 'unlisted',
            project: projectName,
          }, md5, replyChannel);
        } catch (err) {
          // isYouTubeConfigured/findExistingByContent itself threw (fs/hash error before we
          // even reach the retryable upload step) — nothing to hand a 📺 retry, just report it.
          const msg = ((err as Error).message + causeSuffix(err)).slice(0, 250);
          console.warn(`[Discord] YouTube upload precheck failed for ${filePath}: ${msg}`);
          enqueueOnChannel(replyChannel, () =>
            replyChannel.send(`-# 📺 ⚠️ YouTube upload failed for ${path.basename(filePath)}: ${msg}`),
          ).catch(() => {});
        }
      })();
    }
  };

  /** Upload detected video paths to Facebook + Instagram (if ≤90s). Per-request dedup via Set. */
  const metaUploadAttempts = new Set<string>();
  const tryMetaUpload = (text: string) => {
    const filePaths = extractVideoPaths(text, projectDirectory);
    for (const filePath of filePaths) {
      if (metaUploadAttempts.has(filePath)) continue;
      if (!fs.existsSync(filePath)) continue;
      metaUploadAttempts.add(filePath);

      (async () => {
        try {
          if (!(await isMetaConfigured())) return; // silently skip if not configured
          const filename = path.basename(filePath, path.extname(filePath));
          const projectName = projectDirectory ? path.basename(projectDirectory) : 'saint-expeditus';
          const duration = getVideoDurationSync(filePath);
          const igEligible = duration !== null && duration <= INSTAGRAM_MAX_DURATION_S;

          enqueueOnChannel(replyChannel, () =>
            replyChannel.send(`-# 📘 Uploading ${path.basename(filePath)} to Facebook${igEligible ? ' + Instagram' : ''}…`),
          ).catch(() => {});

          const result = await uploadToMeta(filePath, {
            title: filename.slice(0, 100),
            description: `Source: ${filePath}\nProject: ${projectName}\nUploaded: ${new Date().toISOString()}`,
            project: projectName,
          });

          const parts: string[] = [];
          if (result.facebookUrl) parts.push(`📘 ${result.facebookUrl}`);
          if (result.instagramUrl) parts.push(`📸 ${result.instagramUrl}`);
          if (result.instagramSkipped && result.instagramSkipReason) {
            parts.push(`📸 Skipped Instagram — ${result.instagramSkipReason}`);
          }
          if (parts.length > 0) {
            enqueueOnChannel(replyChannel, () =>
              replyChannel.send(`-# ${parts.join('  ·  ')}`),
            ).catch(() => {});
          }
        } catch (err) {
          const msg = (err as Error).message.slice(0, 250);
          console.warn(`[Discord] Meta upload failed for ${filePath}: ${msg}`);
          enqueueOnChannel(replyChannel, () =>
            replyChannel.send(`-# 📘 ⚠️ Meta upload failed for ${path.basename(filePath)}: ${msg}`),
          ).catch(() => {});
        }
      })();
    }
  };

  /**
   * If this turn referenced an .mp4 but no absolute path was ever extractable, fire ONE
   * follow-up prompt into the SAME session (a fresh `/<slug>` request `--resume`s it) asking
   * it to restate the full absolute path so the uploader can catch it. Loop-guarded per slug.
   * Only applies to project sessions (skips the 'xp' expeditus bot, which doesn't render).
   */
  const maybeRepromptForVideoPath = () => {
    if (!slug || slug === 'xp') return;
    if (!sawVideoMention || sawExtractablePath) {
      // Nothing to chase, or we already got a usable path → clear the guard so a future
      // genuine render in this session can be reprompted again.
      videoPathRepromptAttempts.delete(slug);
      return;
    }
    const attempts = videoPathRepromptAttempts.get(slug) ?? 0;
    if (attempts >= MAX_VIDEO_PATH_REPROMPTS) {
      console.log(`[Discord] video-path reprompt cap reached for /${slug}; not asking again`);
      return;
    }
    videoPathRepromptAttempts.set(slug, attempts + 1);

    enqueueOnChannel(replyChannel, () =>
      replyChannel.send('-# 🔁 No absolute video path detected — asking the session to confirm the render path…'),
    ).catch(() => {});

    const followup =
      `/${slug} ⚙️ Auto-check: your last message referenced an .mp4 file but not as a full absolute path, ` +
      `so the auto-uploader couldn't detect it. If you rendered or produced a video, reply with ONLY its full ` +
      `absolute path (e.g. /Users/you/project/output.mp4) on its own line. If no video was produced, reply "no video".`;

    // Fire-and-forget a fresh turn — it resumes the same session and its own onMessage
    // scan will pick up whatever absolute path the session returns.
    sendBridgeRequest(followup, sender, replyChannel, [], slug).catch(err =>
      console.warn(`[Discord] video-path reprompt failed for /${slug}: ${(err as Error).message}`),
    );
  };

  // Tracks all subagents currently active (parent text clears the set).
  // Claude CLI doesn't correlate tool events to specific subagents, so when
  // multiple are in flight, tool calls get tagged with the full set `[A|B|C]`.
  const activeAgents = new Set<string>(); // scoped per-request

  // Paths (from localPaths, below) that a tool call actually referenced this turn — via
  // onToolUse detail text, which covers Read plus any tool that copies/moves/inspects the
  // file (Bash cp, ffmpeg, etc.), and covers subagent-issued calls too (comment above
  // activeAgents: tool events aren't attributable to a specific subagent, but they DO still
  // arrive here). Referenced attachments survive the end-of-turn cleanup below instead of
  // being unconditionally unlinked — otherwise a file Read in turn N is gone before a
  // same-turn or next-turn tool call can act on it (real incident: Aug 3 2026, an image was
  // Read successfully then deleted before ffmpeg could use it in the very next message).
  const referencedAttachments = new Set<string>(); // scoped per-request

  // True when askBridgeStream's response was just a "For later:" park ack — no real turn
  // ran, so `referencedAttachments` being empty means nothing yet, not "nothing needed
  // this attachment" (see StreamResult.parked doc comment in bridge-client.ts).
  let wasParked = false;

  // Download attachments and append local paths so Claude can Read them
  let fullMessage = originalMessage;
  let localPaths: string[] = [];
  if (attachmentUrls.length > 0) {
    localPaths = await downloadAttachments(attachmentUrls);
    if (localPaths.length > 0) {
      const attachmentText = localPaths.map(p => `[Attached file: ${p}]`).join('\n');
      fullMessage = `${originalMessage}\n\n${attachmentText}\n\nUse the Read tool to view attached files.`;
    }
  }

  try {
    const streamResult = await askBridgeStream(
      {
        trigger: {
          type: 'inline',
          query: fullMessage.replace(/^\/[a-z0-9-]+\s*/i, '') || null,
          sender,
          replyTo: null,
          originalMessage: fullMessage,
        },
        recentMessages: [],
        repliedToMessage: null,
      },
      {
        onMeta: (meta) => {
          if (meta.projectDirectory) projectDirectory = meta.projectDirectory;
        },
        // Echo the bridge-assembled prompt back so the user can see exactly what Claude
        // receives, including bot-prepended slug, attachment block, and bridge-appended
        // staleness hint + "Use subagents if necessary" hint.
        onFinalPrompt: (text) => echoFinalPrompt(text, replyChannel),
        onMessage: (text) => {
          // Stream all messages in real-time (Claude responses + system notices)
          if (sentMessages.has(text)) return;
          sentMessages.add(text);

          // Parent text message signals all active subagents have returned
          // (Claude waits for parallel subagents to all finish before continuing)
          activeAgents.clear();

          const finalText = requiresUserTag(text) ? `${text} ${userTag}` : text;
          // Structural split: each paragraph / top-level bullet / numbered item / code block
          // becomes its own Discord message so users can copy individual pieces.
          const chunks = splitMessageStructured(finalText);
          // Synchronously enqueue each chunk on the channel queue; the queue serializes
          // them globally so they arrive in order even when other callbacks (onToolUse)
          // also enqueue work concurrently.
          chunks.forEach((chunk, idx) => {
            enqueueOnChannel(replyChannel, async () => {
              const sent = await withRetry(() => replyChannel.send(chunk));
              if (idx === chunks.length - 1) {
                if (slug === 'xp') preReactRestart(sent);
                else if (slug) preReactProjectShortcut(sent, slug);
              }
            }).catch(console.error);
          });
          // Auto-upload any CSV/doc file paths mentioned in the response
          uploadDetectedFiles(text);
          // Auto-upload .mp4 paths to YouTube and Meta (Facebook + Instagram)
          if (/\.mp4\b/i.test(text)) sawVideoMention = true;
          tryYouTubeUpload(text);
          tryMetaUpload(text);
        },
        onToolUse: (name, detail) => {
          const fullDetail = detail || '';
          const raw = fullDetail.slice(0, 1500);

          // Mark any downloaded attachment this tool call touched so end-of-turn cleanup
          // spares it. Plain substring match (not tool-specific parsing) so it catches every
          // way a path can surface — Read's file_path arg, a Bash command that cp's/ffmpeg's
          // it, etc. — without needing to know each tool's detail schema.
          if (localPaths.length > 0 && fullDetail) {
            for (const p of localPaths) {
              if (fullDetail.includes(p)) referencedAttachments.add(p);
            }
          }

          // Scan file-relevant tool details for upload paths; delay so disk writes flush first
          if (UPLOAD_SCAN_TOOLS.has(name)) {
            setTimeout(() => {
              uploadDetectedFiles(fullDetail);
              tryYouTubeUpload(fullDetail);
              tryMetaUpload(fullDetail);
              // Auto-upload images PRODUCED by this tool (cp, magick, sips, Write, etc.). The
              // Read branch only covers images opened for viewing; a created/copied image
              // would otherwise never reach Discord. Byte-identical twins (e.g. `cp a.png b.png`)
              // collapse to one upload via the MD5 dedup inside uploadImageIfNew.
              for (const imgPath of extractImagePaths(fullDetail, projectDirectory)) {
                uploadImageIfNew(imgPath, replyChannel, `🖼️ ${agentTag}${name} `);
              }
            }, 800);
          }

          // Track subagent spawning — assign a CJK historical name
          if (name === 'Agent') {
            const agentName = assignAgentName();
            activeAgents.add(agentName);
            const nameLink = `[**${agentName}**](https://www.google.com/search?q=Who+is+${encodeURIComponent(agentName)}%3F+Result+in+English.)`;
            const parallelTag = activeAgents.size > 1 ? ` (${activeAgents.size} parallel)` : '';
            try {
              const input = JSON.parse(detail);
              const desc = input.description || 'task';
              // Show the full prompt (no truncation). Each prompt line is prefixed with -# so
              // the whole block renders as Discord subtext. If the result exceeds 2000 chars,
              // splitMessage chunks it across messages.
              const promptBody = input.prompt
                ? '\n' + String(input.prompt).split('\n').map((l: string) => `-# └ ${l}`).join('\n')
                : '';
              const full = `-# 🤖 ${nameLink} spawned${parallelTag}: ${desc}${promptBody}`;
              for (const chunk of splitMessage(full)) {
                enqueueOnChannel(replyChannel, () => withRetry(() => replyChannel.send(chunk))).catch(console.error);
              }
            } catch {
              enqueueOnChannel(replyChannel, () => replyChannel.send(`-# 🤖 ${nameLink} spawned${parallelTag}`)).catch(console.error);
            }
            return;
          }

          // Build tool prefix with agent names — honest tag: `[A|B|C] ` when parallel
          const agentTag = activeAgents.size > 0 ? `[${[...activeAgents].join('|')}] ` : '';

          if (name === 'TodoWrite') {
            try {
              const todos = JSON.parse(fullDetail).todos as { content: string; status: string }[];
              if (Array.isArray(todos) && todos.length > 0) {
                const completed = todos.filter(t => t.status === 'completed').length;
                const inProgress = todos.filter(t => t.status === 'in_progress').length;
                const total = todos.length;
                const pct = Math.round((completed / total) * 100);
                const barWidth = 12;
                const filled = Math.round((completed / total) * barWidth);
                const active = Math.round((inProgress / total) * barWidth);
                const progressBar = '▓'.repeat(filled) + '▒'.repeat(Math.min(active, barWidth - filled)) + '░'.repeat(Math.max(0, barWidth - filled - active));

                const header = `📋 **Tasks** ${progressBar} ${completed}/${total} done (${pct}%)${inProgress ? ` · ${inProgress} active` : ''}\n`;
                let body = '';
                let hidden = 0;
                for (const t of todos) {
                  const icon = STATUS_ICON[t.status] ?? '⬜';
                  const text = t.status === 'completed' ? `~~${t.content}~~` : t.content;
                  const line = `${icon} ${text}\n`;
                  if (header.length + body.length + line.length > 1950) { hidden++; continue; }
                  body += line;
                }
                const suffix = hidden > 0 ? `-# _+${hidden} more_` : '';
                const todoMsg = (header + body.trimEnd() + (suffix ? '\n' + suffix : '')).slice(0, 2000);
                enqueueOnChannel(replyChannel, () => withRetry(() => replyChannel.send(todoMsg))).catch(console.error);
                return;
              }
            } catch { /* fall through to default */ }
          }

          if (name === 'Read') {
            const filePath = raw.split(':')[0].split('\n')[0].trim();
            if (IMAGE_EXTS.some(ext => filePath.toLowerCase().endsWith(ext)) && fs.existsSync(filePath)) {
              // Read opened an image for viewing → mirror it into the channel (dedup + 8MB
              // downsize handled by the shared helper).
              uploadImageIfNew(filePath, replyChannel, `🔧 ${agentTag}${name} `);
              return;
            }
          }

          // AskUserQuestion: render as a proper question + numbered options block,
          // not the raw JSON payload. Each question gets its own message.
          if (name === 'AskUserQuestion') {
            try {
              const input = JSON.parse(fullDetail);
              const questions = Array.isArray(input.questions) ? input.questions : [];
              if (questions.length > 0) {
                for (const q of questions) {
                  const lines: string[] = [];
                  const header = q.header || 'Question';
                  const multi = q.multiSelect ? ' _(multi-select)_' : '';
                  lines.push(`❓ **${header}**${multi}`);
                  if (q.question) {
                    for (const ql of String(q.question).split('\n')) {
                      lines.push(`> ${ql}`);
                    }
                  }
                  const options = Array.isArray(q.options) ? q.options : [];
                  for (let i = 0; i < options.length; i++) {
                    const opt = options[i] ?? {};
                    const label = opt.label || `Option ${i + 1}`;
                    const desc = opt.description ? ` — ${opt.description}` : '';
                    lines.push(`${i + 1}. **${label}**${desc}`);
                  }
                  const hint = q.multiSelect
                    ? '-# Reply with option numbers separated by commas (e.g. 1, 3)'
                    : '-# Reply with the option number or text';
                  lines.push(hint);
                  const blockText = lines.join('\n');
                  for (const chunk of splitMessage(blockText)) {
                    enqueueOnChannel(replyChannel, () => withRetry(() => replyChannel.send(chunk))).catch(console.error);
                  }
                }
                return;
              }
            } catch { /* fall through to default tool render */ }
          }


          if (raw.includes('```')) {
            const codeStart = raw.indexOf('```');
            const header = raw.slice(0, codeStart).trim();
            const codeBlock = raw.slice(codeStart).slice(0, 1900);
            enqueueOnChannel(replyChannel, () => replyChannel.send(`-# 🔧 ${agentTag}${name} ${header}`)).catch(console.error);
            enqueueOnChannel(replyChannel, () => replyChannel.send(codeBlock)).catch(console.error);
          } else {
            const msg = `-# 🔧 ${agentTag}${name} ${raw.replace(/\n/g, ' ')}`.slice(0, 2000);
            enqueueOnChannel(replyChannel, () => replyChannel.send(msg)).catch(console.error);
          }
        },
      },
    );

    wasParked = streamResult.parked;

    // Fall back to projectDirectory from done event if meta event didn't fire
    if (!projectDirectory && streamResult.projectDirectory) projectDirectory = streamResult.projectDirectory;
    // Also scan the final response for file paths (covers singleShot case)
    if (streamResult.response) {
      if (/\.mp4\b/i.test(streamResult.response)) sawVideoMention = true;
      uploadDetectedFiles(streamResult.response);
      tryYouTubeUpload(streamResult.response);
      tryMetaUpload(streamResult.response);
    }

    // If a video was mentioned but no absolute path was ever extractable, reprompt the
    // session once for the full path. Delayed past the 800ms onToolUse scan window so a
    // late tool-detail extraction can still set `sawExtractablePath` and cancel the ask.
    setTimeout(maybeRepromptForVideoPath, 1200);

    // Show context + budget footer after response
    try {
      const ctxPct = streamResult.contextUsedPct;
      const budget = await fetchBudget();

      const footerParts: string[] = [];

      // Context usage line
      if (ctxPct != null) {
        const ctxBar = budgetBar(ctxPct, 100);
        const ctxWarn = ctxPct >= 80 ? ' ⚠️' : ctxPct >= 60 ? ' ⚡' : '';
        footerParts.push(`-# ${ctxBar} context ${ctxPct}% used${ctxWarn}`);
      }

      // Budget line
      if (budget && !budget.unlimited) {
        const bar = budgetBar(budget.usedThisHour, budget.hourlyLimit);
        const upPct = budget.upstream.usagePercent;
        const upWarn = upPct >= 80 ? ' ⚠️' : upPct >= 50 ? ' ⚡' : '';
        footerParts.push(`-# ${bar} ${budget.remainingThisHour}/${budget.hourlyLimit} left this hour · upstream ${upPct}%${upWarn}`);
      }

      if (footerParts.length > 0) {
        // Queue so the footer always lands AFTER response/tool messages even when those are still draining
        enqueueOnChannel(replyChannel, () => withRetry(() => replyChannel.send(footerParts.join('\n')))).catch(() => {});
      }
    } catch {
      // Footer failure is non-critical — don't surface to user
    }
  } finally {
    clearInterval(typingInterval);
    // Clean up downloaded attachment temp files — except ones a tool call actually
    // referenced this turn (see `referencedAttachments` above), and except ALL of them when
    // this call only parked a "For later:" task (`wasParked`): no query ran, so nothing could
    // have referenced anything yet, but the real deferred turn happens later in an unrelated
    // sendBridgeRequest call that has no idea this attachment exists. Leave parked-call
    // attachments for sweepStaleAttachments()'s 24h reaper instead of deleting them out from
    // under a turn that hasn't happened yet.
    if (!wasParked) {
      await Promise.allSettled(
        localPaths
          .filter(p => !referencedAttachments.has(p))
          .map(p =>
            fs.promises.unlink(p).catch(err => console.error(`[Discord] Failed to delete attachment ${p}: ${err.message}`)),
          ),
      );
    }
  }
}

function budgetBar(used: number, total: number): string {
  const width = 10;
  const filled = Math.min(width, Math.max(0, Math.round((used / total) * width)));
  const empty = width - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

/**
 * If the user used Discord's "Reply" feature, fetch the referenced message and format it
 * as a quoted-context block. Returns empty string when there's no reply or fetch fails.
 *
 * Format:  `[Re: Author]\n> line1\n> line2\n\n`
 *
 * Subtext prefixes (`-# `) on bot messages are stripped so the context isn't visually
 * cluttered. Long references are truncated. Empty / file-only references return ''.
 */
async function buildReferencedContext(message: Message): Promise<string> {
  if (!message.reference?.messageId) return '';
  try {
    const ref = await message.fetchReference();
    if (!ref) return '';
    let content = (ref.content || '').trim();
    if (!content) return '';
    // Strip Discord subtext prefixes for cleaner quoted context
    content = content.split('\n').map(l => l.replace(/^-#\s/, '')).join('\n');
    const MAX = 1500;
    if (content.length > MAX) content = content.slice(0, MAX) + '\n…[truncated]';
    const author = ref.author.bot ? 'Assistant' : `${ref.author.displayName ?? ref.author.username} (${ref.author.id})`;
    const quoted = content.split('\n').map(l => `> ${l}`).join('\n');
    return `[Re: ${author}]\n${quoted}\n\n`;
  } catch (err) {
    console.warn('[Discord] Could not fetch referenced message:', (err as Error).message);
    return '';
  }
}

/**
 * Inject quoted-reference context into a slash-command message between the command and
 * its body, e.g. `/xp foo` → `/xp [Re: Assistant]\n> bar\n\nfoo`. If the message is a
 * bare command (no body — `/list`, `/compact`) the reference is dropped since there's
 * no body to attach context to.
 */
function injectReferencedContext(originalMessage: string, refContext: string): string {
  if (!refContext) return originalMessage;
  const m = originalMessage.match(/^(\/[a-z0-9-]+)(\s+)([\s\S]+)$/i);
  if (!m) return originalMessage; // bare command — no body to inject into
  return `${m[1]} ${refContext}${m[3]}`;
}

async function handleBridgeError(err: unknown, replyChannel: TextChannel | ThreadChannel, context: string): Promise<void> {
  const msg = (err as Error).message;
  // Deliberate 🛑 force-stop — the user already knows why the turn ended and got a
  // confirmation from the reaction handler, so this is a quiet full stop, not an error.
  // Checked before the generic abort branch below, which would mislabel it "Interrupted".
  // `.includes`, not `.startsWith` — the bridge may prefix the message on its way out
  // (e.g. a command-router wrapper), and this branch must still win over the generic one.
  if (msg.includes(STOPPED_BY_USER_PREFIX)) {
    console.log(`[Discord] ${context}: force-stopped by user 🛑`);
    await enqueueOnChannel(replyChannel, () => withRetry(() => replyChannel.send(`-# 🛑 Stopped.`))).catch(() => {});
    return;
  }
  // Queue the error reply so it lands AFTER any in-flight streaming sends rather than
  // racing them when an abort fires mid-stream.
  if (msg.includes('aborted') || msg.includes('abort') || msg.includes('killed') || msg.includes('SIGTERM')) {
    console.log(`[Discord] ${context}: interrupted by new message`);
    await enqueueOnChannel(replyChannel, () => withRetry(() => replyChannel.send(`-# ⏹️ Interrupted`))).catch(() => {});
    return;
  }

  // undici raises a bare "terminated" when the underlying socket is reset mid-stream, or
  // throws `TypeError: fetch failed` with the real reason nested on `.cause.code` (never in
  // `.message`) — most often because the bridge process restarted (pm2/tsx watch) while a
  // long-running request was streaming. Map it (and adjacent socket-reset codes) to an
  // explicit "bridge dropped the connection" hint. Match `msg === 'fetch failed'` (exact,
  // not `.includes`) — undici's message is always exactly that string, and an exact match
  // can't be spoofed by unrelated error text that merely contains the substring "fetch
  // failed" (e.g. a prompt echoing a YouTube upload failure back through some other path).
  const causeCode = (() => {
    const cause = (err as { cause?: unknown } | null | undefined)?.cause;
    return cause && typeof cause === 'object' ? String((cause as { code?: unknown }).code ?? '') : '';
  })();
  const isConnDrop =
    msg === 'terminated' ||
    /\bterminated\b/.test(msg) ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('socket hang up') ||
    msg.includes('UND_ERR_SOCKET') ||
    msg === 'fetch failed' ||
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET';
  if (isConnDrop) {
    const detail = (msg + causeSuffix(err)).slice(0, 80);
    console.warn(`[Discord] ${context}: bridge connection dropped — ${detail}`);
    await enqueueOnChannel(replyChannel, () =>
      withRetry(() => replyChannel.send(
        `-# 🔌 Bridge connection dropped (\`${detail}\`) — the server likely restarted mid-stream. Any in-flight tool calls (renders, builds, watchers) may have been interrupted; retry when the bridge is back.`,
      )),
    ).catch(() => {});
    return;
  }

  // Log the full shape, not just .message. A discord.js error's message is a bare
  // "Internal Server Error" that reads as a bridge fault while actually being Discord's
  // own 500 — the code/status/url are the only way to tell the two apart.
  console.error(`[Discord] ${context}: ${describeError(err)}`);
  await enqueueOnChannel(replyChannel, () => withRetry(() => replyChannel.send(`-# ⚠️ ${msg.slice(0, 150)}`))).catch(() => {});
}

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (ALLOWED_USER_IDS.size > 0 && !ALLOWED_USER_IDS.has(message.author.id)) return; // allowlist
  // Top-level guard: Discord.js doesn't catch async listener rejections
  try {

  const sender = `${message.author.displayName || message.author.username} (${message.author.id})`;
  const text = message.content.trim();

  // Extract attachment URLs (images, files)
  const attachmentUrls = [...message.attachments.values()].map(a => a.url);
  if (attachmentUrls.length > 0) {
    console.log(`[Discord] ${attachmentUrls.length} attachment(s): ${attachmentUrls.map(u => u.split('/').pop()).join(', ')}`);
  }

  // If the user used Discord's Reply feature, fetch the referenced message so we can
  // prepend it as quoted context to the prompt. Empty string when no reply.
  const refContext = await buildReferencedContext(message);
  if (refContext) {
    console.log(`[Discord] reply-ref: ${refContext.split('\n')[0]} (${refContext.length} chars)`);
  }

  // --- Messages inside a project thread (no prefix needed) ---
  if (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread) {
    const thread = message.channel as ThreadChannel;
    const slug = threadToSlug.get(thread.id) || threadNameToSlug(thread.name);

    console.log(`[Discord] /${slug} "${text.slice(0, 60)}"`);

    if (slug && THREAD_COMMANDS.has(slug)) {
      ackSeen(message);
      if (!threadToSlug.has(thread.id)) {
        threadToSlug.set(thread.id, slug);
        slugToThread.set(slug, thread.id);
      }
      const baseMessage = text.startsWith('/') ? text : `/${slug} ${text}`;
      const originalMessage = injectReferencedContext(baseMessage, refContext);
      try {
        await sendBridgeRequest(originalMessage, sender, thread, attachmentUrls);

        // After register, create threads for new projects
        if (slug === 'register') {
          await refreshPrefixes();
          if (CHANNEL_ID) {
            const mainChannel = await client.channels.fetch(CHANNEL_ID);
            if (mainChannel?.type === ChannelType.GuildText) {
              for (const s of knownSlugs) {
                if (!slugToThread.has(s)) {
                  await findOrCreateThread(mainChannel as TextChannel, s);
                }
              }
            }
          }
        }
      } catch (err) {
        await handleBridgeError(err, thread, `/${slug} (command thread)`);
      }
      return;
    }

    if (slug && knownSlugs.has(slug)) {
      ackSeen(message);
      // Cache mapping if not already
      if (!threadToSlug.has(thread.id)) {
        threadToSlug.set(thread.id, slug);
        slugToThread.set(slug, thread.id);
      }

      // "hold on" — user is still typing; extend debounce to 60s without adding content
      if (HOLD_ON_RE.test(text)) {
        message.react('⏳').catch(() => {});
        bufferMessage(thread.id, null, [], sender, thread, slug);
        return;
      }

      let originalMessage = text.startsWith('/') ? text : `/${slug} ${text}`;
      // Allow /compact and /nudge (no args) inside a project thread to target that project
      if (/^\/compact\s*$/i.test(originalMessage)) originalMessage = `/compact ${slug}`;
      if (/^\/nudge\s*$/i.test(originalMessage)) originalMessage = `/nudge ${slug}`;
      // Inject reply-ref context (between the slash command and the body) if user used Discord Reply
      originalMessage = injectReferencedContext(originalMessage, refContext);

      // Subsequent messages in an existing buffer: append raw text (no /slug prefix)
      const isAppending = messageBuffers.has(thread.id);
      // A lone "!" is a pure flush trigger — pass it through raw so bufferMessage recognizes it
      // (LONE_BANG_RE) rather than the slug-prefixed form, which would spuriously send an empty
      // buffer as its own turn. With nothing buffered, bufferMessage ignores it.
      const textPart = LONE_BANG_RE.test(text)
        ? '!'
        : (isAppending ? injectReferencedContext(text, refContext) : originalMessage);
      bufferMessage(thread.id, textPart, attachmentUrls, sender, thread, slug);
      return;
    }
  }

  // --- Messages in the main channel ---
  if (message.channel.type !== ChannelType.GuildText) return;
  if (CHANNEL_ID && message.channelId !== CHANNEL_ID) return;
  if (!text.startsWith('/')) return;

  const parsed = parseCommand(text);
  // Discord-only commands bypass bridge prefix check (see DISCORD_ONLY_COMMANDS at module scope)
  if (!parsed || (!isKnownPrefix(parsed.command) && !DISCORD_ONLY_COMMANDS.has(parsed.command))) return;

  ackSeen(message);

  const channel = message.channel as TextChannel;

  try {
    // /budget handled locally — no bridge call needed
    if (parsed.command === 'budget') {
      const budget = await fetchBudget();
      if (!budget) {
        await withRetry(() => channel.send('-# ⚠️ Budget info unavailable (bridge not connected)')).catch(() => {});
      } else if (budget.unlimited) {
        await withRetry(() => channel.send('**Budget:** unlimited (SESSION_LIMIT not set)')).catch(() => {});
      } else {
        const bar = budgetBar(budget.usedThisHour, budget.hourlyLimit);
        const upPct = budget.upstream.usagePercent;
        const upWarn = upPct >= 80 ? ' ⚠️' : upPct >= 50 ? ' ⚡' : '';
        const lines = [
          `**Budget — Hour ${budget.currentHour}**`,
          `${bar} ${budget.usedThisHour}/${budget.hourlyLimit} used · ${budget.remainingThisHour} remaining`,
          `-# Upstream: ${budget.upstream.windowCount}/${budget.upstream.estimatedUpstreamLimit} in 5hr window (${upPct}%${upWarn}) · resets in ~${budget.upstream.windowMinutesLeft}m`,
        ];
        await withRetry(() => channel.send(lines.join('\n'))).catch(() => {});
      }
      return;
    }

    // Inject reply-ref context (no-op when refContext is empty or message is bare command)
    const enrichedText = injectReferencedContext(text, refContext);

    // Global commands: respond in the main channel
    if (GLOBAL_COMMANDS.has(parsed.command)) {
      await sendBridgeRequest(enrichedText, sender, channel, attachmentUrls);

      // After /register, refresh slugs and create any new threads
      if (parsed.command === 'register') {
        await refreshPrefixes();
        for (const slug of knownSlugs) {
          if (!slugToThread.has(slug)) {
            await findOrCreateThread(channel, slug);
          }
        }
      }
      return;
    }

    // /nudge <slug> and /compact <slug> from main channel → route to project thread
    if ((parsed.command === 'nudge' || parsed.command === 'compact') && parsed.args) {
      const targetSlug = parsed.args.trim().split(/\s/)[0].toLowerCase();
      if (knownSlugs.has(targetSlug)) {
        const thread = await findOrCreateThread(channel, targetSlug);
        await sendBridgeRequest(enrichedText, sender, thread, attachmentUrls);
        return;
      }
    }

    // Project commands: create/find thread and respond there (with input debounce)
    if (knownSlugs.has(parsed.command)) {
      const thread = await findOrCreateThread(channel, parsed.command);
      const slug = parsed.command;
      // "hold on" from main channel (e.g. "/villa hold on") — extend debounce
      if (parsed.args && HOLD_ON_RE.test(parsed.args.trim())) {
        message.react('⏳').catch(() => {});
        bufferMessage(thread.id, null, [], sender, thread, slug);
        return;
      }
      const isAppending = messageBuffers.has(thread.id);
      // A lone "!" (as the command args) is a pure flush trigger — pass raw so bufferMessage
      // treats it as a bare bang rather than the slug-prefixed form (which would spuriously send).
      const textPart = LONE_BANG_RE.test((parsed.args ?? '').trim())
        ? '!'
        : (isAppending ? (parsed.args ?? enrichedText) : enrichedText);
      bufferMessage(thread.id, textPart, attachmentUrls, sender, thread, slug);
      return;
    }

    // Fallback: respond in channel
    await sendBridgeRequest(text, sender, channel);
  } catch (err) {
    await handleBridgeError(err, channel, 'main channel');
  }
  } catch (err) {
    console.error('[Discord] Unhandled error in MessageCreate handler:', (err as Error).message);
  }
});

// Reaction-triggered shortcuts on bot messages:
//   🔄 → pm2 restart all (global)
//   📅 → villa.py list (project-scoped via PROJECT_SHELL_SHORTCUTS)
//   👀 👍 ❌ ⭐ 🔧 → send the corresponding text to the bridge session for the thread's slug
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  // Ignore the bot's own pre-react
  if (user.bot) return;
  if (ALLOWED_USER_IDS.size > 0 && !ALLOWED_USER_IDS.has(user.id)) return; // allowlist

  try {
    // Resolve partials (reactions/messages may be incomplete if posted before bot started)
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const emojiName = reaction.emoji.name;

    // 🛑 force-stop is handled BEFORE the bot-authored check below: when a turn is
    // running away, the most recent message in the thread is usually the user's own
    // prompt, and making them scroll to find a bot message to react to defeats the
    // point of a panic button. Every other shortcut stays bot-messages-only.
    if (emojiName === STOP_EMOJI) {
      const msgChannel = reaction.message.channel;
      if (
        msgChannel.type !== ChannelType.GuildText &&
        msgChannel.type !== ChannelType.PublicThread &&
        msgChannel.type !== ChannelType.PrivateThread
      ) {
        console.warn(`[Discord] ${STOP_EMOJI} stop: unsupported channel type ${msgChannel.type}, skipping`);
        return;
      }
      const replyChannel = msgChannel as TextChannel | ThreadChannel;
      // Same slug resolution as the shortcut path: project thread → its slug, main channel → xp
      let slug = 'xp';
      if (
        msgChannel.type === ChannelType.PublicThread ||
        msgChannel.type === ChannelType.PrivateThread
      ) {
        const thread = msgChannel as ThreadChannel;
        slug = threadToSlug.get(thread.id) || threadNameToSlug(thread.name) || 'xp';
      }

      console.log(`[Discord] ${STOP_EMOJI} stop requested by ${user.tag ?? user.id} → /${slug}`);
      // Cancel any pending debounced input for this channel too — otherwise a message
      // still sitting in the buffer would fire off a brand-new turn moments after the
      // user hit the panic button, which reads as "the stop didn't work".
      const dropped = cancelPendingInput(replyChannel.id);

      try {
        const result = await stopBridgeSession(slug);
        const droppedNote = dropped > 0 ? ` · dropped ${dropped} queued message${dropped === 1 ? '' : 's'}` : '';
        // Report the "nothing was running" case too — silence there is indistinguishable
        // from "the reaction didn't register", which is the worst thing a panic button
        // can be ambiguous about. Note the session itself survives: next message resumes.
        await replyChannel.send(`-# ${STOP_EMOJI} ${result.reason}${droppedNote}`).catch(() => {});
      } catch (err) {
        console.error(`[Discord] ${STOP_EMOJI} stop failed:`, describeError(err));
        await replyChannel.send(`-# ${STOP_EMOJI} Stop failed — couldn't reach the bridge (\`${(err as Error).message.slice(0, 80)}\`).`).catch(() => {});
      }
      return;
    }

    // 🆘 emergency reset — same "before the bot-authored check" placement and rationale
    // as 🛑 above: the point is to react on whatever message is in front of you, usually
    // your own, without hunting for a bot message.
    if (emojiName === EMERGENCY_RESET_EMOJI) {
      const msgChannel = reaction.message.channel;
      if (
        msgChannel.type !== ChannelType.GuildText &&
        msgChannel.type !== ChannelType.PublicThread &&
        msgChannel.type !== ChannelType.PrivateThread
      ) {
        console.warn(`[Discord] ${EMERGENCY_RESET_EMOJI} emergency-reset: unsupported channel type ${msgChannel.type}, skipping`);
        return;
      }
      const replyChannel = msgChannel as TextChannel | ThreadChannel;
      let slug = 'xp';
      if (
        msgChannel.type === ChannelType.PublicThread ||
        msgChannel.type === ChannelType.PrivateThread
      ) {
        const thread = msgChannel as ThreadChannel;
        slug = threadToSlug.get(thread.id) || threadNameToSlug(thread.name) || 'xp';
      }

      console.warn(`[Discord] ${EMERGENCY_RESET_EMOJI} EMERGENCY RESET requested by ${user.tag ?? user.id} → /${slug}`);
      // Same reasoning as 🛑: a buffered-but-unsent message would otherwise fire a turn
      // on the brand-new session moments after the reset, looking like the reset failed.
      const dropped = cancelPendingInput(replyChannel.id);

      try {
        const result = await emergencyResetSession(slug);
        const droppedNote = dropped > 0 ? ` · dropped ${dropped} queued message${dropped === 1 ? '' : 's'}` : '';
        await replyChannel.send(
          `-# ${EMERGENCY_RESET_EMOJI} Force-reset /${slug} — ${result.stopReason}; session wiped, next message starts completely fresh${droppedNote}`,
        ).catch(() => {});
      } catch (err) {
        console.error(`[Discord] ${EMERGENCY_RESET_EMOJI} emergency-reset failed:`, describeError(err));
        await replyChannel.send(`-# ${EMERGENCY_RESET_EMOJI} Emergency reset failed — couldn't reach the bridge (\`${(err as Error).message.slice(0, 80)}\`).`).catch(() => {});
      }
      return;
    }

    // Only honor reactions on messages the bot itself posted
    if (reaction.message.author?.id !== client.user?.id) return;

    if (emojiName === YOUTUBE_RETRY_EMOJI) {
      const msg = reaction.message;
      const payload = youtubeRetryPayloads.get(msg.id);
      if (!payload) return; // 📺 on some other bot message — not a known upload failure, ignore

      const msgChannel = msg.channel;
      if (
        msgChannel.type !== ChannelType.GuildText &&
        msgChannel.type !== ChannelType.PublicThread &&
        msgChannel.type !== ChannelType.PrivateThread
      ) {
        console.warn(`[Discord] ${YOUTUBE_RETRY_EMOJI} retry: unsupported channel type ${msgChannel.type}, skipping`);
        return;
      }
      const replyChannel = msgChannel as TextChannel | ThreadChannel;
      // Consumed synchronously (before any await) so two rapid reacts can't both retry —
      // attemptYouTubeUpload re-adds a fresh entry under the NEW failure message if it fails again.
      youtubeRetryPayloads.delete(msg.id);
      console.log(`[Discord] ${YOUTUBE_RETRY_EMOJI} YouTube retry requested by ${user.tag ?? user.id} for ${payload.filePath}`);

      if (!fs.existsSync(payload.filePath)) {
        replyChannel.send(`-# 📺 ⚠️ Can't retry — ${path.basename(payload.filePath)} no longer exists on disk.`).catch(() => {});
        return;
      }

      try {
        // Re-check the ledger — the video may have been uploaded via some other path
        // (or a previous retry that succeeded but whose ✅ got missed) since this failed.
        const { md5, existing } = await findExistingByContent(payload.filePath);
        if (existing) {
          replyChannel.send(`-# 📺 Already uploaded — ${existing.url}`).catch(() => {});
          return;
        }
        enqueueOnChannel(replyChannel, () =>
          replyChannel.send(`-# 📺 Retrying upload of ${path.basename(payload.filePath)}…`),
        ).catch(() => {});
        await attemptYouTubeUpload(payload.filePath, payload.opts, md5, replyChannel);
      } catch (err) {
        const msgText = ((err as Error).message + causeSuffix(err)).slice(0, 250);
        console.warn(`[Discord] YouTube retry precheck failed for ${payload.filePath}: ${msgText}`);
        replyChannel.send(`-# 📺 ⚠️ Retry failed for ${path.basename(payload.filePath)}: ${msgText}`).catch(() => {});
      }
      return;
    }

    if (emojiName === RESTART_EMOJI) {
      const msg = reaction.message;
      console.log(`[Discord] 🔄 restart reaction received from ${user.tag ?? user.id} on message ${msg.id}`);

      // Confirm to user before pm2 kills this process
      await msg.reply('🔁 **pm2 restart all** triggered — restarting all services now…');

      exec('pm2 restart all', (err, stdout, stderr) => {
        // Note: if pm2 restarts the discord-bot process, we may die here — that's expected.
        if (err) {
          console.error('[Discord] pm2 restart failed:', err.message);
          msg.reply(`⚠️ pm2 restart failed: ${err.message.slice(0, 200)}`).catch(() => {});
        } else {
          const out = (stdout + stderr).trim().slice(0, 500);
          console.log('[Discord] pm2 restart all complete:', out);
          // Bot may be dead by the time this callback fires — best-effort reply
          msg.reply(`✅ pm2 restart all complete\n${out ? `\`\`\`\n${out}\n\`\`\`` : ''}`).catch(() => {});
        }
      });
      return;
    }

    if (emojiName && emojiName in GAME_SHORTCUTS) {
      const { label, appPath } = GAME_SHORTCUTS[emojiName];
      const msg = reaction.message;
      console.log(`[Discord] ${emojiName} launch ${label} requested by ${user.tag ?? user.id} on message ${msg.id}`);

      exec(`open "${appPath}"`, { timeout: 15_000 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[Discord] launch ${label} failed:`, err.message);
          msg.reply(`⚠️ Couldn't launch ${label}: ${err.message.slice(0, 200)}`).catch(() => {});
        } else {
          const out = (stdout + stderr).trim().slice(0, 300);
          console.log(`[Discord] launched ${label}`);
          msg.reply(`🎮 Launching ${label}…${out ? `\n\`\`\`\n${out}\n\`\`\`` : ''}`).catch(() => {});
        }
      });
      return;
    }

    if (emojiName && emojiName in PROJECT_SHELL_SHORTCUTS) {
      const { slug, cmd, label } = PROJECT_SHELL_SHORTCUTS[emojiName];
      const msg = reaction.message;
      console.log(`[Discord] ${emojiName} ${label} (/${slug}) reaction received from ${user.tag ?? user.id} on message ${msg.id}`);

      await msg.reply(`${emojiName} **${label}** triggered…`);

      exec(cmd, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[Discord] ${label} failed:`, err.message, stderr.slice(-200));
          // Show err.message (exit code / signal) + tail of stderr so transient
          // progress lines don't bury the actual error at the end of stderr.
          const combined = [err.message, stderr.trim()].filter(Boolean).join('\n');
          // Extract https:// URLs (e.g. OAuth auth URLs) so Discord auto-links them.
          // AUTH_REQUIRED:<url> is a sentinel printed by scripts that need re-auth.
          const urlRe = /https:\/\/[^\s"'<>]+/g;
          const urls = [...combined.matchAll(urlRe)].map(m => m[0]);
          const detail = combined.replace(/AUTH_REQUIRED:[^\s]+/g, '').trim().slice(-400);
          let reply = `⚠️ ${label} failed:\n\`\`\`\n${detail}\n\`\`\``;
          if (urls.length > 0) reply += '\n**Action required — open this link:**\n' + urls.join('\n');
          msg.reply(reply).catch(() => {});
          return;
        }
        const out = (stdout + stderr).trim();
        console.log(`[Discord] ${label} complete (${out.length} chars)`);
        if (out) {
          const trimmed = out.slice(0, 1800);
          msg.reply(`\`\`\`\n${trimmed}\n\`\`\``).catch(() => {});
        } else {
          msg.reply(`✅ ${label} complete (no output)`).catch(() => {});
        }
      });
      return;
    }

    if (emojiName === HANDOVER_EMOJI) {
      const sender = `${user.displayName ?? user.tag ?? user.username} (${user.id})`;
      const msgChannel = reaction.message.channel;

      // Handover only makes sense inside a project thread (needs a slug to roll over)
      if (
        msgChannel.type !== ChannelType.PublicThread &&
        msgChannel.type !== ChannelType.PrivateThread
      ) {
        console.warn(`[Discord] ${HANDOVER_EMOJI} handover: only valid in a project thread, skipping`);
        return;
      }

      const thread = msgChannel as ThreadChannel;
      const slug = threadToSlug.get(thread.id) || threadNameToSlug(thread.name) || '';
      // NOTE: 'xp' is NOT excluded here. It used to be, which made ♻️ in the /xp thread
      // report "couldn't resolve a project" — a lie, since the slug resolved fine. The
      // exclusion existed because 'xp' is the fallback slug for the MAIN channel (see the
      // `let slug: string = 'xp'` default below), so "slug === 'xp'" was read as "unresolved".
      // But the ChannelType check above already guarantees we're in a thread by this point,
      // so a thread named "/xp" is a genuine project thread and is safe to roll over —
      // the bridge has no xp special-casing at all and handles /handover xp like any other.
      if (!slug) {
        await thread.send(`-# ${HANDOVER_EMOJI} handover: couldn't resolve a project for this thread.`).catch(() => {});
        return;
      }

      const bridgeMessage = `/handover ${slug}`;
      console.log(`[Discord] ${HANDOVER_EMOJI} handover from ${sender} → /handover ${slug}`);
      thread.send(`-# ${HANDOVER_EMOJI} rolling over /${slug} — writing handoff, resetting, reseeding a fresh session…`).catch(err => {
        console.warn('[Discord] handover confirmation failed:', (err as Error).message);
      });

      try {
        await sendBridgeRequest(bridgeMessage, sender, thread, [], slug);
      } catch (err) {
        await handleBridgeError(err, thread, `handover (/${slug})`);
      }
      return;
    }

    if (emojiName && emojiName in XP_SHORTCUTS) {
      const shortcutText = XP_SHORTCUTS[emojiName];
      const sender = `${user.displayName ?? user.tag ?? user.username} (${user.id})`;
      const msgChannel = reaction.message.channel;

      // Only proceed if the channel can receive messages (text channel or thread)
      if (
        msgChannel.type !== ChannelType.GuildText &&
        msgChannel.type !== ChannelType.PublicThread &&
        msgChannel.type !== ChannelType.PrivateThread
      ) {
        console.warn(`[Discord] shortcut ${emojiName}: unsupported channel type ${msgChannel.type}, skipping`);
        return;
      }

      const replyChannel = msgChannel as TextChannel | ThreadChannel;

      // Derive slug from the thread context (project thread → project slug; main channel → 'xp' default)
      let slug: string = 'xp';
      if (
        msgChannel.type === ChannelType.PublicThread ||
        msgChannel.type === ChannelType.PrivateThread
      ) {
        const thread = msgChannel as ThreadChannel;
        slug = threadToSlug.get(thread.id) || threadNameToSlug(thread.name) || 'xp';
      }

      // Bridge's command-router needs `/<slug> ` prefix to route to the right session
      const bridgeMessage = `/${slug} ${shortcutText}`;
      console.log(`[Discord] shortcut ${emojiName} from ${sender} → /${slug}: "${shortcutText}"`);

      // Brief confirmation so the user sees the click was registered
      replyChannel.send(`-# ${emojiName} sending to /${slug}: "${shortcutText}"`).catch(err => {
        console.warn('[Discord] shortcut confirmation failed:', (err as Error).message);
      });

      try {
        await sendBridgeRequest(bridgeMessage, sender, replyChannel, [], slug);
      } catch (err) {
        await handleBridgeError(err, replyChannel, `shortcut ${emojiName} (/${slug})`);
      }
      return;
    }

    // Unrecognised emoji on a bot message — ignore
  } catch (err) {
    console.error('[Discord] Error in MessageReactionAdd handler:', (err as Error).message);
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[Discord] Logged in as ${c.user.tag}`);

  const healthy = await checkHealth();
  console.log(`[Discord] Bridge: ${healthy ? 'connected' : 'NOT REACHABLE'}`);

  await refreshPrefixes();
  setInterval(refreshPrefixes, 60_000);

  // Create threads for all registered projects + management threads on startup
  if (CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (channel?.type === ChannelType.GuildText) {
        const textChannel = channel as TextChannel;

        // Management threads
        for (const cmd of ['register', 'update']) {
          await findOrCreateThread(textChannel, cmd);
        }

        // Project threads
        for (const slug of knownSlugs) {
          await findOrCreateThread(textChannel, slug);
        }

        console.log(`[Discord] All threads ready`);
      }
    } catch (err) {
      console.warn('[Discord] Failed to create threads:', (err as Error).message);
    }
  }

  // YouTube auth health check — warn in console (and log) if token is dead
  checkYouTubeAuth().then((result) => {
    if (result.ok) {
      console.log(`[Discord] YouTube auth OK (token from ${result.obtainedAt ?? 'unknown'})`);
    } else {
      console.warn(`[Discord] YouTube auth FAILED: ${result.error}`);
      console.warn(`[Discord] Run: npx --prefix discord-bot tsx src/youtube-auth.ts`);
    }
  }).catch(() => {});

  // Meta (Facebook + Instagram) auth health check
  checkMetaAuth().then((result) => {
    if (result.ok) {
      console.log(`[Discord] Meta auth OK (token from ${result.obtainedAt ?? 'unknown'})`);
    } else if (result.error?.includes('credentials missing')) {
      console.log('[Discord] Meta auth not configured — Facebook/Instagram uploads disabled');
    } else {
      console.warn(`[Discord] Meta auth FAILED: ${result.error}`);
      console.warn(`[Discord] Run: npx --prefix discord-bot tsx src/meta-auth.ts`);
    }
  }).catch(() => {});

  // SSE listener for proactive messages (cron auto-decides)
  const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://localhost:3141';
  let sseRetryDelay = 10_000;
  // Serialize SSE event handling. The handler awaits multiple async fetches before
  // enqueuing sends; without this chain a second event arriving during those awaits
  // would race the first handler to the channel queue, producing out-of-order sends.
  let sseChain: Promise<unknown> = Promise.resolve();
  function connectSSE() {
    // Identify as the Discord client: the bridge only fans out proactive messages to
    // clients that positively identify as `discord`, so the Messenger Chrome extension
    // (which sends no identifier) receives nothing. Fail-closed against leaking to Messenger.
    const es = new EventSource(`${BRIDGE_URL}/events?client=discord`);
    es.onopen = () => { sseRetryDelay = 10_000; }; // reset backoff on successful connect
    es.onmessage = (event: MessageEvent) => {
      sseChain = sseChain.catch(() => undefined).then(() => handleSseEvent(event));
    };
    async function handleSseEvent(event: MessageEvent): Promise<void> {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message' && CHANNEL_ID) {
          let text: string = data.text;
          const slug: string | null = data.slug ?? null;
          const projectDirectory: string | null = data.projectDirectory ?? null;

          // Tag user on auto-decide notices
          if (requiresUserTag(text)) text = `${text} ${userTag}`;

          // Per-event dedup — within one SSE message, don't upload the same file twice.
          // Across events, re-uploads are allowed (file may have been regenerated).
          const uploaded = new Set<string>();

          // Route to project thread if slug is known
          if (slug && CHANNEL_ID) {
            const mainChannel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
            if (mainChannel?.type === ChannelType.GuildText) {
              try {
                const thread = await findOrCreateThread(mainChannel as TextChannel, slug);
                // Structural split: each paragraph / bullet / number / code block its own message
                const chunks = splitMessageStructured(text);
                // Synchronously enqueue all chunks so concurrent SSE events can't interleave
                chunks.forEach((chunk, idx) => {
                  enqueueOnChannel(thread, async () => {
                    const sent = await withRetry(() => thread.send(chunk));
                    if (idx === chunks.length - 1) {
                      if (slug === 'xp') preReactRestart(sent);
                      else if (slug) preReactProjectShortcut(sent, slug);
                    }
                  }).catch(console.error);
                });
                // Surface any file paths mentioned in the proactive message (cron auto-decide etc.)
                uploadDetectedFilesIn(text, thread, projectDirectory, uploaded);
                console.log(`[Discord] SSE message routed to thread /${slug}`);
                return;
              } catch (err) {
                console.warn(`[Discord] SSE: could not route to thread /${slug}, falling back to main channel: ${(err as Error).message}`);
              }
            }
          }

          // Fallback: send to main channel
          const channel = await client.channels.fetch(CHANNEL_ID);
          if (channel?.type === ChannelType.GuildText) {
            const chunks = splitMessageStructured(text);
            // Synchronously enqueue so concurrent SSE events can't interleave
            chunks.forEach(chunk => {
              enqueueOnChannel(channel as TextChannel, () => withRetry(() => (channel as TextChannel).send(chunk))).catch(console.error);
            });
            uploadDetectedFilesIn(text, channel as TextChannel, projectDirectory, uploaded);
          }
        }
      } catch (err) {
        console.error('[Discord] SSE error:', (err as Error).message);
      }
    }
    es.onerror = () => {
      es.close();
      const jitter = Math.random() * 1000;
      console.log(`[Discord] SSE disconnected, reconnecting in ${Math.round(sseRetryDelay / 1000)}s...`);
      setTimeout(connectSSE, sseRetryDelay + jitter);
      sseRetryDelay = Math.min(sseRetryDelay * 2, 60_000); // exponential backoff, cap at 60s
    };
    console.log('[Discord] SSE connected for proactive messages');
  }
  connectSSE();
});

// Prevent network errors (ENOTFOUND, ECONNRESET, etc.) from crashing the process.
// Discord.js will automatically attempt to reconnect; this handler just swallows
// the error so pm2 doesn't restart on every transient DNS/network blip.
client.on('error', (err) => {
  console.error('[Discord] client error (will reconnect):', err.message);
});

// Belt-and-suspenders: catch any unhandled promise rejections so a single stray
// async error doesn't take down the whole bot.
process.on('unhandledRejection', (reason) => {
  console.error('[Discord] unhandledRejection:', reason);
});

client.login(DISCORD_TOKEN);
