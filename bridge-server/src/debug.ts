import { config } from './config.js';

/** Scopes enabled via DEBUG. '1'/'true'/'*' turns on everything; otherwise a
 *  comma-separated allowlist (e.g. DEBUG=ask,session). Empty = silent. */
const enabled = new Set(
  config.debug
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const all = enabled.has('1') || enabled.has('true') || enabled.has('*');

export const debugEnabled = (scope: string): boolean =>
  all || enabled.has(scope.toLowerCase());

/** Verbose trace line, gated on DEBUG. Args are only stringified when the scope
 *  is on, so callers may pass expensive values without paying for them in prod. */
export const debug = (scope: string, msg: string, ...args: unknown[]): void => {
  if (!debugEnabled(scope)) return;
  console.log(`[debug:${scope}] ${msg}`, ...args);
};

/** Millisecond timer for span logging. Returns a function that logs elapsed ms. */
export const debugTimer = (scope: string, label: string): ((note?: string) => void) => {
  if (!debugEnabled(scope)) return () => {};
  const start = Date.now();
  return (note?: string) =>
    console.log(`[debug:${scope}] ${label} took ${Date.now() - start}ms${note ? ` (${note})` : ''}`);
};
