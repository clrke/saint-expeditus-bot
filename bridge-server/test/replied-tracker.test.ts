import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RepliedTracker } from '../src/replied-tracker.js';

describe('RepliedTracker', () => {
  let tmpDir: string;
  let tracker: RepliedTracker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replied-'));
    tracker = new RepliedTracker(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  describe('makeKey', () => {
    it('returns message slice up to 120 chars', () => {
      const long = 'x'.repeat(200);
      expect(RepliedTracker.makeKey(long)).toHaveLength(120);
    });

    it('returns full message if shorter than 120', () => {
      expect(RepliedTracker.makeKey('hi')).toBe('hi');
    });
  });

  describe('load', () => {
    it('loads nothing when file does not exist', async () => {
      await tracker.load();
      expect(tracker.size).toBe(0);
    });

    it('loads keys from existing file', async () => {
      await fs.mkdir(path.join(tmpDir, 'system'), { recursive: true });
      const sysTracker = new RepliedTracker(path.join(tmpDir, 'system'));
      await sysTracker.record('key-one');
      await sysTracker.record('key-two');

      const fresh = new RepliedTracker(path.join(tmpDir, 'system'));
      await fresh.load();
      expect(fresh.has('key-one')).toBe(true);
      expect(fresh.has('key-two')).toBe(true);
      expect(fresh.size).toBe(2);
    });

    it('concurrent calls await the same load — no duplicate file reads', async () => {
      // Both concurrent calls should resolve without error and produce consistent state
      await Promise.all([tracker.load(), tracker.load(), tracker.load()]);
      expect(tracker.size).toBe(0);
    });

    it('second load call is a no-op (returns same promise)', async () => {
      const p1 = tracker.load();
      const p2 = tracker.load();
      expect(p1).toBe(p2); // same promise instance
      await p1;
    });
  });

  describe('has / record', () => {
    it('returns false for unknown key', async () => {
      await tracker.load();
      expect(tracker.has('unknown')).toBe(false);
    });

    it('records and persists a key', async () => {
      await tracker.load();
      await tracker.record('msg1');
      expect(tracker.has('msg1')).toBe(true);

      const fresh = new RepliedTracker(tmpDir);
      await fresh.load();
      expect(fresh.has('msg1')).toBe(true);
    });

    it('record is idempotent — does not write duplicates', async () => {
      await tracker.load();
      await tracker.record('msg1');
      await tracker.record('msg1');

      const content = await fs.readFile(path.join(tmpDir, 'replied.txt'), 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
    });

    it('records multiple distinct keys', async () => {
      await tracker.load();
      await tracker.record('a');
      await tracker.record('b');
      await tracker.record('c');
      expect(tracker.size).toBe(3);
    });
  });
});
