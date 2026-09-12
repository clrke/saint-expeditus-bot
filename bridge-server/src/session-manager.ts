import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';

export type Provider = 'claude' | 'gemini';

export interface SessionQueryOptions {
  cwd: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  provider?: Provider;
  onMessage?: (text: string) => void;
  onToolUse?: (name: string, detail: string) => void;
}

export interface QueryResult {
  text: string;
  messages: string[]; // all assistant text messages in order
  toolsUsed: string[];
  sessionId: string;
  costUsd: number;
  /** Context window usage percentage (0-100), from CLI init event */
  contextUsedPct: number | null;
}

interface SessionState {
  sessionId: string | undefined;
  forceNew: boolean;
  mutex: Promise<void>;
  process: ChildProcess | null;
  /** Prevents concurrent spawns for the same slug */
  locked: boolean;
  lockedAt: number;
  /** Set by stop() so the kill is reported as a deliberate user stop, not a crash. */
  stopRequested: boolean;
}

/** Cost tracking across all sessions */
const costTracker = {
  totalUsd: 0,
  sessionCosts: new Map<string, number>(),
  onUpdate: null as (() => void) | null,
};

export function getCostStats(): { totalUsd: number; sessionCosts: Record<string, number> } {
  return {
    totalUsd: costTracker.totalUsd,
    sessionCosts: Object.fromEntries(costTracker.sessionCosts),
  };
}

/** Restore cost data from persisted state and set up save callback. */
export function initCostTracker(
  data?: { totalUsd: number; sessionCosts: Record<string, number> },
  onUpdate?: () => void,
): void {
  if (data) {
    costTracker.totalUsd = data.totalUsd;
    costTracker.sessionCosts = new Map(Object.entries(data.sessionCosts));
    console.log(`[SessionManager] Restored costs: $${data.totalUsd.toFixed(4)} across ${Object.keys(data.sessionCosts).length} sessions`);
  }
  if (onUpdate) {
    costTracker.onUpdate = onUpdate;
  }
}

// Allow full path override via CLAUDE_PATH env var — needed when PM2 doesn't inherit nvm PATH
const CLAUDE_BIN = process.env.CLAUDE_PATH ?? 'claude';

/**
 * Collect a pid and all its descendants, deepest-last, by walking `pgrep -P`.
 * Used to stop a whole CLI turn: the `claude` child may itself have spawned
 * long-running grandchildren (Bash tool: builds, test suites, ffmpeg). Killing
 * only the direct child leaves those orphaned AND can keep the inherited stdout
 * pipe open, so the 'close' handler never fires and the turn never unblocks.
 *
 * NEVER kill by process group here — the CLI is spawned WITHOUT `detached`, so
 * it shares the bridge's own group and `kill(-pgid)` would take down the bridge.
 */
function collectDescendants(pid: number, depth = 0): number[] {
  if (depth > 10) return []; // paranoia: cycles can't happen, runaway depth can
  let children: number[] = [];
  try {
    children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' })
      .split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return []; // pgrep exits 1 when there are no children — not an error
  }
  return children.flatMap(c => [...collectDescendants(c, depth + 1), c]);
}

/** Best-effort signal to a pid and every descendant. Returns how many pids were signalled. */
function killTree(pid: number, signal: NodeJS.Signals): number {
  let n = 0;
  for (const p of [...collectDescendants(pid), pid]) {
    try {
      process.kill(p, signal);
      n++;
    } catch { /* already gone */ }
  }
  return n;
}

// A CLI is_error result whose text matches this is a transient upstream failure worth
// retrying (API 500 / overload / gateway / timeout) rather than surfacing to the user.
// Deliberately NARROW: max-turns, permission, and other deterministic errors must NOT match.
const TRANSIENT_UPSTREAM_RE =
  /internal server error|overloaded|\b50[0234]\b|bad gateway|gateway timeout|service unavailable|timed? ?out|temporarily|econnreset|socket hang up|try again/i;
const MAX_TRANSIENT_RETRIES = 2;

/** Grace period between the SIGTERM and the SIGKILL escalation in stop(). */
const STOP_GRACE_MS = 5_000;

/** Message thrown when a turn was deliberately stopped — clients special-case this. */
export const STOPPED_BY_USER = 'Stopped by user 🛑';

interface GeminiHistoryItem {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private geminiHistories = new Map<string, GeminiHistoryItem[]>();
  private geminiHistoryPath: string;

  constructor(private config: Config) {
    this.geminiHistoryPath = path.resolve(config.projectsDir, '../.gemini-history.json');
    this.loadGeminiHistories();
  }

  private loadGeminiHistories(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.geminiHistoryPath, 'utf-8'));
      for (const [slug, history] of Object.entries(data)) {
        this.geminiHistories.set(slug, history as GeminiHistoryItem[]);
      }
      console.log(`[SessionManager] Restored Gemini history for ${Object.keys(data).length} projects`);
    } catch {
      // No file or invalid — start fresh
    }
  }

  private saveGeminiHistories(): void {
    const data: Record<string, GeminiHistoryItem[]> = {};
    for (const [slug, history] of this.geminiHistories) {
      data[slug] = history;
    }
    try {
      fs.writeFileSync(this.geminiHistoryPath, JSON.stringify(data), 'utf-8');
    } catch (err) {
      console.error(`[SessionManager] Failed to persist Gemini history: ${(err as Error).message}`);
    }
  }

  loadSession(slug: string, sessionId: string): void {
    this.getOrCreate(slug).sessionId = sessionId;
    console.log(`[SessionManager] Loaded session for ${slug}: ${sessionId}`);
  }

  resetSession(slug: string): void {
    const state = this.getOrCreate(slug);
    state.forceNew = true;
    state.sessionId = undefined;
    this.geminiHistories.delete(slug);
    this.saveGeminiHistories();
    console.log(`[SessionManager] Reset session for ${slug}`);
  }

  /**
   * Force-stop the in-flight turn for a slug (🛑 reaction in Discord).
   *
   * SIGTERMs the CLI child and every descendant, then escalates to SIGKILL after a
   * grace period for anything that ignored the first signal. The session ID is left
   * intact on purpose — a stop ends the *turn*, not the conversation, so the next
   * message resumes with full context. Use /reset to actually discard the session.
   *
   * Queued follow-ups (see `query()`'s mutex chain) are NOT cancelled: stopping is
   * about killing the thing that's currently burning time, and a queued message the
   * user typed is still something they asked for.
   */
  stop(slug: string): { stopped: boolean; reason: string } {
    const state = this.sessions.get(slug);
    if (!state) return { stopped: false, reason: `No session for /${slug}` };
    const proc = state.process;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null || !proc.pid) {
      return { stopped: false, reason: `Nothing running for /${slug}` };
    }

    const pid = proc.pid;
    state.stopRequested = true;
    const n = killTree(pid, 'SIGTERM');
    const ranForMs = state.lockedAt ? Date.now() - state.lockedAt : 0;
    console.warn(`[SessionManager] ${slug}: STOP requested — SIGTERM to ${n} pid(s) (root ${pid}, running ${(ranForMs / 1000).toFixed(1)}s)`);

    setTimeout(() => {
      // Only escalate if this exact process is still the live one — a fast SIGTERM
      // exit may already have let the next queued turn spawn a *different* child.
      if (state.process === proc && proc.exitCode === null && proc.signalCode === null) {
        const k = killTree(pid, 'SIGKILL');
        console.warn(`[SessionManager] ${slug}: STOP escalated — SIGKILL to ${k} pid(s)`);
      }
    }, STOP_GRACE_MS).unref();

    return { stopped: true, reason: `Stopped /${slug} after ${(ranForMs / 1000).toFixed(0)}s (${n} process${n === 1 ? '' : 'es'})` };
  }

  /** True when a turn is currently running for this slug. */
  isRunning(slug: string): boolean {
    const proc = this.sessions.get(slug)?.process;
    return !!proc && proc.exitCode === null && proc.signalCode === null;
  }

  /** True when ANY project has a turn currently running (live process). Used by the cron
   *  quiet-window watcher (`.projects/.quiet-watch`) to detect a safe restart moment. */
  anyRunning(): boolean {
    for (const slug of this.sessions.keys()) {
      if (this.isRunning(slug)) return true;
    }
    return false;
  }

  getSessionId(slug: string): string | undefined {
    return this.sessions.get(slug)?.sessionId;
  }

  // NOTE: session "discovery" (adopt the newest session in a project's directory) was removed
  // deliberately. It took `sessions[0]` from `claude sessions list` with no check of ownership
  // or liveness, which (a) hijacked a human's concurrent interactive `claude` session when the
  // project directory was a repo they were working in — two processes driving one session file,
  // surfacing as "Internal Server Error" — and (b) silently defeated /reset, since it fired
  // exactly when sessionId was null and re-adopted the session that was just wiped.
  // A project with no sessionId now simply starts a fresh session.

  async query(slug: string, prompt: string, opts: SessionQueryOptions): Promise<QueryResult> {
    const state = this.getOrCreate(slug);

    // Queue behind any in-flight query for this slug instead of killing it — a follow-up
    // message no longer aborts a response that's still being generated; it now runs after.
    // `mutex` is a chain of ALWAYS-settled promises (rejections swallowed below) so one
    // failed query never wedges the queue for whatever comes after it.
    const run = state.mutex.then(async () => {
      state.locked = true;
      state.lockedAt = Date.now();
      try {
        return await this.runQuery(slug, state, prompt, opts);
      } finally {
        state.locked = false;
      }
    });
    state.mutex = run.then(() => undefined, () => undefined);
    return run;
  }

  private getOrCreate(slug: string): SessionState {
    let state = this.sessions.get(slug);
    if (!state) {
      state = { sessionId: undefined, forceNew: false, mutex: Promise.resolve(), process: null, locked: false, lockedAt: 0, stopRequested: false };
      this.sessions.set(slug, state);
    }
    return state;
  }

  private cleanEnv(): Record<string, string> {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    // Raise Claude CLI's Bash tool timeouts. CLI defaults are 2 min default / 10 min max,
    // which silently terminate long-running tool calls (builds, large test suites, agentic
    // loops). Override here so Claude has runway. Caller can still set `timeout` per-Bash
    // up to the max. Bridge env can override via BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS.
    env.BASH_DEFAULT_TIMEOUT_MS = process.env.BASH_DEFAULT_TIMEOUT_MS ?? String(10 * 60 * 1000);  // 10 min
    env.BASH_MAX_TIMEOUT_MS = process.env.BASH_MAX_TIMEOUT_MS ?? String(60 * 60 * 1000);          // 60 min
    return env as Record<string, string>;
  }

  private buildArgs(prompt: string, opts: SessionQueryOptions, resumeSessionId?: string): string[] {
    const args: string[] = [];

    if (opts.provider === 'claude') {
      args.push(
        '--print',
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--verbose',
      );
      if (opts.model) args.push('--model', opts.model);
      if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
      if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools);
      if (opts.maxTurns ?? this.config.maxToolRounds) {
        args.push('--max-turns', String(opts.maxTurns ?? this.config.maxToolRounds));
      }
      if (resumeSessionId) args.push('--resume', resumeSessionId);
      // `--` closes off option parsing before the positional prompt — without it, a prompt
      // that starts with `-` (e.g. Discord `-#` subtext, a markdown `- ` bullet) gets parsed
      // as an unknown CLI flag and the whole turn fails in ~0.1s with no partial output.
      args.push('--', prompt); // Positional argument for Claude
    } else if (opts.provider === 'gemini') {
      args.push('-y'); // YOLO mode
      args.push('-p', prompt); // Prompt via -p flag
      args.push('-m', 'gemini-2.5-flash'); // Specific model
    }

    return args;
  }

  private async runQuery(
    slug: string,
    state: SessionState,
    prompt: string,
    opts: SessionQueryOptions,
  ): Promise<QueryResult> {
    if (state.forceNew) {
      state.forceNew = false;
      this.geminiHistories.delete(slug);
      state.sessionId = undefined;
      console.log(`[SessionManager] ${slug}: fresh conversation (reset requested)`);
    }

    const provider = opts.provider ?? 'claude';
    const start = Date.now();
    // Hoisted out of the try's claude branch so the catch below can tell whether
    // this attempt actually tried to resume an existing session (vs. already being
    // fresh) — only retry-as-fresh when a resume was the thing that failed.
    let resumeWasAttempted = false;

    try {
      let result: QueryResult;
      if (provider === 'gemini') {
        const history = this.geminiHistories.get(slug) ?? [];
        const historyText = history
          .flatMap(h => [h.role === 'user' ? 'User:' : 'Assistant:', ...h.parts.map(p => p.text)])
          .join(' ');
        
        const fullPrompt = historyText ? `${historyText} User: ${prompt}` : prompt;
        
        console.log(`[SessionManager] ${slug}: calling gemini CLI (history: ${history.length} turns)...`);
        result = await this.spawnGemini(slug, state, fullPrompt, opts);
        
        // Keep last 10 turns (20 items) to avoid exceeding token limits
        const MAX_GEMINI_HISTORY = 20;
        const newHistory: GeminiHistoryItem[] = [
          ...history,
          { role: 'user' as const, parts: [{ text: prompt }] },
          { role: 'model' as const, parts: [{ text: result.text.slice(0, 2000) }] }, // Cap response size in history
        ].slice(-MAX_GEMINI_HISTORY);
        this.geminiHistories.set(slug, newHistory);
        this.saveGeminiHistories();

      } else { // claude
        const shouldResume = !state.forceNew && !!state.sessionId;
        resumeWasAttempted = shouldResume;
        const resumeId = shouldResume ? state.sessionId : undefined;
        // Log the exact session id being resumed + cwd. A session id shared across two
        // running processes (e.g. a project whose dir is a repo the human is also driving
        // interactively) surfaces as "Internal Server Error" — this line makes that visible.
        console.log(`[SessionManager] ${slug}: calling claude CLI (resume: ${shouldResume}${resumeId ? ` ${resumeId}` : ''}, cwd: ${opts.cwd ?? '?'})`);
        // Retry loop for transient upstream failures (API 500 / overload / timeout). On retry,
        // resume whatever session the CLI last reported so we continue the same conversation
        // rather than spawning duplicates. Deterministic errors are NOT retried (RE is narrow).
        let attempt = 0;
        for (;;) {
          try {
            const rid = (!state.forceNew && state.sessionId) ? state.sessionId : resumeId;
            result = await this.spawnClaude(slug, state, prompt, opts, rid);
            break;
          } catch (e) {
            if (TRANSIENT_UPSTREAM_RE.test((e as Error).message) && attempt < MAX_TRANSIENT_RETRIES) {
              attempt++;
              const backoffMs = 1500 * attempt;
              console.warn(`[SessionManager] ${slug}: transient upstream error — retry ${attempt}/${MAX_TRANSIENT_RETRIES} in ${backoffMs}ms (${(e as Error).message.slice(0, 100)})`);
              await new Promise(r => setTimeout(r, backoffMs));
              continue;
            }
            throw e;
          }
        }
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[SessionManager] ${slug}: done in ${elapsed}s (${result.text.length} chars)`);
      return result;

    } catch (err) {
      if ((err as Error).message.includes('killed')) {
        // Two ways to get here: a deliberate stop() (🛑 reaction), or something
        // external (OS, pm2, manual kill) terminating the child out from under us.
        // The flag is consumed here so it can't leak into a later, unrelated failure.
        if (state.stopRequested) {
          state.stopRequested = false;
          console.log(`[SessionManager] ${slug}: turn stopped by user`);
          throw new Error(STOPPED_BY_USER);
        }
        throw new Error('Query aborted: process terminated unexpectedly');
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const errMessage = (err as Error).message;
      console.error(`[SessionManager] ${slug}: failed after ${elapsed}s: ${errMessage}`);
      // Resume can fail two ways: the literal --resume flag path failing (message
      // mentions "resume"), or the CLI accepting the flag but rejecting the session
      // ID itself once it no longer exists on disk (observed message: "No conversation
      // found with session ID: <uuid>" — notably does NOT contain the word "resume").
      // Sessions get pruned after long inactivity, so any long-dormant project can hit
      // this. Either way the fix is the same: drop the stale ID and start fresh.
      const isStaleResume = /resume|no conversation found/i.test(errMessage);
      if (provider === 'claude' && isStaleResume && resumeWasAttempted) {
        console.log(`[SessionManager] ${slug}: resume failed (stale/missing session), starting fresh...`);
        state.sessionId = undefined;
        return this.runQuery(slug, state, prompt, opts);
      }
      throw err;
    } finally {
      if (state.process) {
        state.process = null;
      }
      // Clear unconditionally: a stop() can lose the race and land after the process
      // already exited cleanly, and a flag left set would mislabel the *next* failure
      // as a user stop. The catch above reads it before this runs.
      state.stopRequested = false;
    }
  }

  private spawnClaude(
    slug: string,
    state: SessionState,
    prompt: string,
    opts: SessionQueryOptions,
    resumeSessionId?: string,
  ): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(prompt, { ...opts, provider: 'claude' }, resumeSessionId);
      const proc = spawn(CLAUDE_BIN, args, {
        cwd: opts.cwd,
        env: this.cleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      state.process = proc;

      const toolsUsed: string[] = [];
      const messages: string[] = [];
      let resultText = '';
      let resultIsError = false;
      let resultSubtype = '';
      let costUsd = 0;
      let contextUsedPct: number | null = null;
      let killed = false;

      proc.on('error', (err) => {
        if (!killed) reject(err);
      });

      proc.stdin.end();

      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const m = JSON.parse(line);
          if (m.type === 'system' && m.subtype === 'init') {
            state.sessionId = m.session_id;
            console.log(`[SessionManager] ${slug}: session ${state.sessionId}`);
          }
          // Context usage: use the LAST iteration's token counts (most recent API call).
          // Top-level cache_read_input_tokens sums across all iterations and exceeds
          // the context window — only per-iteration counts give a reliable snapshot.
          if (m.type === 'result' && m.usage) {
            const u = m.usage;
            const iterations = Array.isArray(u.iterations) ? u.iterations : [];
            // Use the LAST iteration (most recent, largest context in the query)
            const iter = iterations.length > 0 ? iterations[iterations.length - 1] : null;
            if (iter) {
              const totalTokens = (iter.input_tokens ?? 0) + (iter.cache_creation_input_tokens ?? 0) + (iter.cache_read_input_tokens ?? 0);
              const modelKey = m.modelUsage ? Object.keys(m.modelUsage)[0] ?? '' : '';
              // Parse context window from model key suffix e.g. [1m]=1M, [200k]=200K
              const kwMatch = modelKey.match(/\[(\d+)(m|k)\]/i);
              const contextWindow = kwMatch
                ? (kwMatch[2].toLowerCase() === 'm' ? Number(kwMatch[1]) * 1_000_000 : Number(kwMatch[1]) * 1_000)
                : 200_000;
              if (totalTokens > 0 && contextWindow > 0) {
                // Cap at 100% — if we somehow exceed it, just show 100%
                contextUsedPct = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
                console.log(`[SessionManager] ${slug}: context ${contextUsedPct}% (${totalTokens.toLocaleString()}/${contextWindow.toLocaleString()} over ${iterations.length} iter${iterations.length !== 1 ? 's' : ''})`);
              }
            }
          }
          if (m.type === 'assistant' && m.message?.content) {
            for (const block of m.message.content) {
              if (block.type === 'text' && block.text) {
                const trimmed = block.text.trim();
                if (trimmed) {
                  messages.push(trimmed);
                  opts.onMessage?.(trimmed);
                }
                resultText = block.text;
              }
              if (block.type === 'tool_use' && block.name) {
                toolsUsed.push(block.name);
                const detail = this.formatToolDetail(block.name, block.input ? block.input : {});
                if (opts.onToolUse) {
                  // Tools that need their full payload preserved for client-side rendering
                  // (TodoWrite → progress bar, AskUserQuestion → question+options layout).
                  const maxLen = block.name === 'TodoWrite' || block.name === 'AskUserQuestion' ? 8000 : 1500;
                  opts.onToolUse(block.name, detail.slice(0, maxLen));
                }
              }
            }
          }
          if (m.type === 'result') {
            if (m.result) resultText = m.result;
            if (m.cost_usd) costUsd = m.cost_usd;
            if (m.session_id) state.sessionId = m.session_id;
            // Surface error/non-success result envelopes. The CLI relays upstream API
            // failures (e.g. a 500 → "Internal Server Error") and turn-limit stops here as
            // a `result` with is_error/subtype set; we otherwise swallow them into resultText
            // with no trace. This log is the breadcrumb for "why did the user see an error".
            if (m.is_error || (m.subtype && m.subtype !== 'success')) {
              resultIsError = true;
              resultSubtype = m.subtype ?? '';
              console.warn(`[SessionManager] ${slug}: result subtype=${m.subtype ?? '?'} is_error=${!!m.is_error} result=${JSON.stringify(String(m.result ?? '')).slice(0, 200)}`);
            }
          }
        } catch { /* skip unparseable lines */ }
      });

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code, signal) => {
        // One breadcrumb per process exit: the exit code/signal plus what we actually
        // collected (result/message/stderr sizes). Non-clean exits were previously opaque —
        // this pins down kill-vs-crash-vs-empty at a glance.
        if (code !== 0 || signal || (!resultText && messages.length === 0)) {
          console.warn(`[SessionManager] ${slug}: proc closed code=${code} signal=${signal ?? 'none'} resultLen=${resultText.length} messages=${messages.length} stderrLen=${stderr.length}${stderr ? ` stderr="${stderr.slice(0, 160).replace(/\n/g, ' ')}"` : ''}`);
        }
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          killed = true;
          return reject(new Error('Process killed'));
        }
        // Transient upstream failure (API 500 / overload / timeout) relayed by the CLI as
        // an is_error result. Reject with a marker so runQuery retries instead of forwarding
        // "Internal Server Error" to the user. Non-transient errors (e.g. max_turns) fall
        // through and return their partial result as before.
        if (resultIsError && !killed && TRANSIENT_UPSTREAM_RE.test(resultText)) {
          return reject(new Error(`UPSTREAM_TRANSIENT [${resultSubtype || 'error'}]: ${resultText.slice(0, 160)}`));
        }
        if (code !== 0 && !resultText && messages.length === 0) {
          return reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
        if (!resultText && messages.length === 0) {
          return reject(new Error('Claude CLI returned empty response'));
        }
        if (costUsd > 0) {
          costTracker.totalUsd += costUsd;
          costTracker.sessionCosts.set(slug, (costTracker.sessionCosts.get(slug) ?? 0) + costUsd);
          console.log(`[SessionManager] ${slug}: cost ${costUsd.toFixed(4)} (total: ${costTracker.totalUsd.toFixed(4)})`);
          costTracker.onUpdate?.();
        }
        resolve({ text: resultText.trim(), messages, toolsUsed, sessionId: state.sessionId ?? '', costUsd, contextUsedPct });
      });
    });
  }

  private spawnGemini(
    slug: string,
    state: SessionState,
    prompt: string,
    opts: SessionQueryOptions,
  ): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const geminiScriptPath = '/Users/arke/.nvm/versions/node/v18.20.8/bin/gemini';
      const baseArgs = this.buildArgs(prompt, { ...opts, provider: 'gemini' });
      const args = [geminiScriptPath, ...baseArgs];

      const proc = spawn('node', args, {
        cwd: opts.cwd,
        env: { ...process.env } as Record<string, string>,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      state.process = proc;

      const toolsUsed: string[] = [];
      const messages: string[] = [];
      let resultText = '';
      let costUsd = 0;
      let killed = false;

      proc.on('error', (err) => {
        if (!killed) reject(err);
      });

      // Gemini CLI outputs plain text with no newlines between steps.
      // Use raw data events + periodic flush for streaming to Discord.
      let pending = '';
      const FLUSH_INTERVAL_MS = 2000;

      const flushPending = () => {
        const chunk = pending.trim();
        if (!chunk) return;
        pending = '';
        messages.push(chunk);
        opts.onMessage?.(chunk);
      };

      const flushTimer = setInterval(flushPending, FLUSH_INTERVAL_MS);

      proc.stdout.on('data', (d: Buffer) => {
        const text = d.toString();
        resultText += text;
        pending += text;
      });

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code, signal) => {
        clearInterval(flushTimer);
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          killed = true;
          return reject(new Error('Process killed'));
        }
        // Flush any remaining lines
        flushPending();
        const trimmed = resultText.trim();
        if (code !== 0 && !trimmed) {
          return reject(new Error(`Gemini CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
        if (!trimmed) {
          return reject(new Error(`Gemini CLI returned empty response${stderr ? ': ' + stderr.slice(0, 200) : ''}`));
        }
        resolve({ text: trimmed, messages, toolsUsed, sessionId: '', costUsd, contextUsedPct: null });
      });
    });
  }

  async waitForIdle(maxMs: number = 60_000, pollMs: number = 200): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      let anyLocked = false;
      for (const state of this.sessions.values()) {
        if (state.locked) { anyLocked = true; break; }
      }
      if (!anyLocked) return true;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return false;
  }

  private formatToolDetail(name: string, input: any): string {
    switch (name) {
      case 'Read': {
        const fp = input.file_path ?? '';
        const offset = input.offset ? `:${input.offset}` : '';
        const limit = input.limit ? `-${(input.offset ?? 0) + input.limit}` : '';
        return `${fp}${offset}${limit}`;
      }
      case 'Edit': {
        const fp = input.file_path ?? '';
        // Defuse triple-backticks in user content so they don't terminate Discord's outer
        // code fence prematurely (zero-width space breaks Discord's parser without changing
        // what the human sees). Same trick used in echoFinalPrompt.
        const oldStr = (input.old_string ?? '').replace(/```/g, '​```').slice(0, 500);
        const newStr = (input.new_string ?? '').replace(/```/g, '​```').slice(0, 500);
        const oldArr = oldStr.split('\n');
        const newArr = newStr.split('\n');

        const diffLines: string[] = [];
        let oldLine = 1, newLine = 1;
        let i = 0, j = 0;
        while (i < oldArr.length || j < newArr.length) {
          const ol = i < oldArr.length ? oldArr[i] : undefined;
          const nl = j < newArr.length ? newArr[j] : undefined;
          if (ol === nl) {
            diffLines.push(`  ${String(oldLine).padStart(3)} ${ol}`);
            i++; j++; oldLine++; newLine++;
          } else {
            if (ol !== undefined) { diffLines.push(`- ${String(oldLine).padStart(3)} ${ol}`); i++; oldLine++; }
            if (nl !== undefined) { diffLines.push(`+ ${String(newLine).padStart(3)} ${nl}`); j++; newLine++; }
          }
        }

        return `${fp}\n\`\`\`diff\n${diffLines.join('\n')}\n\`\`\``;
      }
      case 'Write': {
        const content = input.content ?? '';
        // Defuse triple-backticks before slicing so they don't terminate Discord's outer
        // code fence prematurely (zero-width space defeats the parser without changing
        // what the human sees). Newlines pass through verbatim — they render as real line
        // breaks inside the ``` fence (matches Edit's behavior). The previous version
        // escaped \n to literal "\n" which made multi-line file previews unreadable.
        const preview = content.replace(/```/g, '​```').slice(0, 500);
        return `${input.file_path ?? ''} (${content.length} chars)\n\`\`\`\n${preview}\n\`\`\``;
      }
      case 'Bash': {
        const cmd = input.command?.slice(0, 200) ?? '';
        const timeout = input.timeout ? ` (${Math.round(input.timeout / 1000)}s timeout)` : '';
        return `${cmd}${timeout}`;
      }
      case 'MultiEdit': {
        const edits: Array<{ file_path?: string; old_string?: string; new_string?: string }> =
          Array.isArray(input.edits) ? input.edits : [];
        return edits.map(e => {
          const fp = e.file_path ?? '';
          const removed = (e.old_string ?? '').split('\n').length;
          const added = (e.new_string ?? '').split('\n').length;
          return `${fp} (-${removed} +${added} lines)`;
        }).join('\n');
      }
      case 'Grep': return `"${input.pattern ?? ''}" in ${input.path ?? '.'}`;
      case 'Glob': return input.pattern ?? '';
      case 'WebFetch': return input.url ?? '';
      case 'WebSearch': return input.query ?? '';
      case 'Agent': return JSON.stringify({ description: input.description, subagent_type: input.subagent_type, prompt: input.prompt?.slice(0, 300) });
      case 'TodoWrite': return JSON.stringify(input);
      case 'AskUserQuestion': return JSON.stringify(input);
      default: return JSON.stringify(input).slice(0, 300);
    }
  }
}
