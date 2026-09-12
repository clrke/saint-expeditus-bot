import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, buildUserMessage } from '../src/prompt-builder.js';
import type { AskPayload } from '../../shared/types.js';

describe('buildSystemPrompt', () => {
  let tmpFile: string;

  beforeEach(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-'));
    tmpFile = path.join(tmpDir, 'prompt.md');
    await fs.writeFile(tmpFile, 'You are a test bot.');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(tmpFile), { recursive: true });
  });

  it('reads the prompt file', async () => {
    const result = await buildSystemPrompt(tmpFile);
    expect(result).toBe('You are a test bot.');
  });
});

describe('buildUserMessage', () => {
  it('includes recent messages', () => {
    const payload: AskPayload = {
      trigger: {
        type: 'inline',
        query: 'anong status ng water?',
        sender: 'Bheck',
        replyTo: null,
        originalMessage: '/expeditus anong status ng water?',
      },
      recentMessages: [
        {
          sender: 'Resa',
          message: 'Walang tubig',
          timestamp: '1/23/26 09:00',
          replyTo: null,
          type: 'text',
        },
      ],
      repliedToMessage: null,
    };

    const result = buildUserMessage(payload, 30);
    expect(result).toContain('RECENT GROUP CHAT MESSAGES');
    expect(result).toContain('[1/23/26 09:00] Resa: Walang tubig');
    expect(result).toContain('Bheck asked: anong status ng water?');
  });

  it('includes replied-to message', () => {
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
        timestamp: null,
        replyTo: null,
        type: 'text',
      },
    };

    const result = buildUserMessage(payload, 30);
    expect(result).toContain('MESSAGE BEING REPLIED TO');
    expect(result).toContain('Emva: May meeting ba bukas?');
    expect(result).toContain("replied to Emva's message");
  });

  it('truncates messages to maxMessages', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      sender: `User${i}`,
      message: `Message ${i}`,
      timestamp: null,
      replyTo: null,
      type: 'text' as const,
    }));

    const payload: AskPayload = {
      trigger: {
        type: 'inline',
        query: 'test',
        sender: 'X',
        replyTo: null,
        originalMessage: '/expeditus test',
      },
      recentMessages: messages,
      repliedToMessage: null,
    };

    const result = buildUserMessage(payload, 10);
    // Should only contain the last 10 messages (User40-User49)
    expect(result).toContain('User49');
    expect(result).not.toContain('User0:');
  });

  it('handles trigger with no query and no reply', () => {
    const payload: AskPayload = {
      trigger: {
        type: 'inline',
        query: null,
        sender: 'Test',
        replyTo: null,
        originalMessage: '/expeditus',
      },
      recentMessages: [],
      repliedToMessage: null,
    };

    const result = buildUserMessage(payload, 30);
    expect(result).toContain('triggered /expeditus with no specific question');
  });
});
