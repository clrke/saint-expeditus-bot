/**
 * Meta (Facebook + Instagram) auto-upload for video files mentioned by the bot.
 *
 * Publishes to:
 *   - Facebook Page  — all videos, no duration cap
 *   - Instagram Reels — only videos ≤ 90s (API hard limit)
 *
 * Files (all in `~/.saint-expeditus/`, chmod 600):
 *   meta-app-credentials.json    App ID + App Secret (from Meta Developer Portal)
 *   meta-token.json              Page access token + IG user ID (written by meta-auth.ts)
 *   meta-uploads-ledger.json     md5 → { facebookUrl, instagramUrl, uploadedAt, sourcePath } dedup map
 *
 * Setup (one-time):
 *   1. Create a Meta developer app at developers.facebook.com
 *   2. Save App ID + App Secret to ~/.saint-expeditus/meta-app-credentials.json
 *   3. Run: npx --prefix discord-bot tsx src/meta-auth.ts
 *   4. Complete app review to publish (required for pages_manage_posts + instagram_content_publish)
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const GRAPH_VERSION = 'v21.0';
const SECRETS_DIR = path.join(os.homedir(), '.saint-expeditus');
export const META_CREDENTIALS_PATH = path.join(SECRETS_DIR, 'meta-app-credentials.json');
export const META_TOKEN_PATH = path.join(SECRETS_DIR, 'meta-token.json');
export const META_LEDGER_PATH = path.join(SECRETS_DIR, 'meta-uploads-ledger.json');

export const INSTAGRAM_MAX_DURATION_S = 90;

export interface MetaToken {
  pageAccessToken: string;
  pageId: string;
  igUserId: string | null;
  obtainedAt: string;
}

export interface MetaLedgerEntry {
  facebookUrl: string | null;
  instagramUrl: string | null;
  uploadedAt: string;
  sourcePath: string;
  project?: string;
}

type MetaLedger = Record<string, MetaLedgerEntry>;

// ── Ledger helpers ──────────────────────────────────────────────────────────

async function loadLedger(): Promise<MetaLedger> {
  try {
    return JSON.parse(await fsPromises.readFile(META_LEDGER_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveLedger(ledger: MetaLedger): Promise<void> {
  const tmp = META_LEDGER_PATH + '.tmp';
  await fsPromises.writeFile(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  await fsPromises.rename(tmp, META_LEDGER_PATH);
}

function md5SyncOfFile(filePath: string): string | null {
  try {
    const hash = crypto.createHash('md5');
    const buf = fs.readFileSync(filePath);
    hash.update(buf);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

// ── Token helpers ───────────────────────────────────────────────────────────

async function loadToken(): Promise<MetaToken> {
  const raw = await fsPromises.readFile(META_TOKEN_PATH, 'utf-8');
  return JSON.parse(raw) as MetaToken;
}

// ── Video duration check ────────────────────────────────────────────────────

/** Returns duration in seconds via ffprobe, or null if unavailable. */
export function getVideoDurationSync(filePath: string): number | null {
  try {
    const { execFileSync } = require('node:child_process');
    const out: string = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf-8', timeout: 10_000 });
    const dur = parseFloat(out.trim());
    return isNaN(dur) ? null : dur;
  } catch {
    return null;
  }
}

// ── Configuration check ─────────────────────────────────────────────────────

export async function isMetaConfigured(): Promise<boolean> {
  try {
    await fsPromises.access(META_CREDENTIALS_PATH, fs.constants.R_OK);
    await fsPromises.access(META_TOKEN_PATH, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkMetaAuth(): Promise<{ ok: boolean; error?: string; obtainedAt?: string }> {
  try {
    await fsPromises.access(META_CREDENTIALS_PATH, fs.constants.R_OK);
    await fsPromises.access(META_TOKEN_PATH, fs.constants.R_OK);
  } catch {
    return { ok: false, error: 'credentials missing — run meta-auth.ts' };
  }
  try {
    const token = await loadToken();
    // Probe the token by calling /me on the Page
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${token.pageId}?fields=id,name&access_token=${token.pageAccessToken}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: `Page token invalid: ${(err as { error?: { message?: string } }).error?.message ?? res.status}` };
    }
    return { ok: true, obtainedAt: token.obtainedAt };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── Facebook Page video upload ──────────────────────────────────────────────

async function uploadToFacebook(
  filePath: string,
  opts: { title: string; description: string; project?: string },
  token: MetaToken,
): Promise<string> {
  const fileBytes = await fsPromises.readFile(filePath);
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append('title', opts.title);
  form.append('description', opts.description);
  form.append('access_token', token.pageAccessToken);
  form.append('source', new Blob([fileBytes], { type: 'video/mp4' }), filename);

  const res = await fetch(
    `https://graph-video.facebook.com/${GRAPH_VERSION}/${token.pageId}/videos`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60_000) },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Facebook upload failed: ${err.error?.message ?? res.status}`);
  }
  const data = await res.json() as { id: string };
  // Build the Facebook Page video URL — requires knowing the page username/id
  return `https://www.facebook.com/${token.pageId}/videos/${data.id}`;
}

// ── Instagram Reels upload (3-step resumable) ───────────────────────────────

async function uploadToInstagram(
  filePath: string,
  opts: { caption: string },
  token: MetaToken,
): Promise<string> {
  if (!token.igUserId) throw new Error('Instagram User ID not configured — re-run meta-auth.ts');

  const fileBytes = await fsPromises.readFile(filePath);
  const fileSize = fileBytes.byteLength;

  // Step 1: Create media container
  const containerRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${token.igUserId}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        upload_type: 'resumable',
        caption: opts.caption,
        share_to_feed: true,
        access_token: token.pageAccessToken,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!containerRes.ok) {
    const err = await containerRes.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Instagram container creation failed: ${err.error?.message ?? containerRes.status}`);
  }
  const container = await containerRes.json() as { id: string; uri?: string };
  const containerId = container.id;

  // Step 2: Upload binary to rupload endpoint
  const uploadUri = container.uri ?? `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}/${containerId}`;
  const uploadRes = await fetch(uploadUri, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${token.pageAccessToken}`,
      'offset': '0',
      'file_size': String(fileSize),
      'Content-Type': 'application/octet-stream',
    },
    body: fileBytes,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    throw new Error(`Instagram video upload failed: ${uploadRes.status} ${errText.slice(0, 200)}`);
  }

  // Step 3: Poll until processing complete (up to 5 minutes)
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000));
    const statusRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${containerId}?fields=status_code&access_token=${token.pageAccessToken}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!statusRes.ok) continue;
    const status = await statusRes.json() as { status_code?: string };
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Instagram container processing ${status.status_code}`);
    }
  }

  // Step 4: Publish
  const publishRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${token.igUserId}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: containerId, access_token: token.pageAccessToken }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!publishRes.ok) {
    const err = await publishRes.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Instagram publish failed: ${err.error?.message ?? publishRes.status}`);
  }
  const published = await publishRes.json() as { id: string };

  // Fetch permalink
  const linkRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${published.id}?fields=permalink&access_token=${token.pageAccessToken}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (linkRes.ok) {
    const linkData = await linkRes.json() as { permalink?: string };
    if (linkData.permalink) return linkData.permalink;
  }
  return `https://www.instagram.com/p/${published.id}/`;
}

// ── Public entry point ──────────────────────────────────────────────────────

export interface MetaUploadResult {
  md5: string;
  facebookUrl: string | null;
  instagramUrl: string | null;
  instagramSkipped: boolean;
  instagramSkipReason?: string;
}

/**
 * Upload to Facebook (always) and Instagram (if ≤90s).
 * Deduplicates by MD5 — returns existing URLs if already uploaded.
 */
export async function uploadToMeta(
  filePath: string,
  opts: { title: string; description: string; project?: string },
): Promise<MetaUploadResult> {
  const md5 = md5SyncOfFile(filePath) ?? crypto.randomUUID();
  const ledger = await loadLedger();

  if (ledger[md5]) {
    return {
      md5,
      facebookUrl: ledger[md5].facebookUrl,
      instagramUrl: ledger[md5].instagramUrl,
      instagramSkipped: false,
    };
  }

  const token = await loadToken();
  const duration = getVideoDurationSync(filePath);
  const igEligible = duration !== null && duration <= INSTAGRAM_MAX_DURATION_S;
  const igSkipReason = duration === null
    ? 'could not read duration'
    : `video is ${Math.round(duration)}s (cap: ${INSTAGRAM_MAX_DURATION_S}s)`;

  // Upload to Facebook always
  const facebookUrl = await uploadToFacebook(filePath, opts, token);

  // Upload to Instagram only if within cap
  let instagramUrl: string | null = null;
  if (igEligible) {
    instagramUrl = await uploadToInstagram(filePath, { caption: opts.description }, token);
  }

  // Persist to ledger
  const entry: MetaLedgerEntry = {
    facebookUrl,
    instagramUrl,
    uploadedAt: new Date().toISOString(),
    sourcePath: filePath,
    project: opts.project,
  };
  const fresh = await loadLedger();
  fresh[md5] = entry;
  await saveLedger(fresh);

  return {
    md5,
    facebookUrl,
    instagramUrl,
    instagramSkipped: !igEligible,
    instagramSkipReason: igEligible ? undefined : igSkipReason,
  };
}
