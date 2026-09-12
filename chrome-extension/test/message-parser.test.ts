import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseRow } from '../src/message-parser.js';

describe('parseRow', () => {
  it('extracts sender and message', () => {
    const dom = new JSDOM(
      `<div role="row"><h5><span>Test User</span></h5><div dir="auto">Hello po</div></div>`,
    );
    const row = dom.window.document.querySelector('[role="row"]')!;
    const { message } = parseRow(row, { sender: null, timestamp: null });
    expect(message).not.toBeNull();
    expect(message!.sender).toBe('Test User');
    expect(message!.message).toBe('Hello po');
    expect(message!.type).toBe('text');
  });

  it('detects reply-to pattern', () => {
    const dom = new JSDOM(
      `<div role="row"><h5><span>Resa replied to Emva</span></h5><div dir="auto">Bagong tuta nyo</div></div>`,
    );
    const row = dom.window.document.querySelector('[role="row"]')!;
    const { message } = parseRow(row, { sender: null, timestamp: null });
    expect(message!.sender).toBe('Resa');
    expect(message!.replyTo).toBe('Emva');
  });

  it('carries over sender from context when row has no sender', () => {
    const dom = new JSDOM(
      `<div role="row"><div dir="auto">Follow up message</div></div>`,
    );
    const row = dom.window.document.querySelector('[role="row"]')!;
    const { message } = parseRow(row, {
      sender: 'Previous User',
      timestamp: '1/23/26 09:00',
    });
    expect(message!.sender).toBe('Previous User');
    expect(message!.timestamp).toBe('1/23/26 09:00');
  });

  it('returns null message for row with no text', () => {
    const dom = new JSDOM(`<div role="row"><img src="sticker.png" /></div>`);
    const row = dom.window.document.querySelector('[role="row"]')!;
    const { message } = parseRow(row, { sender: null, timestamp: null });
    expect(message).toBeNull();
  });

  it('updates timestamp in context', () => {
    const dom = new JSDOM(
      `<div role="row"><span>2/15/26 14:30</span><h5><span>User</span></h5><div dir="auto">Hello</div></div>`,
    );
    const row = dom.window.document.querySelector('[role="row"]')!;
    const { updatedCtx } = parseRow(row, { sender: null, timestamp: null });
    expect(updatedCtx.timestamp).toBe('2/15/26 14:30');
  });
});
