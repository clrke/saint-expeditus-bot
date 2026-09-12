import fs from 'node:fs/promises';
import type { AskPayload } from '../../shared/types.js';

export async function buildSystemPrompt(promptFilePath: string): Promise<string> {
  return fs.readFile(promptFilePath, 'utf-8');
}

export function buildUserMessage(payload: AskPayload, maxMessages: number): string {
  const { trigger, recentMessages, repliedToMessage } = payload;
  const parts: string[] = [];

  const msgs = recentMessages.slice(-maxMessages);
  if (msgs.length > 0) {
    parts.push('=== RECENT GROUP CHAT MESSAGES ===');
    for (const msg of msgs) {
      const ts = msg.timestamp ? `[${msg.timestamp}]` : '';
      const reply = msg.replyTo ? ` (replying to ${msg.replyTo})` : '';
      parts.push(`${ts} ${msg.sender}${reply}: ${msg.message}`);
    }
  }

  if (repliedToMessage) {
    parts.push('');
    parts.push('=== MESSAGE BEING REPLIED TO ===');
    parts.push(`${repliedToMessage.sender}: ${repliedToMessage.message}`);
  }

  parts.push('');
  parts.push('=== TRIGGER ===');
  if (trigger.query) {
    parts.push(`${trigger.sender} asked: ${trigger.query}`);
  } else if (trigger.replyTo) {
    parts.push(
      `${trigger.sender} replied to ${trigger.replyTo}'s message with /expeditus (respond based on the replied-to message context)`,
    );
  } else {
    parts.push(`${trigger.sender} triggered /expeditus with no specific question`);
  }

  return parts.join('\n');
}

