import type { ParsedMessage } from '../../shared/types.js';

export class MessageStore {
  private messages: ParsedMessage[] = [];
  private seen = new Set<string>();

  constructor(private maxSize = 100) {}

  private makeKey(msg: ParsedMessage): string {
    return `${msg.timestamp}|${msg.sender}|${msg.message.slice(0, 80)}`;
  }

  /** Returns true if message was new (not duplicate) */
  add(msg: ParsedMessage): boolean {
    const key = this.makeKey(msg);
    if (this.seen.has(key)) return false;

    this.seen.add(key);
    this.messages.push({ ...msg, receivedAt: Date.now() });

    while (this.messages.length > this.maxSize) {
      const removed = this.messages.shift()!;
      this.seen.delete(this.makeKey(removed));
    }

    return true;
  }

  getRecent(count: number): ParsedMessage[] {
    return this.messages.slice(-count);
  }

  findBySender(name: string): ParsedMessage | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].sender.includes(name)) return this.messages[i];
    }
    return null;
  }

  get size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
    this.seen.clear();
  }
}
