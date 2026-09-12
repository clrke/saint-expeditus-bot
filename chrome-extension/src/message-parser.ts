import {
  findMessageText,
  findSenderName,
  findTimestamp,
  parseReplyPattern,
} from './element-discovery.js';
import type { ParsedMessage } from '../../shared/types.js';

export interface ParserContext {
  sender: string | null;
  timestamp: string | null;
}

export function parseRow(
  row: Element,
  ctx: ParserContext,
): { message: ParsedMessage | null; updatedCtx: ParserContext } {
  const newCtx = { ...ctx };

  const ts = findTimestamp(row);
  if (ts) newCtx.timestamp = ts;

  const senderRaw = findSenderName(row);
  let replyTo: string | null = null;

  if (senderRaw) {
    const replyInfo = parseReplyPattern(senderRaw);
    if (replyInfo) {
      newCtx.sender = replyInfo.sender;
      replyTo = replyInfo.repliedTo;
    } else {
      newCtx.sender = senderRaw;
    }
  }

  const text = findMessageText(row);
  if (text) {
    return {
      message: {
        sender: newCtx.sender ?? 'Unknown',
        message: text,
        timestamp: newCtx.timestamp,
        replyTo,
        type: 'text',
      },
      updatedCtx: newCtx,
    };
  }

  return { message: null, updatedCtx: newCtx };
}
