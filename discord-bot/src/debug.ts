/** Verbose tracing for the bot, gated on DEBUG. Mirrors bridge-server/src/debug.ts.
 *  Scopes: 'discord' (message intake / flush), 'bridge' (bridge-client calls).
 *  DEBUG=1 / true / * turns on everything; unset = silent. */
const raw = process.env.DEBUG ?? '';
const enabled = new Set(
  raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const all = enabled.has('1') || enabled.has('true') || enabled.has('*');

export const debugEnabled = (scope: string): boolean =>
  all || enabled.has(scope.toLowerCase());

export const debug = (scope: string, msg: string, ...args: unknown[]): void => {
  if (!debugEnabled(scope)) return;
  console.log(`[debug:${scope}] ${msg}`, ...args);
};

/** Render an unknown throw for logs: discord.js errors carry a numeric `code`/`status`
 *  that the bare `.message` ("Internal Server Error") hides — which is precisely how a
 *  Discord-side failure got misread as a bridge failure. */
export const describeError = (err: unknown): string => {
  const e = err as { message?: string; name?: string; code?: unknown; status?: unknown; url?: unknown };
  const bits = [e?.name ?? 'Error', JSON.stringify(e?.message ?? String(err))];
  if (e?.code !== undefined) bits.push(`code=${String(e.code)}`);
  if (e?.status !== undefined) bits.push(`status=${String(e.status)}`);
  if (e?.url !== undefined) bits.push(`url=${String(e.url)}`);
  return bits.join(' ');
};

/** Undici's `fetch()` throws a bare `TypeError: fetch failed` on any network-layer
 *  failure (DNS/TLS/socket/reset) — the actual reason (ECONNREFUSED, ENOTFOUND, ETIMEDOUT,
 *  ...) is nested on `.cause`, not `.message`, so callers reading only `.message` see the
 *  same opaque string for every distinct failure. Appends a short `(CODE)` suffix when a
 *  cause is present; only low-level net fields (code/errno/syscall/address/port) ever end
 *  up here, never headers or auth tokens. Returns '' when there's nothing useful to add. */
export const causeSuffix = (err: unknown): string => {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (!cause || typeof cause !== 'object') return '';
  const c = cause as { code?: unknown; message?: unknown };
  const detail = c.code !== undefined ? String(c.code) : c.message !== undefined ? String(c.message) : null;
  return detail ? ` (${detail})` : '';
};
