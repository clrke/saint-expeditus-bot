import type { ProjectStore } from './project-store.js';
import type { CommandRouter } from './command-router.js';
import { COMPACT_THRESHOLD_PCT, COMPACT_IDLE_MINUTES, CRITICAL_ROLLOVER_PCT } from './command-router.js';
import type { Config } from './config.js';
import type { HourlyLimiter } from './hourly-limiter.js';
import { hasDeadlinePassed, isActiveHour } from './deadline.js';
import { exec } from 'node:child_process';

export interface CronDeps {
  commandRouter: CommandRouter;
  projectStore: ProjectStore;
  config: Config;
  sendToMessenger: (text: string, slug?: string, projectDirectory?: string) => void;
  hourlyLimiter: HourlyLimiter;
}

export function startCronJobs(deps: CronDeps): void {
  const { commandRouter, projectStore, sendToMessenger, config } = deps;

  let autoDecideRunning = false;

  // Auto-decide: check every hour
  setInterval(async () => {
    if (autoDecideRunning) {
      console.log('[Cron] Skipping auto-decide tick — previous cycle still running');
      return;
    }

    const hour = new Date().getHours();
    if (!isActiveHour(hour)) {
      console.log(`[Cron] Skipping auto-decide check (hour ${hour} outside 9AM-9PM)`);
      return;
    }

    if (await projectStore.isVacation()) {
      console.log('[Cron] Skipping auto-decide (vacation mode)');
      return;
    }

    autoDecideRunning = true;
    try {
      const projects = await projectStore.loadAll();
      for (const project of projects) {
        if (!project.autoDecide) continue;
        if (!project.decision?.deadline) continue;
        if (!hasDeadlinePassed(project.decision.deadline)) continue;

        console.log(`[Cron] Auto-deciding for ${project.slug}...`);
        try {
          let timer: ReturnType<typeof setTimeout>;
          const timeoutMs = config.autoDecideTimeoutMs;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`auto-decide timed out after ${Math.round(timeoutMs / 60_000)} minutes`)), timeoutMs);
          });
          const response = await Promise.race([
            commandRouter.autoDecide(
              project,
              (text) => sendToMessenger(text, project.slug, project.directory),
            ).finally(() => clearTimeout(timer!)),
            timeout,
          ]);
          sendToMessenger(response, project.slug, project.directory);
        } catch (err) {
          console.error(`[Cron] Auto-decide failed for ${project.slug}: ${(err as Error).message}`);
          // Promise.race doesn't cancel the loser — if the timeout won, autoDecide's CLI
          // child is still running, still holding this slug's per-slug mutex. Previously
          // we just walked away here: the turn kept eating CPU/API quota in the background,
          // and the NEXT auto-decide tick (or any manual message) would silently queue
          // behind that same orphaned mutex instead of actually retrying. Force-stop it so
          // "gave up waiting" actually means the slug is free again.
          if (/timed out after/.test((err as Error).message)) {
            const stopResult = commandRouter.stopSlug(project.slug);
            console.warn(`[Cron] ${project.slug}: force-stopped after auto-decide timeout — ${stopResult.reason}`);
          }
        }
      }
    } finally {
      autoDecideRunning = false;
    }
  }, 60 * 60 * 1000);

  // Decision cleanup: check every hour, fire at midnight (hour 0)
  setInterval(async () => {
    const hour = new Date().getHours();
    if (hour !== 0) return;

    console.log('[Cron] Running midnight decision cleanup...');
    const projects = await projectStore.loadAll();
    for (const project of projects) {
      try {
        await commandRouter.cleanupDecisions(project);
        console.log(`[Cron] Cleaned up decisions for ${project.slug}`);
      } catch (err) {
        console.error(`[Cron] Cleanup failed for ${project.slug}: ${(err as Error).message}`);
      }
    }
  }, 60 * 60 * 1000);

  // Auto-resume: check at the top of each hour for blocked projects
  setInterval(async () => {
    if (new Date().getMinutes() !== 0) return;

    const slugs = deps.hourlyLimiter.drainBlocked();
    if (slugs.length === 0) return;

    console.log(`[Cron] Hour rolled over — auto-resuming blocked projects: ${slugs.join(', ')}`);
    for (const slug of slugs) {
      const project = await projectStore.load(slug);
      if (!project) continue;

      try {
        const result = await commandRouter.autoDecide(
          project,
          (text) => sendToMessenger(text, slug, project.directory),
        );
        sendToMessenger(result, slug, project.directory);
        console.log(`[Cron] Auto-resumed ${slug}`);
      } catch (err) {
        console.error(`[Cron] Auto-resume failed for ${slug}: ${(err as Error).message}`);
      }
    }
  }, 60_000);

  // Quiet-window watcher: armed on demand by touching `.projects/.quiet-watch` (e.g. when a
  // human asks to be told the next safe moment to restart bridge/discord-bot, or explicitly
  // asks for it to auto-restart). Polls every minute; the first tick that finds zero sessions
  // in flight disarms itself (deletes the flag) so staying idle afterward doesn't cause repeat
  // pings, sends ONE Discord notice, then — re-confirming the window is still clear right
  // before acting, since a session can start in between — runs `pm2 restart all` itself
  // (same command as the 🔄 reaction handler in discord-bot/src/index.ts). This intentionally
  // restarts autonomously: a human explicitly asked for the next safe window to auto-restart
  // (2026-08-30), which supersedes the general "never restart autonomously" default for this
  // one arm-it-yourself flow specifically. Fire-and-forget: if pm2 restarts bridge itself, this
  // callback may never resolve — that's expected, same caveat as the reaction handler.
  setInterval(async () => {
    if (!(await projectStore.isQuietWatchArmed())) return;
    if (commandRouter.anySessionRunning()) return;
    await projectStore.setQuietWatch(false);
    console.log('[Cron] Quiet window found — notifying, disarming quiet-watch, and auto-restarting');
    sendToMessenger('🔕 Quiet now — no sessions in flight. Auto-restarting to deploy latest changes…', 'xp');
    if (commandRouter.anySessionRunning()) {
      console.log('[Cron] Quiet-watch: a session started between the check and the restart — skipping this tick, flag already disarmed');
      return;
    }
    exec('pm2 restart all', (err, stdout, stderr) => {
      if (err) {
        console.error('[Cron] Quiet-watch auto-restart failed:', err.message);
        return;
      }
      console.log('[Cron] Quiet-watch auto-restart complete:', stdout.trim() || stderr.trim());
    });
  }, 60_000);

  // Proactive compaction: check every 30 minutes, max 2 per tick to protect hourly budget
  setInterval(async () => {
    const projects = await projectStore.loadAll();
    let compactedThisTick = 0;
    for (const project of projects) {
      if (compactedThisTick >= 2) break;
      if (!project.sessionId) continue;
      // Quick pre-check: skip ineligible projects without consuming budget
      if ((project.contextUsedPct ?? 0) < COMPACT_THRESHOLD_PCT) continue;
      if (!project.lastConversationAt) continue;
      const idleMs = Date.now() - new Date(project.lastConversationAt).getTime();
      if (idleMs < COMPACT_IDLE_MINUTES * 60_000) continue;
      // Eligible — consume a budget slot before running
      const rejected = deps.hourlyLimiter.tryConsume();
      if (rejected) {
        console.log(`[Cron] Compact skipped for ${project.slug}: ${rejected}`);
        break;
      }
      try {
        const notice = await commandRouter.proactiveCompact(project);
        if (notice) {
          console.log(`[Cron] Proactive compact for ${project.slug}`);
          compactedThisTick++;
        }

        // Fallback: if the session is STILL critically full after compaction (a maxed
        // context can't summarize itself), auto-roll over — snapshot → reset → reseed.
        // proactiveCompact just refreshed lastConversationAt, so pass idleMinutes=0 to
        // skip the idle guard (we already confirmed idleness above).
        if ((project.contextUsedPct ?? 0) >= CRITICAL_ROLLOVER_PCT && project.sessionId) {
          const rolloverRejected = deps.hourlyLimiter.tryConsume();
          if (rolloverRejected) {
            console.log(`[Cron] Auto-rollover skipped for ${project.slug}: ${rolloverRejected}`);
            break;
          }
          // rolloverSession posts its whole summary (progress + TLDR + decision) via this
          // onMessage callback, so we must NOT re-send the returned string here (double-post).
          const rollNotice = await commandRouter.proactiveRollover(
            project, 0, CRITICAL_ROLLOVER_PCT,
            (text) => sendToMessenger(text, project.slug, project.directory),
          );
          if (rollNotice) {
            console.log(`[Cron] Auto-rollover for ${project.slug} (compaction couldn't recover)`);
            compactedThisTick++;
          }
        }
      } catch (err) {
        console.error(`[Cron] Proactive compact/rollover failed for ${project.slug}: ${(err as Error).message}`);
      }
    }
  }, 30 * 60_000);

  console.log('[Cron] Started: auto-decide (hourly 9AM-9PM), auto-resume (top of hour), compact (30min), cleanup (midnight)');
}
