import type { ParsedMessage, Trigger } from '../../shared/types.js';

type TriggerHandler = (msg: ParsedMessage, query: string) => Trigger;

export class TriggerRegistry {
  private triggers = new Map<string, TriggerHandler>();

  register(prefix: string, handler: TriggerHandler): void {
    this.triggers.set(prefix.toLowerCase(), handler);
  }

  detect(msg: ParsedMessage): Trigger | null {
    const text = msg.message?.trim() ?? '';
    const lower = text.toLowerCase();
    for (const [prefix, handler] of this.triggers) {
      if (lower.startsWith(prefix)) {
        return handler(msg, text.slice(prefix.length).trim());
      }
    }
    return null;
  }

  get registeredTriggers(): string[] {
    return [...this.triggers.keys()];
  }

  clear(): void {
    this.triggers.clear();
  }
}

export function createExpeditusTrigger(
  msg: ParsedMessage,
  query: string,
): Trigger {
  return {
    type: msg.replyTo ? 'reply' : 'inline',
    query: query || null,
    sender: msg.sender,
    replyTo: msg.replyTo,
    originalMessage: msg.message,
  };
}
