import { describe, it, expect } from 'vitest';
import type {
  AskPayload,
  AskResponse,
  HealthResponse,
  ParsedMessage,
  Trigger,
} from '../shared/types.js';

describe('API contract', () => {
  it('AskPayload is structurally valid', () => {
    const payload: AskPayload = {
      trigger: {
        type: 'inline',
        query: 'test',
        sender: 'User',
        replyTo: null,
        originalMessage: '/expeditus test',
      },
      recentMessages: [
        {
          sender: 'X',
          message: 'hello',
          timestamp: null,
          replyTo: null,
          type: 'text',
        },
      ],
      repliedToMessage: null,
    };
    expect(payload.trigger.sender).toBeDefined();
    expect(payload.recentMessages).toHaveLength(1);
  });

  it('AskPayload with reply type is valid', () => {
    const payload: AskPayload = {
      trigger: {
        type: 'reply',
        query: null,
        sender: 'Resa',
        replyTo: 'Emva',
        originalMessage: '/expeditus',
      },
      recentMessages: [],
      repliedToMessage: {
        sender: 'Emva',
        message: 'May meeting ba bukas?',
        timestamp: '1/23/26 09:10',
        replyTo: null,
        type: 'text',
      },
    };
    expect(payload.trigger.type).toBe('reply');
    expect(payload.repliedToMessage).not.toBeNull();
  });

  it('AskResponse is structurally valid', () => {
    const response: AskResponse = {
      response: 'Kumusta po!',
      timestamp: '2026-01-01T00:00:00Z',
      toolsUsed: ['read_memory'],
    };
    expect(response.response).toBeDefined();
    expect(response.timestamp).toBeDefined();
  });

  it('HealthResponse is structurally valid', () => {
    const health: HealthResponse = {
      status: 'ok',
      timestamp: '2026-01-01T00:00:00Z',
      uptime: 12345,
      stats: {
        requestsServed: 5,
        avgResponseMs: 200,
        lastError: null,
      },
    };
    expect(health.status).toBe('ok');
    expect(health.stats.requestsServed).toBeGreaterThanOrEqual(0);
  });

  it('ParsedMessage types are exhaustive', () => {
    const types: ParsedMessage['type'][] = ['text', 'sticker', 'photo'];
    expect(types).toHaveLength(3);
  });

  it('Trigger types are exhaustive', () => {
    const types: Trigger['type'][] = ['inline', 'reply'];
    expect(types).toHaveLength(2);
  });

  it('chatId is optional in AskPayload', () => {
    const withChatId: AskPayload = {
      trigger: { type: 'inline', query: 'test', sender: 'X', replyTo: null, originalMessage: '/expeditus test' },
      recentMessages: [],
      repliedToMessage: null,
      chatId: 'saint-expeditus',
    };
    const withoutChatId: AskPayload = {
      trigger: { type: 'inline', query: 'test', sender: 'X', replyTo: null, originalMessage: '/expeditus test' },
      recentMessages: [],
      repliedToMessage: null,
    };
    expect(withChatId.chatId).toBe('saint-expeditus');
    expect(withoutChatId.chatId).toBeUndefined();
  });
});
