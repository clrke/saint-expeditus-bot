import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestQueue } from '../src/request-queue.js';

describe('RequestQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes a single item immediately', async () => {
    const queue = new RequestQueue<string>(1000);
    const fn = vi.fn().mockResolvedValue('result');
    const promise = queue.enqueue(fn);
    const result = await promise;
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('processes items sequentially with cooldown', async () => {
    const queue = new RequestQueue<number>(1000);
    const results: number[] = [];

    const p1 = queue.enqueue(async () => {
      results.push(1);
      return 1;
    });
    const p2 = queue.enqueue(async () => {
      results.push(2);
      return 2;
    });

    // First item executes immediately
    await p1;
    expect(results).toEqual([1]);

    // Second item waits for cooldown
    expect(queue.pending).toBe(1);

    vi.advanceTimersByTime(1000);
    await p2;
    expect(results).toEqual([1, 2]);
  });

  it('rejects on error', async () => {
    const queue = new RequestQueue<void>(1000);
    const promise = queue.enqueue(async () => {
      throw new Error('boom');
    });
    await expect(promise).rejects.toThrow('boom');
  });

  it('reports processing state', async () => {
    const queue = new RequestQueue<void>(1000);
    expect(queue.isProcessing).toBe(false);

    let resolveFn: () => void;
    const promise = queue.enqueue(
      () => new Promise<void>((r) => (resolveFn = r)),
    );
    expect(queue.isProcessing).toBe(true);

    resolveFn!();
    await promise;
    expect(queue.isProcessing).toBe(false);
  });

  it('reports pending count', () => {
    const queue = new RequestQueue<void>(1000);
    queue.enqueue(() => new Promise(() => {})); // never resolves
    queue.enqueue(async () => {});
    queue.enqueue(async () => {});
    expect(queue.pending).toBe(2); // 2 waiting, 1 in progress
  });
});
