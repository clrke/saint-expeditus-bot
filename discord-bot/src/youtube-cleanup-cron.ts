/**
 * Daily YouTube abandoned-draft cleanup (full-auto).
 *
 * Deletes videos the bot uploaded that a human never touched and that have gone stale
 * (see the 5 gates in youtube-uploader.ts `findAbandonedDrafts`). IRREVERSIBLE — local
 * backups are the safety net (per Clarke's explicit sign-off). Posts a summary to Discord
 * via the bridge /notify endpoint, but only when something was deleted or errored (or on a
 * dry-run, which always reports).
 *
 * Requires the youtube.force-ssl scope — re-run youtube-auth.ts after the scope widening.
 *
 * Run (dry-run validation):   npx --prefix discord-bot tsx discord-bot/src/youtube-cleanup-cron.ts --dry-run
 * Run (real, full-auto):      npx --prefix discord-bot tsx discord-bot/src/youtube-cleanup-cron.ts
 * Scheduled daily via launchd — see youtube-cron/README.md.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { cleanupAbandonedDrafts, isYouTubeConfigured, checkYouTubeAuth, DRAFT_MAX_AGE_HOURS, type CleanupResult } from './youtube-uploader.js';
import { causeSuffix } from './debug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Root .env (shared by bridge + bot) — resolve from this file, never cwd.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DRY_RUN = process.argv.includes('--dry-run') || process.env.YOUTUBE_CLEANUP_DRY_RUN === '1';
const NOTIFY_URL = process.env.BRIDGE_NOTIFY_URL ?? `http://localhost:${process.env.PORT ?? '3141'}/notify`;
const NOTIFY_SLUG = process.env.YOUTUBE_CLEANUP_SLUG ?? 'xp';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;

async function notifyDiscord(message: string): Promise<void> {
  try {
    const res = await fetch(NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BRIDGE_TOKEN ? { Authorization: `Bearer ${BRIDGE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ slug: NOTIFY_SLUG, message }),
    });
    if (!res.ok) console.error(`[yt-cleanup] /notify failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    // Bridge may be down — never let reporting failure mask the cleanup result in logs.
    console.error(`[yt-cleanup] /notify error: ${(err as Error).message}`);
  }
}

function buildDigest(r: CleanupResult): string {
  const head = r.dryRun ? '🧹 **YouTube draft cleanup — DRY RUN**' : '🧹 **YouTube draft cleanup**';
  const lines = [`${head} (scanned ${r.scanned}, ≥${DRAFT_MAX_AGE_HOURS}h, unlisted & untouched)`];

  if (r.dryRun) {
    lines.push(`Would delete: **${r.candidates.length}**`);
    for (const c of r.candidates) lines.push(`• \`${c.videoId}\` "${c.title}" — ${c.ageHours.toFixed(0)}h old`);
  } else {
    lines.push(`Deleted: **${r.deleted.length}**`);
    for (const c of r.candidates.filter(c => r.deleted.includes(c.videoId))) {
      lines.push(`• \`${c.videoId}\` "${c.title}" — ${c.ageHours.toFixed(0)}h old`);
    }
  }
  if (r.errors.length) {
    lines.push(`⚠️ Errors: ${r.errors.length}`);
    for (const e of r.errors) lines.push(`• \`${e.videoId}\`: ${e.error.slice(0, 120)}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (!(await isYouTubeConfigured())) {
    console.error('[yt-cleanup] YouTube not configured (missing client-secret/token) — skipping.');
    process.exit(0);
  }
  // Guard: cleanup needs the widened scope. checkYouTubeAuth forces a real refresh; if the
  // token is upload-only, videos.list/delete will 403 — surface that clearly to Discord.
  const auth = await checkYouTubeAuth();
  if (!auth.ok) {
    await notifyDiscord(`🧹 YouTube cleanup skipped — auth failed: ${auth.error ?? 'unknown'}. Re-run youtube-auth.ts (needs youtube.force-ssl scope).`);
    console.error(`[yt-cleanup] auth failed: ${auth.error}`);
    process.exit(1);
  }

  const result = await cleanupAbandonedDrafts({ dryRun: DRY_RUN });
  console.log(`[yt-cleanup] ${DRY_RUN ? 'DRY-RUN' : 'AUTO'} scanned=${result.scanned} candidates=${result.candidates.length} deleted=${result.deleted.length} errors=${result.errors.length}`);

  // Report on a dry-run always (it's a manual validation); otherwise stay quiet on no-op days.
  if (DRY_RUN || result.deleted.length > 0 || result.errors.length > 0) {
    await notifyDiscord(buildDigest(result));
  }
  process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[yt-cleanup] fatal:', (err as Error).message + causeSuffix(err));
  process.exit(1);
});
