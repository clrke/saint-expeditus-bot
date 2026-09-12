import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCronJobs } from '../src/cron.js';
import type { CronDeps } from '../src/cron.js';
import type { ProjectStore } from '../src/project-store.js';
import type { CommandRouter } from '../src/command-router.js';
import type { HourlyLimiter } from '../src/hourly-limiter.js';
import type { ProjectConfig } from '../../shared/types.js';

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    title: 'Test',
    slug: 'test',
    description: '',
    directory: '/tmp',
    sessionId: null,
    status: 'active',
    decision: null,
    autoDecide: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CronDeps> = {}): CronDeps {
  return {
    commandRouter: {
      anySessionRunning: vi.fn().mockReturnValue(false),
      autoDecide: vi.fn().mockResolvedValue('auto-decided'),
      cleanupDecisions: vi.fn().mockResolvedValue(undefined),
      proactiveCompact: vi.fn().mockResolvedValue(null),
      stopSlug: vi.fn().mockReturnValue({ stopped: false, reason: 'no session' }),
    } as unknown as CommandRouter,
    projectStore: {
      loadAll: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
    } as unknown as ProjectStore,
    config: {} as CronDeps['config'],
    sendToMessenger: vi.fn(),
    hourlyLimiter: {
      drainBlocked: vi.fn().mockReturnValue([]),
      tryConsume: vi.fn().mockReturnValue(null), // null = allowed
    } as unknown as HourlyLimiter,
    ...overrides,
  };
}

describe('Cron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

describe('auto-decide interval', () => {

  it('calls autoDecide for projects with passed deadline during active hours', async () => {
    // 10AM — active hour
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      decision: { summary: 'pick DB', rating: 5, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // Fire hourly interval

    expect(deps.commandRouter.autoDecide).toHaveBeenCalledWith(project, expect.any(Function));
    expect(deps.sendToMessenger).toHaveBeenCalledWith('auto-decided', 'test', '/tmp');
  });

  it('skips auto-decide outside active hours', async () => {
    // 3AM — inactive hour
    vi.setSystemTime(new Date('2026-04-07T03:00:00'));

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T01:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips auto-decide during vacation mode', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(true),
        isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips projects without deadline', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({ decision: null });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips projects with future deadline', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T14:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips projects with autoDecide=false', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const project = makeProject({
      autoDecide: false,
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('prevents concurrent auto-decide runs (lock flag)', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    let resolveFirst!: () => void;
    const blockFirst = new Promise<void>(res => { resolveFirst = res; });

    const project = makeProject({
      decision: { summary: 'task', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null },
    });

    const deps = makeDeps({
      commandRouter: {
      anySessionRunning: vi.fn().mockReturnValue(false),
        autoDecide: vi.fn().mockReturnValue(blockFirst.then(() => 'done')),
        cleanupDecisions: vi.fn().mockResolvedValue(undefined),
        stopSlug: vi.fn().mockReturnValue({ stopped: false, reason: 'no session' }),
      } as unknown as CommandRouter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);

    // Fire first tick — autoDecide starts but never resolves (blockFirst)
    // Use non-async advance so the interval callback starts but we don't await it
    vi.advanceTimersByTime(60 * 60 * 1000);
    // Flush microtasks so the callback reaches `autoDecide` and sets autoDecideRunning = true
    await Promise.resolve();
    await Promise.resolve();

    // Fire second tick — should be skipped due to lock
    vi.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    // autoDecide called only once (second tick skipped)
    expect(deps.commandRouter.autoDecide).toHaveBeenCalledTimes(1);
    resolveFirst();
  });

  it('times out and continues to next project after 15 minutes', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const p1 = makeProject({ slug: 'slow', decision: { summary: 'slow', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });
    const p2 = makeProject({ slug: 'ok', decision: { summary: 'ok', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });

    const deps = makeDeps({
      commandRouter: {
      anySessionRunning: vi.fn().mockReturnValue(false),
        autoDecide: vi.fn()
          .mockReturnValueOnce(new Promise(() => {})) // hangs forever
          .mockResolvedValueOnce('success'),
        cleanupDecisions: vi.fn().mockResolvedValue(undefined),
        stopSlug: vi.fn().mockReturnValue({ stopped: true, reason: 'timed out' }),
      } as unknown as CommandRouter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([p1, p2]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    // Fire the hourly tick, then advance past the 15-min timeout
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15 * 60 * 1000 + 1000);

    // Slow project timed out, but second project still ran
    expect(deps.commandRouter.autoDecide).toHaveBeenCalledTimes(2);
    expect(deps.sendToMessenger).toHaveBeenCalledWith('success', 'ok', '/tmp');
  });

  it('continues processing remaining projects when one throws', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const p1 = makeProject({ slug: 'broken', decision: { summary: 'fail', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });
    const p2 = makeProject({ slug: 'ok', decision: { summary: 'ok', rating: 3, deadline: new Date('2026-04-07T09:00:00').toISOString(), pausedRemaining: null } });

    const deps = makeDeps({
      commandRouter: {
      anySessionRunning: vi.fn().mockReturnValue(false),
        autoDecide: vi.fn()
          .mockRejectedValueOnce(new Error('Claude error'))
          .mockResolvedValueOnce('success'),
        cleanupDecisions: vi.fn().mockResolvedValue(undefined),
      } as unknown as CommandRouter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([p1, p2]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    // Both were attempted, second succeeded
    expect(deps.commandRouter.autoDecide).toHaveBeenCalledTimes(2);
    expect(deps.sendToMessenger).toHaveBeenCalledWith('success', 'ok', '/tmp');
  });
});

describe('cleanup interval', () => {
  it('calls cleanupDecisions at midnight (hour 0)', async () => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(0);

    const project = makeProject();
    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.cleanupDecisions).toHaveBeenCalledWith(project);
  });

  it('does not call cleanupDecisions outside midnight', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const deps = makeDeps({
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([makeProject()]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(deps.commandRouter.cleanupDecisions).not.toHaveBeenCalled();
  });
});

describe('auto-resume interval', () => {
  it('resumes blocked projects at top of hour', async () => {
    vi.spyOn(Date.prototype, 'getMinutes').mockReturnValue(0);

    const project = makeProject({ slug: 'rfp' });
    const deps = makeDeps({
      hourlyLimiter: {
        drainBlocked: vi.fn().mockReturnValue(['rfp']),
      } as unknown as HourlyLimiter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([]),
        load: vi.fn().mockResolvedValue(project),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60_000); // Fire the 1-minute interval

    expect(deps.commandRouter.autoDecide).toHaveBeenCalledWith(project, expect.any(Function));
    expect(deps.sendToMessenger).toHaveBeenCalledWith('auto-decided', 'rfp', '/tmp');
  });

  it('skips auto-resume when no blocked slugs', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const deps = makeDeps();
    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips auto-resume when minutes !== 0', async () => {
    vi.spyOn(Date.prototype, 'getMinutes').mockReturnValue(30);

    const deps = makeDeps({
      hourlyLimiter: {
        drainBlocked: vi.fn().mockReturnValue(['rfp']),
      } as unknown as HourlyLimiter,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });

  it('skips project when not found in store', async () => {
    vi.setSystemTime(new Date('2026-04-07T10:00:00'));

    const deps = makeDeps({
      hourlyLimiter: {
        drainBlocked: vi.fn().mockReturnValue(['ghost']),
      } as unknown as HourlyLimiter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([]),
        load: vi.fn().mockResolvedValue(null),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.commandRouter.autoDecide).not.toHaveBeenCalled();
  });
}); // auto-resume interval

describe('proactive compact interval', () => {
  it('calls proactiveCompact for eligible projects (high ctx, idle, has session)', async () => {
    const idleTime = new Date(Date.now() - 90 * 60_000).toISOString(); // 90 min ago
    const project = makeProject({
      sessionId: 'sess-123',
      contextUsedPct: 80,
      lastConversationAt: idleTime,
    });
    const compact = vi.fn().mockResolvedValue('🗜️ Compacted Test: 80% → 30%');
    const deps = makeDeps({
      commandRouter: {
      anySessionRunning: vi.fn().mockReturnValue(false),
        autoDecide: vi.fn(),
        cleanupDecisions: vi.fn(),
        proactiveCompact: compact,
      } as unknown as CommandRouter,
      projectStore: {
        loadAll: vi.fn().mockResolvedValue([project]),
        load: vi.fn(),
        isVacation: vi.fn().mockResolvedValue(false),
      isQuietWatchArmed: vi.fn().mockResolvedValue(false),
      } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(compact).toHaveBeenCalledWith(project);
    // Broadcast intentionally silenced by 7308cf7 (2026-05-22): compact still runs,
    // but the client is not notified on every proactive compact.
    expect(deps.sendToMessenger).not.toHaveBeenCalledWith('🗜️ Compacted Test: 80% → 30%', 'test', '/tmp');
  });

  it('skips proactiveCompact when context below threshold', async () => {
    const idleTime = new Date(Date.now() - 90 * 60_000).toISOString();
    const project = makeProject({ sessionId: 'sess-123', contextUsedPct: 50, lastConversationAt: idleTime });
    const compact = vi.fn();
    const deps = makeDeps({
      commandRouter: { autoDecide: vi.fn(), cleanupDecisions: vi.fn(), proactiveCompact: compact, anySessionRunning: vi.fn().mockReturnValue(false) } as unknown as CommandRouter,
      projectStore: { loadAll: vi.fn().mockResolvedValue([project]), load: vi.fn(), isVacation: vi.fn().mockResolvedValue(false), isQuietWatchArmed: vi.fn().mockResolvedValue(false) } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(compact).not.toHaveBeenCalled();
  });

  it('skips proactiveCompact when not idle enough', async () => {
    const recentTime = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    const project = makeProject({ sessionId: 'sess-123', contextUsedPct: 80, lastConversationAt: recentTime });
    const compact = vi.fn();
    const deps = makeDeps({
      commandRouter: { autoDecide: vi.fn(), cleanupDecisions: vi.fn(), proactiveCompact: compact, anySessionRunning: vi.fn().mockReturnValue(false) } as unknown as CommandRouter,
      projectStore: { loadAll: vi.fn().mockResolvedValue([project]), load: vi.fn(), isVacation: vi.fn().mockResolvedValue(false), isQuietWatchArmed: vi.fn().mockResolvedValue(false) } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(compact).not.toHaveBeenCalled();
  });

  it('skips proactiveCompact when no session', async () => {
    const idleTime = new Date(Date.now() - 90 * 60_000).toISOString();
    const project = makeProject({ sessionId: null, contextUsedPct: 80, lastConversationAt: idleTime });
    const compact = vi.fn();
    const deps = makeDeps({
      commandRouter: { autoDecide: vi.fn(), cleanupDecisions: vi.fn(), proactiveCompact: compact, anySessionRunning: vi.fn().mockReturnValue(false) } as unknown as CommandRouter,
      projectStore: { loadAll: vi.fn().mockResolvedValue([project]), load: vi.fn(), isVacation: vi.fn().mockResolvedValue(false), isQuietWatchArmed: vi.fn().mockResolvedValue(false) } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(compact).not.toHaveBeenCalled();
  });

  it('skips proactiveCompact when lastConversationAt unknown', async () => {
    const project = makeProject({ sessionId: 'sess-123', contextUsedPct: 80 }); // no lastConversationAt
    const compact = vi.fn();
    const deps = makeDeps({
      commandRouter: { autoDecide: vi.fn(), cleanupDecisions: vi.fn(), proactiveCompact: compact, anySessionRunning: vi.fn().mockReturnValue(false) } as unknown as CommandRouter,
      projectStore: { loadAll: vi.fn().mockResolvedValue([project]), load: vi.fn(), isVacation: vi.fn().mockResolvedValue(false), isQuietWatchArmed: vi.fn().mockResolvedValue(false) } as unknown as ProjectStore,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(compact).not.toHaveBeenCalled();
  });

  it('stops compacting when hourly budget exhausted', async () => {
    const idleTime = new Date(Date.now() - 90 * 60_000).toISOString();
    const p1 = makeProject({ slug: 'p1', sessionId: 'sess-1', contextUsedPct: 80, lastConversationAt: idleTime });
    const p2 = makeProject({ slug: 'p2', sessionId: 'sess-2', contextUsedPct: 85, lastConversationAt: idleTime });
    const compact = vi.fn().mockResolvedValue('🗜️ notice');
    const deps = makeDeps({
      commandRouter: { autoDecide: vi.fn(), cleanupDecisions: vi.fn(), proactiveCompact: compact, anySessionRunning: vi.fn().mockReturnValue(false) } as unknown as CommandRouter,
      projectStore: { loadAll: vi.fn().mockResolvedValue([p1, p2]), load: vi.fn(), isVacation: vi.fn().mockResolvedValue(false), isQuietWatchArmed: vi.fn().mockResolvedValue(false) } as unknown as ProjectStore,
      hourlyLimiter: {
        drainBlocked: vi.fn().mockReturnValue([]),
        tryConsume: vi.fn().mockReturnValue('Hourly limit reached'), // always rejected
      } as unknown as HourlyLimiter,
    });

    startCronJobs(deps);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(compact).not.toHaveBeenCalled();
  });
}); // proactive compact interval

}); // Cron
