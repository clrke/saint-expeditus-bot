import path from 'node:path';
import type express from 'express';
import { config } from './config.js';
import { createApp, type SseResponse } from './app.js';
import { SessionManager } from './session-manager.js';
import { ProjectStore } from './project-store.js';
import { CommandRouter } from './command-router.js';
import { RepliedTracker } from './replied-tracker.js';
import { startCronJobs } from './cron.js';
import { HourlyLimiter } from './hourly-limiter.js';
import { getCostStats, initCostTracker } from './session-manager.js';

const projectStore = new ProjectStore(config.projectsDir);
const sessionManager = new SessionManager(config);
const commandRouter = new CommandRouter(sessionManager, projectStore, config);
const repliedTracker = new RepliedTracker(config.systemDir);
const sseClients = new Set<SseResponse>();

async function start() {
  await projectStore.init();

  // Auto-register saint expeditus if not present
  const expeditus = await projectStore.load('expeditus');
  if (!expeditus) {
    await projectStore.create({
      title: 'Saint Expeditus',
      slug: 'expeditus',
      description: 'Community assistant for Saint Expeditus Subdivision',
      directory: path.resolve(config.memoryDir, '..'),
      autoDecide: false,
    });
    console.log('[Bridge] Auto-registered Saint Expeditus project');
  }

  // Load existing session IDs from project files. A project with no sessionId starts a
  // FRESH session on its next message — we deliberately do NOT adopt whatever session
  // happens to be newest in its directory. That blind adoption hijacked unrelated sessions
  // (e.g. a human's interactive `claude` run in the same repo) and silently defeated /reset
  // by re-adopting the very session that was just wiped.
  const projects = await projectStore.loadAll();
  for (const p of projects) {
    if (p.sessionId) sessionManager.loadSession(p.slug, p.sessionId);
  }

  const persistPath = path.resolve(config.projectsDir, '../.budget-state.json');
  const hourlyLimiter = new HourlyLimiter({
    sessionLimit: config.sessionLimit,
    activeHours: config.sessionLimitHours,
    persistPath,
  });

  // Restore cost tracker from persisted state and wire up save-on-update
  const persistedCosts = hourlyLimiter.getPersistedCostData();
  initCostTracker(persistedCosts, () => {
    hourlyLimiter.save(getCostStats());
  });

  if (config.sessionLimit > 0) {
    const perHour = Math.ceil(config.sessionLimit / config.sessionLimitHours);
    console.log(`[Bridge] Hourly budget: ${perHour}/hr (${config.sessionLimit} total over ${config.sessionLimitHours}h)`);
  } else {
    console.log('[Bridge] Hourly budget: unlimited (set SESSION_LIMIT to enable)');
  }

  const sendToMessenger = (text: string, slug?: string, projectDirectory?: string) => {
    const data = JSON.stringify({
      type: 'message',
      text,
      slug: slug ?? null,
      projectDirectory: projectDirectory ?? null,
    });
    // Fan out ONLY to clients that identified as `discord` (?client=discord on /events).
    // The Messenger Chrome extension sends no identifier, so it receives nothing — Messenger
    // is intentionally killed as a proactive-output channel. Fail-closed: an unidentified
    // client never gets proactive project messages (privacy over convenience).
    let sent = 0;
    let skipped = 0;
    for (const client of sseClients) {
      if (client.clientKind !== 'discord') { skipped++; continue; }
      client.write(`data: ${data}\n\n`);
      sent++;
    }
    console.log(`[Bridge] fan-out ${slug ?? 'global'} -> ${sent} discord client(s)${skipped ? `, skipped ${skipped} non-discord` : ''} (${text.length} chars)`);
  };

  const app = createApp({
    commandRouter,
    repliedTracker,
    projectStore,
    maxRpm: config.maxRequestsPerMinute,
    sseClients,
    hourlyLimiter,
    sendToMessenger,
    sessionManager,
  });

  startCronJobs({ commandRouter, projectStore, config, sendToMessenger, hourlyLimiter });

  const server = app.listen(config.port, () => {
    console.log(`[Bridge] Listening on port ${config.port}`);
    console.log(`[Bridge] Projects dir: ${config.projectsDir}`);
    console.log(`[Bridge] Registered: ${projects.map(p => p.slug).join(', ') || 'none'}`);
  });

  // Graceful drain shutdown.
  //
  // Two competing constraints during pm2/tsx-watch restart:
  //   1. The new instance must be able to bind :3141 quickly — otherwise EADDRINUSE
  //      kills it (we hit this in practice: discord-bot's long-lived SSE + a streaming
  //      `/ask` for a 28-min render watch held the port for the full 60s drain, and
  //      pm2's new spawn tried to bind almost immediately → crash).
  //   2. In-flight Claude CLI subprocesses should still finish so their work isn't lost.
  //
  // Resolution: forcibly close ALL HTTP connections on signal — port releases instantly
  // → discord-bot surfaces a "🔌 connection dropped" message and reconnects SSE on its
  // own. Then continue draining the SessionManager in the background so any work that
  // doesn't depend on streaming output back (e.g. file writes, git commits already
  // queued) can still complete before we exit. Hard cap at 30s.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[Bridge] ${signal} received, releasing port + draining sessions (max 30s)...`);
      server.close();
      // closeAllConnections is Node ≥18.2; cast through unknown for TS lib lag.
      const srv = server as unknown as { closeAllConnections?: () => void };
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      const drained = await sessionManager.waitForIdle(30_000);
      console.log(`[Bridge] Drain ${drained ? 'complete' : 'timed out'}, exiting`);
      process.exit(0);
    });
  }
}

start();
