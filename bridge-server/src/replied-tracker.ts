import fs from 'node:fs/promises';
import path from 'node:path';
import { debug } from './debug.js';

const REPLIED_FILE = 'replied.txt';
const MAX_DEDUP_KEY_LENGTH = 120;

export class RepliedTracker {
  private keys = new Set<string>();
  private filePath: string;
  private loadPromise: Promise<void> | null = null;
  private dirReady = false;

  constructor(systemDir: string) {
    this.filePath = path.join(systemDir, REPLIED_FILE);
  }

  /** Dedup key is message text only — sender excluded because Messenger renders
   *  the same person's name inconsistently (e.g. "Paul Justin" vs "Paul Justin Aranzamendez"). */
  static makeKey(message: string): string {
    return message.slice(0, MAX_DEDUP_KEY_LENGTH);
  }

  /** Load keys from disk (once). Concurrent callers await the same promise. */
  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this._doLoad();
    return this.loadPromise;
  }

  private async _doLoad(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.keys.add(trimmed);
      }
      debug('dedup', `loaded ${this.keys.size} keys from ${this.filePath}`);
    } catch {
      // File doesn't exist yet — that's fine
      debug('dedup', `no ${this.filePath} yet — starting empty`);
    }
  }

  /** Check if a trigger has already been replied to */
  has(key: string): boolean {
    const hit = this.keys.has(key);
    // A hit here silently drops the request ("already replied"), which looks
    // identical to the bot ignoring you. This is the only trace of that.
    if (hit) debug('dedup', `HIT — suppressing already-replied "${key.slice(0, 60)}"`);
    return hit;
  }

  /** Record a trigger as replied and persist to disk */
  async record(key: string): Promise<void> {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    if (!this.dirReady) {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      this.dirReady = true;
    }
    await fs.appendFile(this.filePath, key + '\n', 'utf-8');
  }

  get size(): number {
    return this.keys.size;
  }
}
