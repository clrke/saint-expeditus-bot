import { describe, it, expect } from 'vitest';
import {
  TriggerRegistry,
  createExpeditusTrigger,
} from '../src/trigger-registry.js';
import type { ParsedMessage } from '../../shared/types.js';

function makeMessage(text: string, sender = 'TestUser'): ParsedMessage {
  return {
    sender,
    message: text,
    timestamp: null,
    replyTo: null,
    type: 'text',
  };
}

describe('TriggerRegistry', () => {
  it('detects registered trigger', () => {
    const registry = new TriggerRegistry();
    registry.register('/expeditus', createExpeditusTrigger);

    const trigger = registry.detect(makeMessage('/expeditus what is the water status?'));
    expect(trigger).not.toBeNull();
    expect(trigger!.query).toBe('what is the water status?');
    expect(trigger!.sender).toBe('TestUser');
    expect(trigger!.type).toBe('inline');
  });

  it('returns null for non-matching messages', () => {
    const registry = new TriggerRegistry();
    registry.register('/expeditus', createExpeditusTrigger);

    const trigger = registry.detect(makeMessage('Hello po sa lahat'));
    expect(trigger).toBeNull();
  });

  it('handles case-insensitive triggers', () => {
    const registry = new TriggerRegistry();
    registry.register('/expeditus', createExpeditusTrigger);

    const trigger = registry.detect(makeMessage('/EXPEDITUS kumusta?'));
    expect(trigger).not.toBeNull();
    expect(trigger!.query).toBe('kumusta?');
  });

  it('handles trigger with no query', () => {
    const registry = new TriggerRegistry();
    registry.register('/expeditus', createExpeditusTrigger);

    const trigger = registry.detect(makeMessage('/expeditus'));
    expect(trigger).not.toBeNull();
    expect(trigger!.query).toBeNull();
  });

  it('handles reply-type trigger', () => {
    const registry = new TriggerRegistry();
    registry.register('/expeditus', createExpeditusTrigger);

    const msg: ParsedMessage = {
      sender: 'Resa',
      message: '/expeditus',
      timestamp: null,
      replyTo: 'Emva',
      type: 'text',
    };

    const trigger = registry.detect(msg);
    expect(trigger).not.toBeNull();
    expect(trigger!.type).toBe('reply');
    expect(trigger!.replyTo).toBe('Emva');
  });

  it('supports multiple registered triggers', () => {
    const registry = new TriggerRegistry();
    registry.register('/expeditus', createExpeditusTrigger);
    registry.register('/tulong', (msg, q) => ({
      type: 'inline',
      query: q || null,
      sender: msg.sender,
      replyTo: null,
      originalMessage: msg.message,
    }));

    expect(registry.registeredTriggers).toEqual(['/expeditus', '/tulong']);
    expect(registry.detect(makeMessage('/tulong help'))).not.toBeNull();
  });
});
