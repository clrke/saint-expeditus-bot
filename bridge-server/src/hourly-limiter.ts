/**
 * Hourly rate limiter derived from a session budget.
 *
 * Given a total session limit (e.g. 100 messages/day) and the number of
 * active hours to spread it over (e.g. 12 for 9AM–9PM), this computes
 * an hourly hard cap: ceil(sessionLimit / activeHours).
 *
 * Users see how many messages they have left in the current hour and
 * the overall budget so they can pace themselves.
 *
 * State is persisted to disk so it survives pm2 restarts.
 */

import fs from 'node:fs';

export interface HourlyLimiterOpts {
  /** Total message budget for the session period (e.g. per day). 0 = unlimited. */
  sessionLimit: number;
  /** Number of active hours to spread the budget over (default 12). */
  activeHours: number;
  /** Path to persist state to disk. If not set, state is in-memory only. */
  persistPath?: string;
}

interface PersistedState {
  hourBuckets: Record<string, number>;
  windowStart: string | null;
  windowCount: number;
  blockedSlugs: string[];
  lastHourKey: string | null;
  costTracker?: { totalUsd: number; sessionCosts: Record<string, number> };
}

export interface UpstreamUsage {
  /** Messages sent in the current 5-hour window */
  windowCount: number;
  /** When the current 5-hour window started */
  windowStart: string; // ISO
  /** Minutes remaining in the current 5-hour window */
  windowMinutesLeft: number;
  /** Estimated upstream limit (Claude Max 20x ≈ 200-800 prompts/5hrs) */
  estimatedUpstreamLimit: number;
  /** Percentage of estimated upstream limit used */
  usagePercent: number;
}

export interface BudgetStatus {
  hourlyLimit: number;
  usedThisHour: number;
  remainingThisHour: number;
  currentHour: string; // "HH:00"
  unlimited: boolean;
  upstream: UpstreamUsage;
}

/** Claude Max 20x gives ~200-800 Claude Code prompts per 5-hour window */
const UPSTREAM_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
const ESTIMATED_UPSTREAM_LIMIT = 200; // conservative estimate for Claude Code

export class HourlyLimiter {
  private readonly hourlyLimit: number;
  private readonly unlimited: boolean;
  private readonly persistPath: string | undefined;
  /** Map of "YYYY-MM-DD-HH" -> count */
  private hourBuckets = new Map<string, number>();
  /** Upstream 5-hour window tracking */
  private windowStart: Date | null = null;
  private windowCount = 0;
  /** Project slugs blocked by hourly limit, to auto-resume on hour rollover */
  private blockedSlugs = new Set<string>();
  private lastHourKey: string | null = null;
  /** Last known cost data — cached so all saves include it, not just cost-update saves */
  private cachedCostData: { totalUsd: number; sessionCosts: Record<string, number> } | undefined;

  constructor(opts: HourlyLimiterOpts) {
    this.persistPath = opts.persistPath;
    if (opts.sessionLimit <= 0 || opts.activeHours <= 0) {
      this.hourlyLimit = 0;
      this.unlimited = true;
    } else {
      this.hourlyLimit = Math.ceil(opts.sessionLimit / opts.activeHours);
      this.unlimited = false;
    }
    this.load();
  }

  private bucketKey(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}`;
  }

  private prevBucketKey(now = new Date()): string {
    const prev = new Date(now);
    prev.setHours(prev.getHours() - 1);
    return this.bucketKey(prev);
  }

  /** Effective limit = base + unused from previous hour (capped at 2x base). */
  private effectiveLimit(now = new Date()): number {
    const prevKey = this.prevBucketKey(now);
    const prevUsed = this.hourBuckets.get(prevKey) ?? 0;
    const rollover = Math.max(0, this.hourlyLimit - prevUsed);
    return Math.min(this.hourlyLimit * 2, this.hourlyLimit + rollover);
  }

  /** Try to consume one message. Returns null if allowed, or a rejection message if over budget. */
  tryConsume(now = new Date()): string | null {
    this.rollWindow(now);

    if (!this.unlimited) {
      this.prune(now);
      const key = this.bucketKey(now);
      const used = this.hourBuckets.get(key) ?? 0;
      const limit = this.effectiveLimit(now);

      if (used >= limit) {
        const minutesLeft = 60 - now.getMinutes();
        return `Hourly limit reached (${used}/${limit} incl. rollover). Try again in ~${minutesLeft} min.`;
      }

      this.hourBuckets.set(key, used + 1);
    }

    this.windowCount++;
    const pct = Math.round((this.windowCount / ESTIMATED_UPSTREAM_LIMIT) * 100);
    if (pct >= 80) {
      console.log(`[HourlyLimiter] WARNING: ${this.windowCount}/${ESTIMATED_UPSTREAM_LIMIT} (~${pct}%) of estimated upstream limit used in current 5hr window`);
    } else if (pct >= 50) {
      console.log(`[HourlyLimiter] ${this.windowCount}/${ESTIMATED_UPSTREAM_LIMIT} (~${pct}%) of estimated upstream limit`);
    }

    this.save();
    return null;
  }

  /** Get current budget status without consuming. */
  getStatus(now = new Date()): BudgetStatus {
    this.rollWindow(now);
    const upstream = this.getUpstreamUsage(now);

    if (this.unlimited) {
      return {
        hourlyLimit: 0,
        usedThisHour: 0,
        remainingThisHour: Infinity,
        currentHour: `${String(now.getHours()).padStart(2, '0')}:00`,
        unlimited: true,
        upstream,
      };
    }

    const key = this.bucketKey(now);
    const used = this.hourBuckets.get(key) ?? 0;
    const limit = this.effectiveLimit(now);
    return {
      hourlyLimit: limit,
      usedThisHour: used,
      remainingThisHour: Math.max(0, limit - used),
      currentHour: `${String(now.getHours()).padStart(2, '0')}:00`,
      unlimited: false,
      upstream,
    };
  }

  /** Record a project slug that was blocked by the hourly limit. */
  recordBlocked(slug: string): void {
    this.blockedSlugs.add(slug);
    this.save();
  }

  /** Check if the hour rolled over and return blocked slugs to resume. Clears the set. */
  drainBlocked(now = new Date()): string[] {
    const key = this.bucketKey(now);
    if (this.lastHourKey && this.lastHourKey !== key && this.blockedSlugs.size > 0) {
      const slugs = [...this.blockedSlugs];
      this.blockedSlugs.clear();
      this.lastHourKey = key;
      return slugs;
    }
    this.lastHourKey = key;
    return [];
  }

  /** Remove old hour buckets, keeping current + previous (for rollover). */
  private prune(now: Date): void {
    const currentKey = this.bucketKey(now);
    const prevKey = this.prevBucketKey(now);
    for (const key of this.hourBuckets.keys()) {
      if (key !== currentKey && key !== prevKey) {
        this.hourBuckets.delete(key);
      }
    }
  }

  /** Roll over the 5-hour upstream window if expired or not yet started. */
  private rollWindow(now: Date): void {
    if (!this.windowStart) {
      this.windowStart = now;
      this.windowCount = 0;
      return;
    }
    const elapsed = now.getTime() - this.windowStart.getTime();
    if (elapsed >= UPSTREAM_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
  }

  /** Persist state to disk. Pass costData to update the cached cost tracker. */
  save(costData?: { totalUsd: number; sessionCosts: Record<string, number> }): void {
    if (!this.persistPath) return;
    if (costData !== undefined) this.cachedCostData = costData;
    try {
      const state: PersistedState = {
        hourBuckets: Object.fromEntries(this.hourBuckets),
        windowStart: this.windowStart?.toISOString() ?? null,
        windowCount: this.windowCount,
        blockedSlugs: [...this.blockedSlugs],
        lastHourKey: this.lastHourKey,
        costTracker: this.cachedCostData,
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(state));
    } catch (err) {
      console.error(`[HourlyLimiter] Failed to persist state: ${(err as Error).message}`);
    }
  }

  /** Load persisted state from disk. */
  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const state: PersistedState = JSON.parse(raw);
      this.hourBuckets = new Map(Object.entries(state.hourBuckets));
      this.windowStart = state.windowStart ? new Date(state.windowStart) : null;
      this.windowCount = state.windowCount;
      this.blockedSlugs = new Set(state.blockedSlugs);
      this.lastHourKey = state.lastHourKey;
      this.cachedCostData = state.costTracker;
      console.log(`[HourlyLimiter] Restored state: window ${this.windowCount} prompts, ${this.blockedSlugs.size} blocked`);
    } catch {
      // No file or invalid — start fresh
    }
  }

  /** Get the persisted cost data (for session-manager to restore). */
  getPersistedCostData(): { totalUsd: number; sessionCosts: Record<string, number> } | undefined {
    return this.cachedCostData;
  }

  /** Get upstream usage stats for the current 5-hour window. */
  private getUpstreamUsage(now: Date): UpstreamUsage {
    const start = this.windowStart ?? now;
    const elapsed = now.getTime() - start.getTime();
    const minutesLeft = Math.max(0, Math.round((UPSTREAM_WINDOW_MS - elapsed) / 60_000));
    return {
      windowCount: this.windowCount,
      windowStart: start.toISOString(),
      windowMinutesLeft: minutesLeft,
      estimatedUpstreamLimit: ESTIMATED_UPSTREAM_LIMIT,
      usagePercent: Math.round((this.windowCount / ESTIMATED_UPSTREAM_LIMIT) * 100),
    };
  }
}
