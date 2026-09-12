/**
 * YouTube auto-upload for .mp4 files mentioned/read by the bot.
 *
 * Pipeline:
 *   detect  → MD5 dedup against persistent ledger → resumable upload → save to ledger
 *
 * Uses bare `fetch` + `node:stream.Readable.toWeb()` for streaming uploads — no
 * `googleapis` SDK (which is 190 MB and dwarfs every other discord-bot dep).
 *
 * Files (all in `~/.saint-expeditus/`, chmod 600):
 *   youtube-client-secret.json     OAuth 2.0 client credentials (downloaded from Google Cloud)
 *   youtube-token.json             refresh_token (written by youtube-auth.ts after one-time consent)
 *   youtube-uploads-ledger.json    md5 → { url, videoId, uploadedAt, sourcePath, project } dedup map
 *
 * Setup (one-time):
 *   1. Download OAuth client JSON from Google Cloud Console (Desktop app type).
 *   2. Save it to ~/.saint-expeditus/youtube-client-secret.json (chmod 600).
 *   3. Run: npx --prefix discord-bot tsx discord-bot/src/youtube-auth.ts
 *   4. Browser opens, you grant `youtube.upload` scope, refresh token saved automatically.
 *
 * Quota: YouTube Data API daily quota defaults to 10,000 units. Each video upload
 * costs 1,600 units → ~6 uploads/day before `quotaExceeded` errors. We surface the
 * error to Discord so you can request a quota increase or wait for daily reset.
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import stream from 'node:stream';
import { Agent } from 'undici';
import { causeSuffix } from './debug.js';

// Node 18's global `fetch` (undici under the hood) defaults to a 300s headersTimeout.
// For large video PUTs on a slow/constrained upload link, undici can still be waiting
// on the response headers past that mark even though the body upload is progressing
// normally — this manifested as a `fetch failed` / `UND_ERR_HEADERS_TIMEOUT` after
// ~5min on anything bigger than a couple dozen MB. Use a dedicated dispatcher with a
// much longer headers/body timeout for the actual upload PUT (the only call whose
// duration scales with file size).
const UPLOAD_DISPATCHER = new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 });

const SECRETS_DIR = path.join(os.homedir(), '.saint-expeditus');
export const CLIENT_SECRET_PATH = path.join(SECRETS_DIR, 'youtube-client-secret.json');
export const TOKEN_PATH = path.join(SECRETS_DIR, 'youtube-token.json');
export const LEDGER_PATH = path.join(SECRETS_DIR, 'youtube-uploads-ledger.json');

export const VIDEO_EXTS = ['.mp4'];

export interface LedgerEntry {
  url: string;
  videoId: string;
  uploadedAt: string;
  sourcePath: string;
  project?: string;
  sizeBytes: number;
}
type Ledger = Record<string /* md5 hex */, LedgerEntry>;

export interface UploadOpts {
  title: string;
  description: string;
  privacy?: 'private' | 'unlisted' | 'public';
  project?: string;
}

export interface UploadResult {
  url: string;
  videoId: string;
  alreadyUploaded: boolean;
  md5: string;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

/**
 * Hash the file and look it up in the ledger without uploading. Use this to decide
 * whether to surface ANY upload-related UI (e.g. an "Uploading…" status message) — a
 * cached hit means we should stay silent and not re-announce a previously uploaded video.
 */
export async function findExistingByContent(
  filePath: string,
): Promise<{ md5: string; existing: LedgerEntry | null }> {
  const md5 = await computeMd5(filePath);
  const ledger = await loadLedger();
  return { md5, existing: ledger[md5] ?? null };
}

/**
 * Upload to YouTube and record in the ledger. Does NOT consult the ledger first —
 * caller is expected to have already deduped via `findExistingByContent`. Pass the
 * MD5 from that precheck via `knownMd5` to avoid re-hashing large files.
 */
export async function uploadAndRecord(
  filePath: string,
  opts: UploadOpts,
  knownMd5?: string,
): Promise<UploadResult> {
  const stat = await fsPromises.stat(filePath);
  const md5 = knownMd5 ?? (await computeMd5(filePath));

  const accessToken = await getAccessToken();
  const { url, videoId } = await uploadToYouTube(filePath, stat.size, accessToken, {
    title: opts.title,
    description: opts.description,
    privacy: opts.privacy ?? 'unlisted',
  });

  // Re-read ledger before merging — tolerates concurrent uploads writing different MD5s.
  const fresh = await loadLedger();
  fresh[md5] = {
    url,
    videoId,
    uploadedAt: new Date().toISOString(),
    sourcePath: filePath,
    project: opts.project,
    sizeBytes: stat.size,
  };
  await saveLedger(fresh);

  return { url, videoId, alreadyUploaded: false, md5 };
}

/**
 * Convenience wrapper that combines precheck + upload. Prefer the two-step API
 * (`findExistingByContent` + `uploadAndRecord`) when the caller wants to suppress
 * messaging for cached hits.
 */
export async function uploadVideoIfNew(filePath: string, opts: UploadOpts): Promise<UploadResult> {
  const { md5, existing } = await findExistingByContent(filePath);
  if (existing) {
    return { url: existing.url, videoId: existing.videoId, alreadyUploaded: true, md5 };
  }
  return uploadAndRecord(filePath, opts, md5);
}

export async function isYouTubeConfigured(): Promise<boolean> {
  try {
    await fsPromises.access(CLIENT_SECRET_PATH, fs.constants.R_OK);
    await fsPromises.access(TOKEN_PATH, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Probe the token by attempting a real refresh. Returns ok=true if valid. */
export async function checkYouTubeAuth(): Promise<{ ok: boolean; error?: string; obtainedAt?: string }> {
  try {
    await fsPromises.access(CLIENT_SECRET_PATH, fs.constants.R_OK);
    await fsPromises.access(TOKEN_PATH, fs.constants.R_OK);
  } catch {
    return { ok: false, error: 'credentials missing — run youtube-auth.ts' };
  }
  try {
    const tokenFile = JSON.parse(await fsPromises.readFile(TOKEN_PATH, 'utf-8'));
    // Force a fresh refresh (bypass cache) by clearing it temporarily
    cachedAccessToken = null;
    await getAccessToken();
    return { ok: true, obtainedAt: tokenFile.obtainedAt };
  } catch (err) {
    return { ok: false, error: (err as Error).message + causeSuffix(err) };
  }
}

/**
 * Extract .mp4 file paths from text. Mirrors `extractUploadPaths` rules:
 *  - Qualified paths (containing `/`) match always (covers Read tool details, Bash output, etc.)
 *  - Bare filenames match only when paired with an action verb within 80 chars AND
 *    file exists in `projectDirectory` — prevents false positives from prose mentions.
 */
export function extractVideoPaths(text: string, projectDirectory?: string | null): string[] {
  const extAlt = VIDEO_EXTS.map(e => e.slice(1)).join('|');
  // Strip ONLY fenced code blocks (multi-line ``` … ```) — those usually contain example
  // code, not real file references. Do NOT strip inline single-backtick spans — those are
  // the canonical way Claude/Markdown wrap real file references in prose ("output is at
  // `out/tour.mp4`"), and stripping them was silently dropping every backticked path.
  // The qualified-path regex below already requires a `/` in the match, so prose like
  // "use the `foo.mp4` format" can't false-positive (no `/`, doesn't match).
  const stripped = text.replace(/```[\s\S]*?```/g, '');

  const qualifiedPattern = new RegExp(
    `([~.]?/[\\w\\-./]+\\.(?:${extAlt})|[\\w][\\w\\-]*/[\\w\\-./]+\\.(?:${extAlt}))`,
    'gi',
  );
  const resolved = new Set<string>();
  for (const m of stripped.matchAll(qualifiedPattern)) {
    const raw = m[1];
    let abs: string;
    if (raw.startsWith('/')) abs = raw;
    else if (raw.startsWith('~')) abs = raw.replace(/^~/, process.env.HOME ?? '~');
    else if (projectDirectory) abs = path.resolve(projectDirectory, raw);
    else continue;
    resolved.add(abs);
  }

  if (projectDirectory) {
    const bareWithVerbPattern = new RegExp(
      `\\b(?:created|generated|updated|wrote|saved|exported|produced|added|new|rendered|recorded|encoded)\\b[^\\n]{0,80}?\\b([\\w][\\w\\-.]*\\.(?:${extAlt}))\\b`,
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
      } catch { /* ignore stat errors */ }
    }
  }

  return [...resolved];
}

// --- internals -------------------------------------------------------------

async function computeMd5(filePath: string): Promise<string> {
  const hash = crypto.createHash('md5');
  const s = fs.createReadStream(filePath);
  for await (const chunk of s) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function loadLedger(): Promise<Ledger> {
  try {
    const text = await fsPromises.readFile(LEDGER_PATH, 'utf-8');
    return JSON.parse(text) as Ledger;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function saveLedger(ledger: Ledger): Promise<void> {
  await fsPromises.mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  const tmp = LEDGER_PATH + '.tmp';
  await fsPromises.writeFile(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  await fsPromises.rename(tmp, LEDGER_PATH);
}

async function getAccessToken(): Promise<string> {
  // Reuse cached access token if still valid (with 60s buffer)
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const secret = JSON.parse(await fsPromises.readFile(CLIENT_SECRET_PATH, 'utf-8'));
  const tokenFile = JSON.parse(await fsPromises.readFile(TOKEN_PATH, 'utf-8'));
  const clientId: string = secret.installed?.client_id ?? secret.web?.client_id;
  const clientSecret: string = secret.installed?.client_secret ?? secret.web?.client_secret;
  const refreshToken: string = tokenFile.refresh_token;

  if (!clientId || !clientSecret) throw new Error('client_id/client_secret missing in client-secret JSON');
  if (!refreshToken) throw new Error('refresh_token missing — re-run youtube-auth.ts');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OAuth token refresh failed: ${res.status} ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

async function uploadToYouTube(
  filePath: string,
  fileSize: number,
  accessToken: string,
  opts: { title: string; description: string; privacy: 'private' | 'unlisted' | 'public' },
): Promise<{ url: string; videoId: string }> {
  // Step 1: initiate resumable upload — body carries metadata, response Location is upload URL.
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(fileSize),
        'X-Upload-Content-Type': 'video/*',
      },
      body: JSON.stringify({
        snippet: {
          title: opts.title.slice(0, 100), // YouTube hard limit
          description: opts.description.slice(0, 5000),
          categoryId: '22', // People & Blogs — generic neutral category
        },
        status: {
          privacyStatus: opts.privacy,
          selfDeclaredMadeForKids: false,
        },
      }),
    },
  );
  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`YouTube initiate upload failed: ${initRes.status} ${errText.slice(0, 300)}`);
  }
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No Location header in YouTube initiate response');

  // Step 2: PUT the file bytes to the resumable upload URL.
  const fileStream = fs.createReadStream(filePath);
  const webStream = stream.Readable.toWeb(fileStream) as unknown as ReadableStream;
  // `duplex: 'half'` is required by undici when sending a stream body; not yet in TS lib types.
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/*',
      'Content-Length': String(fileSize),
    },
    body: webStream,
    duplex: 'half',
    dispatcher: UPLOAD_DISPATCHER,
  } as RequestInit & { duplex: 'half'; dispatcher: Agent });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`YouTube upload PUT failed: ${uploadRes.status} ${errText.slice(0, 300)}`);
  }
  const result = (await uploadRes.json()) as { id: string };
  if (!result.id) throw new Error('YouTube upload returned no video id');
  return { url: `https://youtu.be/${result.id}`, videoId: result.id };
}

// --- abandoned-draft cleanup ----------------------------------------------
//
// Deletes videos the bot uploaded that were never touched by a human and have gone
// stale. Requires the youtube.force-ssl scope (re-run youtube-auth.ts after the scope
// widening). IRREVERSIBLE — safety is enforced entirely by the 5 gates in
// findAbandonedDrafts: a video must still be OUR ledger entry, still unlisted, still
// carry the bot's exact description fingerprint AND default title, and be old enough.
// Any human edit (rename, re-describe, publish, unlist→private/public) fails a gate.

export const DRAFT_MAX_AGE_HOURS = 48;

/** The exact 3-line description index.ts stamps on every upload (Source/Project/Uploaded). */
const BOT_DESC_RE = /^Source:\s.+\nProject:\s.+\nUploaded:\s(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

const CLEANUP_LOG_PATH = path.join(SECRETS_DIR, 'youtube-cleanup.log');

export interface AbandonedDraft {
  videoId: string;
  title: string;
  uploadedIso: string; // parsed from the LIVE description's `Uploaded:` line
  ageHours: number;
  md5: string;
  sourcePath: string;
}

export interface CleanupResult {
  scanned: number;
  candidates: AbandonedDraft[];
  deleted: string[];
  errors: { videoId: string; error: string }[];
  dryRun: boolean;
}

interface VideoState { id: string; title: string; description: string; privacyStatus: string; }

/** Live snippet+status for up to 50 ids/call. Ids absent from the response (already
 *  deleted, or not owned) are simply omitted from the map. */
async function fetchVideoStates(ids: string[], accessToken: string): Promise<Map<string, VideoState>> {
  const out = new Map<string, VideoState>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&maxResults=50&id=${batch.join(',')}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`videos.list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      items?: Array<{ id: string; snippet?: { title?: string; description?: string }; status?: { privacyStatus?: string } }>;
    };
    for (const it of data.items ?? []) {
      out.set(it.id, {
        id: it.id,
        title: it.snippet?.title ?? '',
        description: it.snippet?.description ?? '',
        privacyStatus: it.status?.privacyStatus ?? '',
      });
    }
  }
  return out;
}

async function deleteVideo(videoId: string, accessToken: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${videoId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 204 && !res.ok) {
    throw new Error(`videos.delete failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Ledger videos that are STILL untouched bot uploads and older than DRAFT_MAX_AGE_HOURS.
 * ALL gates must hold or the video is spared:
 *   1. in our upload ledger (we uploaded it)         — universe is only our own uploads
 *   2. still exists AND privacyStatus === 'unlisted' — human publish/private/delete → skip
 *   3. description matches the bot fingerprint        — human re-describe → skip
 *   4. title === basename(sourcePath) (bot default)   — human rename → skip
 *   5. age (from the LIVE description Uploaded:) ≥ 48h — too new → skip
 */
export async function findAbandonedDrafts(now = new Date()): Promise<{ scanned: number; candidates: AbandonedDraft[] }> {
  const ledger = await loadLedger();
  const entries = Object.entries(ledger);
  if (entries.length === 0) return { scanned: 0, candidates: [] };

  const accessToken = await getAccessToken();
  const ids = entries.map(([, e]) => e.videoId).filter(Boolean);
  const states = await fetchVideoStates(ids, accessToken);

  const candidates: AbandonedDraft[] = [];
  for (const [md5, entry] of entries) {
    const st = states.get(entry.videoId);
    if (!st) continue;                              // gate 2 (already gone / not owned)
    if (st.privacyStatus !== 'unlisted') continue;  // gate 2 (published/privated by human)
    const m = BOT_DESC_RE.exec(st.description);
    if (!m) continue;                               // gate 3 (description edited)
    const expectedTitle = path.basename(entry.sourcePath, path.extname(entry.sourcePath)).slice(0, 100);
    if (st.title !== expectedTitle) continue;       // gate 4 (renamed)
    const uploadedIso = m[1];
    const ageHours = (now.getTime() - new Date(uploadedIso).getTime()) / 3_600_000;
    if (!(ageHours >= DRAFT_MAX_AGE_HOURS)) continue; // gate 5 (too new; NaN-safe — `>=` is false for NaN)
    candidates.push({ videoId: entry.videoId, title: st.title, uploadedIso, ageHours, md5, sourcePath: entry.sourcePath });
  }
  return { scanned: entries.length, candidates };
}

async function appendCleanupLog(line: string): Promise<void> {
  try {
    await fsPromises.appendFile(CLEANUP_LOG_PATH, line.endsWith('\n') ? line : line + '\n', { mode: 0o600 });
  } catch { /* audit logging must never block/throw the delete path */ }
}

/**
 * Scan and (unless dryRun) delete abandoned drafts. Every deletion is removed from the
 * ledger and appended to youtube-cleanup.log. Returns a structured summary for Discord.
 */
export async function cleanupAbandonedDrafts(opts: { dryRun: boolean; now?: Date }): Promise<CleanupResult> {
  const now = opts.now ?? new Date();
  const { scanned, candidates } = await findAbandonedDrafts(now);
  const result: CleanupResult = { scanned, candidates, deleted: [], errors: [], dryRun: opts.dryRun };

  if (opts.dryRun || candidates.length === 0) {
    await appendCleanupLog(
      `[${now.toISOString()}] ${opts.dryRun ? 'DRY-RUN' : 'AUTO'} scanned=${scanned} candidates=${candidates.length}` +
      (candidates.length ? ': ' + candidates.map(c => `${c.videoId}("${c.title}",${c.ageHours.toFixed(0)}h)`).join(', ') : ''),
    );
    return result;
  }

  const accessToken = await getAccessToken();
  const ledger = await loadLedger();
  for (const c of candidates) {
    try {
      await deleteVideo(c.videoId, accessToken);
      result.deleted.push(c.videoId);
      delete ledger[c.md5];
      await appendCleanupLog(`[${now.toISOString()}] DELETED videoId=${c.videoId} title="${c.title}" ageH=${c.ageHours.toFixed(1)} src=${c.sourcePath}`);
    } catch (err) {
      const error = (err as Error).message;
      result.errors.push({ videoId: c.videoId, error });
      await appendCleanupLog(`[${now.toISOString()}] ERROR videoId=${c.videoId} ${error}`);
    }
  }
  await saveLedger(ledger);
  return result;
}
