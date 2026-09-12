import express from 'express';
import cors from 'cors';
import type { AskPayload, AskResponse, HealthResponse, NotifyPayload } from '../../shared/types.js';
import { RepliedTracker } from './replied-tracker.js';
import type { CommandRouter } from './command-router.js';
import { stripJson, stripJsonParts, formatForDiscord } from './command-router.js';
import type { ProjectStore } from './project-store.js';
import type { HourlyLimiter } from './hourly-limiter.js';
import { getCostStats, type SessionManager } from './session-manager.js';
import { debug } from './debug.js';

/** An SSE connection tagged with the client kind it identified as (?client=). */
export type SseResponse = express.Response & { clientKind?: string };

export interface AppDeps {
  commandRouter: CommandRouter;
  repliedTracker: RepliedTracker;
  projectStore: ProjectStore;
  maxRpm: number;
  sseClients: Set<SseResponse>;
  hourlyLimiter: HourlyLimiter;
  /** Pushes a proactive message to a project's Discord thread via the /events SSE stream. */
  sendToMessenger: (text: string, slug?: string, projectDirectory?: string) => void;
  sessionManager: SessionManager;
}

const SLUG_RE = /^\/([a-z0-9-]+)/i;
// Commands that bypass dedup AND are surfaced to clients via /projects
export const GLOBAL_COMMANDS = ['list', 'details', 'info', 'vacation', 'unvacation', 'auto-decide-extend', 'register', 'update', 'reset', 'compact', 'handover', 'rollover', 'nudge', 'help'] as const;
const REPEATABLE_COMMANDS = new Set<string>(GLOBAL_COMMANDS);

function extractSlug(message: string): string | null {
  const m = message?.match(SLUG_RE);
  return m ? m[1].toLowerCase() : null;
}

export function createApp(deps: AppDeps): express.Express {
  const { commandRouter, repliedTracker, projectStore, maxRpm, sseClients, hourlyLimiter, sendToMessenger, sessionManager } = deps;
  // Pre-load dedup keys so the first request doesn't pay the I/O cost
  repliedTracker.load();
  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '1mb' }));

  // Optional bearer-token auth. Set BRIDGE_TOKEN in .env to require it on all
  // non-health routes. Skip if not configured (backward-compat with local dev).
  const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
  if (BRIDGE_TOKEN) {
    app.use((req, res, next) => {
      if (req.path === '/health') return next(); // always allow health checks
      const auth = req.headers['authorization'] ?? '';
      if (auth === `Bearer ${BRIDGE_TOKEN}`) return next();
      res.status(401).json({ error: 'Unauthorized' });
    });
  }

  const stats = {
    requestsServed: 0,
    totalMs: 0,
    lastError: null as string | null,
  };
  const startTime = Date.now();

  const requestTimestamps: number[] = [];

  function checkRpm(): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    // Only evict stale entries when near the limit — O(shift) is fine, avoid it when not needed
    if (requestTimestamps.length >= maxRpm) {
      while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
        requestTimestamps.shift();
      }
      if (requestTimestamps.length >= maxRpm) return false;
    }
    requestTimestamps.push(now);
    return true;
  }

  app.get('/health', (_req, res) => {
    const resp: HealthResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Date.now() - startTime,
      stats: {
        requestsServed: stats.requestsServed,
        avgResponseMs:
          stats.requestsServed > 0
            ? Math.round(stats.totalMs / stats.requestsServed)
            : 0,
        lastError: stats.lastError,
      },
    };
    res.json(resp);
  });

  app.post('/reset', (_req, res) => {
    res.json({ status: 'ok', message: 'Use project-specific session management.' });
  });

  // Force-stop the in-flight turn for a slug (Discord 🛑 reaction). Deliberately NOT
  // rate-limited and NOT hourly-budgeted: an escape hatch that can be refused because
  // you've been talking too much is not an escape hatch. Idempotent — stopping an idle
  // slug is a 200 with stopped:false, not an error.
  app.post('/stop', (req, res) => {
    const { slug } = (req.body ?? {}) as { slug?: string };
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "slug"' });
      return;
    }
    const result = sessionManager.stop(slug.toLowerCase());
    console.log(`[Bridge] /stop ${slug}: ${result.reason}`);
    res.json({ status: 'ok', ...result });
  });

  // Emergency full reset (Discord 🆘 reaction): kill whatever's running for the slug AND
  // discard the session, in one shot — for when a session is stuck (compaction spiral,
  // wedged tool call) and waiting for it to cooperate isn't an option. ♻️ handover asks
  // the stuck session to write its own HANDOFF.md first, which needs it to still be
  // responsive; this bypasses that entirely. Same NOT rate-limited / NOT hourly-budgeted
  // reasoning as /stop — doubly so here, since being budget-exhausted is a plausible
  // reason a session got stuck in the first place.
  //
  // Order matters: stop() must run before resetSession(). The in-flight query()'s promise
  // for this slug is what's chaining the per-slug mutex — until it settles (which stop()'s
  // SIGTERM/SIGKILL forces via the child's 'close' event), the mutex stays blocked and even
  // a freshly-reset session's next message would still queue behind it forever. resetSession()
  // itself only flips local flags (forceNew, sessionId) and is safe to call regardless of
  // process state, but calling it doesn't unblock anything by itself.
  //
  // Known gap: any message already dispatched into the mutex queue behind the stuck turn
  // (as opposed to still sitting in the bot's debounce buffer, which the bot cancels
  // separately) will still run after this — but as a fresh conversation, since forceNew/
  // sessionId are cleared before it gets its turn.
  app.post('/emergency-reset', async (req, res) => {
    const { slug } = (req.body ?? {}) as { slug?: string };
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "slug"' });
      return;
    }
    const normalizedSlug = slug.toLowerCase();
    const stopResult = sessionManager.stop(normalizedSlug);
    sessionManager.resetSession(normalizedSlug);

    let projectReset = false;
    const project = await projectStore.load(normalizedSlug);
    if (project) {
      project.sessionId = null;
      project.status = 'Awaiting first message';
      project.decision = null;
      project.contextUsedPct = null;
      delete (project as Partial<typeof project>).lastConversationAt;
      await projectStore.save(project);
      projectReset = true;
    }

    console.warn(`[Bridge] /emergency-reset ${normalizedSlug}: ${stopResult.reason}; session wiped${projectReset ? '' : ' (no project record — session state cleared anyway)'}`);
    res.json({ status: 'ok', stopped: stopResult.stopped, stopReason: stopResult.reason, projectReset });
  });

  app.get('/projects', async (_req, res) => {
    const slugs = await projectStore.getSlugs();
    const commands = [...GLOBAL_COMMANDS];
    res.json({ slugs, commands });
  });

  app.get('/budget', (_req, res) => {
    res.json({ ...hourlyLimiter.getStatus(), cost: getCostStats() });
  });

  // Reusable proactive-notify endpoint: any external script (e.g. a launchd cron job)
  // can push a message into a project's Discord thread without spawning a Claude session.
  // Body: { slug: string, message: string }. Validated against registered projects so a
  // typo'd slug fails loudly instead of silently vanishing (findOrCreateThread would
  // otherwise create a stray thread for it).
  app.post('/notify', async (req, res) => {
    const { slug, message } = (req.body ?? {}) as Partial<NotifyPayload>;
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "slug"' });
      return;
    }
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "message"' });
      return;
    }
    const proj = await projectStore.load(slug);
    if (!proj) {
      res.status(404).json({ error: `Unknown project slug: ${slug}` });
      return;
    }
    sendToMessenger(message, slug, proj.directory);
    res.json({ status: 'ok' });
  });

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    // Tag the connection with its client kind (from ?client=). Proactive fan-out
    // (sendToMessenger) only writes to clients that identify as `discord`, so the
    // Messenger Chrome extension — which sends no identifier — receives nothing.
    const clientKind = typeof req.query.client === 'string' ? req.query.client : 'unknown';
    (res as SseResponse).clientKind = clientKind;
    sseClients.add(res);
    const ua = (req.headers['user-agent'] ?? '').slice(0, 60);
    console.log(`[Bridge] SSE client connected: kind=${clientKind} ua="${ua}" (total ${sseClients.size})`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
    req.on('close', () => {
      sseClients.delete(res);
      clearInterval(heartbeat);
      console.log(`[Bridge] SSE client disconnected: kind=${clientKind} (total ${sseClients.size})`);
    });
  });

  app.post('/ask', async (req, res) => {
    if (!checkRpm()) {
      res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
      return;
    }

    // Hourly session budget check
    const hourlyReject = hourlyLimiter.tryConsume();
    if (hourlyReject) {
      const body = req.body as AskPayload;
      const slug = extractSlug(body?.trigger?.originalMessage ?? '');
      if (slug) hourlyLimiter.recordBlocked(slug);

      const status = hourlyLimiter.getStatus();
      res.status(429).json({
        error: hourlyReject,
        budget: status,
      });
      return;
    }

    const { trigger, recentMessages, repliedToMessage, chatId } =
      req.body as AskPayload;
    // originalMessage is checked explicitly: it feeds extractSlug/makeKey below, which run
    // outside the try/catch. A payload with a present-but-malformed trigger used to throw
    // here and take the whole bridge down with it (uncaught → PM2 restart → every project
    // dead, not just the bad request).
    if (!trigger || typeof trigger.originalMessage !== 'string') {
      debug('ask', `rejected malformed payload: trigger=${JSON.stringify(trigger)?.slice(0, 200)}`);
      res.status(400).json({ error: 'No trigger provided' });
      return;
    }

    const slug = extractSlug(trigger.originalMessage);
    const isRepeatable = REPEATABLE_COMMANDS.has(slug ?? '');

    const triggerKey = RepliedTracker.makeKey(trigger.originalMessage);
    debug('ask', `slug=${slug ?? 'none'} sender=${trigger.sender} repeatable=${isRepeatable} chars=${trigger.originalMessage.length} msg="${trigger.originalMessage.slice(0, 80).replace(/\n/g, ' ')}"`);
    if (!isRepeatable && repliedTracker.has(triggerKey)) {
      console.log(`[Bridge] Already replied to: ${triggerKey}`);
      res.status(200).json({ response: null, alreadyReplied: true });
      return;
    }

    const start = Date.now();
    try {
      const payload: AskPayload = {
        trigger,
        recentMessages: recentMessages ?? [],
        repliedToMessage: repliedToMessage ?? null,
        chatId,
      };
      const { response } = await commandRouter.handle(payload);
      const elapsed = Date.now() - start;
      stats.requestsServed++;
      stats.totalMs += elapsed;
      debug('ask', `ok slug=${slug ?? 'none'} in ${elapsed}ms, ${response?.length ?? 0} chars`);

      if (!isRepeatable) {
        await repliedTracker.record(triggerKey);
      }

      const resp: AskResponse = {
        response,
        timestamp: new Date().toISOString(),
      };
      res.json(resp);
    } catch (err) {
      const error = err as Error;
      stats.lastError = error.message;
      // Always name the slug and elapsed time: "Technical issue" alone gave no way to tell
      // which project failed, or whether it died fast (spawn/config) or slow (CLI timeout).
      process.stderr.write(
        `[Bridge] Error slug=${slug ?? 'none'} after ${Date.now() - start}ms: ${error.stack || error.message}\n`,
      );
      res.status(500).json({
        error: 'Technical issue. Please try again later.',
      });
    }
  });

  // Streaming endpoint — sends each intermediate message as an SSE event
  app.post('/ask/stream', async (req, res) => {
    if (!checkRpm()) {
      res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
      return;
    }

    const { trigger, recentMessages, repliedToMessage, chatId } =
      req.body as AskPayload;
    if (!trigger) {
      res.status(400).json({ error: 'No trigger provided' });
      return;
    }

    // Hourly session budget check
    const hourlyReject = hourlyLimiter.tryConsume();
    if (hourlyReject) {
      const slug = extractSlug(trigger?.originalMessage ?? '');
      if (slug) hourlyLimiter.recordBlocked(slug);

      const status = hourlyLimiter.getStatus();
      res.status(429).json({
        error: hourlyReject,
        budget: status,
      });
      return;
    }

    console.log(`[Bridge] /ask/stream <- ${extractSlug(trigger.originalMessage) ?? 'global'} (${(trigger.originalMessage ?? '').length} chars, from ${trigger.sender ?? '?'})`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Keep the connection's bodyTimeout from firing during a long silent stretch (a single
    // slow tool call, self-compaction, whatever) with no message/tool event to write. Unlike
    // /events, this stream previously had NO heartbeat — Node's global fetch (undici) defaults
    // to a 300s bodyTimeout on the client side, and once ~5min passed with zero bytes written,
    // the bot's fetch aborted with `terminated (UND_ERR_BODY_TIMEOUT)`, surfaced to the user as
    // "the server likely restarted mid-stream" — a misdiagnosis; the bridge was never down,
    // the client just gave up waiting. Same fix shape as /events' heartbeat below.
    const streamHeartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
    req.on('close', () => clearInterval(streamHeartbeat));

    const payload: AskPayload = {
      trigger,
      recentMessages: recentMessages ?? [],
      repliedToMessage: repliedToMessage ?? null,
      chatId,
    };

    try {
      // Send project directory upfront so discord-bot can resolve relative file paths during streaming
      const triggerSlug = extractSlug(trigger.originalMessage);
      if (triggerSlug) {
        const proj = await projectStore.load(triggerSlug);
        if (proj?.directory) {
          res.write(`data: ${JSON.stringify({ type: 'meta', projectDirectory: proj.directory })}\n\n`);
        }
      }

      const sentParts = new Set<string>();
      // Normalize whitespace for dedup comparison (handles subtle spacing diffs between plain text and JSON-extracted text)
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
      const { response, projectSlug, parked } = await commandRouter.handle(
        payload,
        (text) => {
          const parts = stripJsonParts(text);
          for (const part of parts) {
            const formatted = formatForDiscord(part.trim());
            const key = normalize(formatted);
            if (key && !sentParts.has(key)) {
              sentParts.add(key);
              res.write(`data: ${JSON.stringify({ type: 'message', text: formatted })}\n\n`);
            } else if (key) {
              console.log(`[Bridge] Dedup: skipped ${formatted.length}chars (normalized match)`);
            }
          }
        },
        (tool, detail) => res.write(`data: ${JSON.stringify({ type: 'tool', name: tool, detail })}\n\n`),
        // Echo the assembled prompt (post staleness/subagent-hint append) so the client can show what Claude actually receives
        (text) => res.write(`data: ${JSON.stringify({ type: 'final_prompt', text })}\n\n`),
      );

      // Only send done if nothing was already streamed (e.g. single-shot response)
      const singleShot = sentParts.size === 0;
      // Include context usage and project directory for project sessions
      let contextUsedPct: number | null = null;
      let projectDirectory: string | null = null;
      if (projectSlug) {
        const proj = await projectStore.load(projectSlug);
        if (proj?.contextUsedPct != null) contextUsedPct = proj.contextUsedPct;
        if (proj?.directory) projectDirectory = proj.directory;
      }
      res.write(`data: ${JSON.stringify({ type: 'done', response: formatForDiscord(response), singleShot, contextUsedPct, projectDirectory, parked: parked === true })}\n\n`);
      res.end();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('aborted')) {
        console.log(`[Bridge] Stream aborted: ${msg}`);
        res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
      } else {
        console.error(`[Bridge] Stream error: ${msg}`);
        res.write(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`);
      }
      res.end();
    } finally {
      clearInterval(streamHeartbeat);
    }
  });

  return app;
}
