import { describe, it, expect } from 'vitest';
import { HourlyLimiter } from '../src/hourly-limiter.js';

describe('HourlyLimiter', () => {
  it('allows unlimited when sessionLimit is 0', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 0, activeHours: 12 });
    for (let i = 0; i < 100; i++) {
      expect(limiter.tryConsume()).toBeNull();
    }
    const status = limiter.getStatus();
    expect(status.unlimited).toBe(true);
  });

  it('effective limit is 2x base when no previous hour usage', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 24, activeHours: 12 });
    // base = ceil(24/12) = 2, no prev hour data = full rollover, effective = 4 (capped at 2x)
    const status = limiter.getStatus();
    expect(status.hourlyLimit).toBe(4); // 2x base
    expect(status.remainingThisHour).toBe(4);
  });

  it('blocks after effective limit is reached', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 12, activeHours: 12 });
    // base = 1, effective = 2 (2x with full rollover)
    const t = new Date(2026, 2, 22, 10, 0, 0);

    expect(limiter.tryConsume(t)).toBeNull(); // 1st allowed
    expect(limiter.tryConsume(t)).toBeNull(); // 2nd allowed (rollover)
    const reject = limiter.tryConsume(t); // 3rd blocked
    expect(reject).not.toBeNull();
    expect(reject).toContain('Hourly limit reached');
  });

  it('rollover decreases when previous hour was busy', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 24, activeHours: 12 });
    // base = 2
    const h10 = new Date(2026, 2, 22, 10, 0, 0);
    const h11 = new Date(2026, 2, 22, 11, 0, 0);

    // Use all 4 (2x rollover) in hour 10
    limiter.tryConsume(h10);
    limiter.tryConsume(h10);
    limiter.tryConsume(h10);
    limiter.tryConsume(h10);

    // Hour 11: prev used 4, base is 2, rollover = max(0, 2 - 4) = 0
    // effective = 2 + 0 = 2
    const status = limiter.getStatus(h11);
    expect(status.hourlyLimit).toBe(2);
    expect(status.remainingThisHour).toBe(2);
  });

  it('rollover carries unused tokens from previous hour', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 60, activeHours: 12 });
    // base = 5
    const h10 = new Date(2026, 2, 22, 10, 0, 0);
    const h11 = new Date(2026, 2, 22, 11, 0, 0);

    // Use only 2 of 10 (2x rollover) in hour 10
    limiter.tryConsume(h10);
    limiter.tryConsume(h10);

    // Hour 11: prev used 2, base 5, rollover = 5 - 2 = 3
    // effective = min(10, 5 + 3) = 8
    const status = limiter.getStatus(h11);
    expect(status.hourlyLimit).toBe(8);
  });

  it('rollover capped at 2x base', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 60, activeHours: 12 });
    // base = 5
    const h10 = new Date(2026, 2, 22, 10, 0, 0);
    const h11 = new Date(2026, 2, 22, 11, 0, 0);

    // Use 0 in hour 10 → rollover = 5, effective = min(10, 5+5) = 10
    const status = limiter.getStatus(h11);
    expect(status.hourlyLimit).toBe(10); // 2x cap
  });

  it('tracks status correctly with rollover', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 60, activeHours: 12 });
    // base = 5, effective starts at 10 (2x, no prev data)
    const t = new Date(2026, 2, 22, 10, 0, 0);

    expect(limiter.getStatus(t).usedThisHour).toBe(0);
    expect(limiter.getStatus(t).remainingThisHour).toBe(10);

    limiter.tryConsume(t);
    expect(limiter.getStatus(t).usedThisHour).toBe(1);
    expect(limiter.getStatus(t).remainingThisHour).toBe(9);
  });

  it('resets on new hour with rollover', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 12, activeHours: 12 });
    // base = 1
    const hour10 = new Date(2026, 2, 22, 10, 30, 0);
    const hour11 = new Date(2026, 2, 22, 11, 0, 0);

    // Use both (2x rollover) at hour 10
    expect(limiter.tryConsume(hour10)).toBeNull();
    expect(limiter.tryConsume(hour10)).toBeNull();
    expect(limiter.tryConsume(hour10)).not.toBeNull(); // blocked

    // New hour — prev used 2, base 1, rollover = max(0, 1-2) = 0, effective = 1
    expect(limiter.tryConsume(hour11)).toBeNull();
    expect(limiter.tryConsume(hour11)).not.toBeNull(); // blocked at 1
  });

  it('includes minutes remaining in rejection message', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 12, activeHours: 12 });
    const at45min = new Date(2026, 2, 22, 10, 45, 0);

    // base=1, effective=2, consume both
    limiter.tryConsume(at45min);
    limiter.tryConsume(at45min);
    const reject = limiter.tryConsume(at45min);
    expect(reject).toContain('~15 min');
  });

  it('shows currentHour in status', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 24, activeHours: 12 });
    const status = limiter.getStatus(new Date(2026, 2, 22, 14, 30));
    expect(status.currentHour).toBe('14:00');
  });

  it('tracks upstream 5-hour window usage', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 0, activeHours: 12 });
    const t0 = new Date(2026, 2, 22, 10, 0, 0);

    limiter.tryConsume(t0);
    limiter.tryConsume(t0);
    limiter.tryConsume(t0);

    const status = limiter.getStatus(t0);
    expect(status.upstream.windowCount).toBe(3);
    expect(status.upstream.usagePercent).toBeGreaterThan(0);
    expect(status.upstream.windowMinutesLeft).toBeLessThanOrEqual(300);
    expect(status.upstream.estimatedUpstreamLimit).toBe(200);
  });

  it('records and drains blocked slugs on hour rollover', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 12, activeHours: 12 });
    const h10 = new Date(2026, 2, 22, 10, 30, 0);
    const h11 = new Date(2026, 2, 22, 11, 0, 0);

    limiter.drainBlocked(h10);

    limiter.recordBlocked('project-a');
    limiter.recordBlocked('project-b');
    limiter.recordBlocked('project-a'); // dedup

    expect(limiter.drainBlocked(h10)).toEqual([]);

    const drained = limiter.drainBlocked(h11);
    expect(drained).toHaveLength(2);
    expect(drained).toContain('project-a');
    expect(drained).toContain('project-b');

    expect(limiter.drainBlocked(h11)).toEqual([]);
  });

  it('resets upstream window after 5 hours', () => {
    const limiter = new HourlyLimiter({ sessionLimit: 0, activeHours: 12 });
    const t0 = new Date(2026, 2, 22, 10, 0, 0);
    const t5 = new Date(2026, 2, 22, 15, 0, 1);

    limiter.tryConsume(t0);
    limiter.tryConsume(t0);
    expect(limiter.getStatus(t0).upstream.windowCount).toBe(2);

    limiter.tryConsume(t5);
    expect(limiter.getStatus(t5).upstream.windowCount).toBe(1);
  });

  it('preserves cost data across tryConsume saves', async () => {
    const tmpFile = `/tmp/limiter-test-${Date.now()}.json`;
    const limiter = new HourlyLimiter({ sessionLimit: 0, activeHours: 12, persistPath: tmpFile });

    // Save cost data once
    limiter.save({ totalUsd: 1.23, sessionCosts: { myproject: 0.50 } });

    // tryConsume calls save() without costData — should NOT erase the cost tracker
    limiter.tryConsume();
    limiter.tryConsume();

    // Read back persisted state
    const raw = await import('node:fs/promises').then(fs => fs.readFile(tmpFile, 'utf-8'));
    const state = JSON.parse(raw);
    expect(state.costTracker).toBeDefined();
    expect(state.costTracker.totalUsd).toBe(1.23);
    expect(state.costTracker.sessionCosts.myproject).toBe(0.50);

    // Cleanup
    await import('node:fs/promises').then(fs => fs.unlink(tmpFile).catch(() => {}));
  });
});
