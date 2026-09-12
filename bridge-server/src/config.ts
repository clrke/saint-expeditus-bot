import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

export const config = {
  port: parseInt(process.env.PORT ?? '3141', 10),
  model: process.env.CLAUDE_MODEL ?? 'haiku',
  memoryDir: path.resolve(process.env.MEMORY_DIR ?? path.join(__dirname, '../../memory')),
  systemDir: path.resolve(process.env.SYSTEM_DIR ?? path.join(__dirname, '../../system')),
  promptFile: path.resolve(process.env.PROMPT_FILE ?? path.join(__dirname, '../../CLAUDE_PROMPT.md')),
  maxToolRounds: parseInt(process.env.MAX_TOOL_ROUNDS ?? '200', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS ?? '180000', 10),
  /** Cap on a single cron-triggered auto-decide turn (cron.ts). Was a hardcoded 15min —
   *  too short whenever a resumed/near-full session needs to self-compact first (observed
   *  routinely taking up to ~30min), which made the cron give up and silently drop the
   *  real response even though the underlying turn kept running to completion in the
   *  background. Default gives a legit 30min compaction real headroom before we consider
   *  it actually stuck (see AUTO_DECIDE_TIMEOUT kill-on-timeout in cron.ts). */
  autoDecideTimeoutMs: parseInt(process.env.AUTO_DECIDE_TIMEOUT_MS ?? String(40 * 60 * 1000), 10),
  maxContextMessages: parseInt(process.env.MAX_CONTEXT_MESSAGES ?? '30', 10),
  maxRequestsPerMinute: parseInt(process.env.MAX_RPM ?? '60', 10),
  retryAttempts: parseInt(process.env.RETRY_ATTEMPTS ?? '2', 10),
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS ?? '1000', 10),
  projectsDir: path.resolve(process.env.PROJECTS_DIR ?? path.join(__dirname, '../../.projects')),
  /** Total message budget per session period. 0 = unlimited (no hourly pacing). */
  sessionLimit: parseInt(process.env.SESSION_LIMIT ?? '0', 10),
  /** Active hours to spread the session budget over (default 12, e.g. 9AM-9PM). */
  sessionLimitHours: parseInt(process.env.SESSION_LIMIT_HOURS ?? '12', 10),
  defaultProvider: (process.env.DEFAULT_PROVIDER ?? 'claude') as 'claude' | 'gemini',
  /** Model for auto-decides — use 'sonnet' to tap into separate Sonnet quota */
  autoDecideModel: process.env.AUTO_DECIDE_MODEL ?? undefined,
  /** Verbose per-request tracing. Comma-separated scopes or '1'/'true' for all.
   *  e.g. DEBUG=ask,session  or  DEBUG=1 */
  debug: process.env.DEBUG ?? '',
} as const;

export type Config = typeof config;
