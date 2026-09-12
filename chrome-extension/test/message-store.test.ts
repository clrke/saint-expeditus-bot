import { describe, it, expect } from 'vitest';
import { MessageStore } from '../src/message-store.js';
import type { ParsedMessage } from '../../shared/types.js';

function makeMsg(sender: string, message: string, timestamp: string | null = null): ParsedMessage {
  return { sender, message, timestamp, replyTo: null, type: 'text' };
}

describe('MessageStore', () => {
  it('adds and retrieves messages', () => {
    const store = new MessageStore();
    store.add(makeMsg('Alice', 'Hello'));
    store.add(makeMsg('Bob', 'Hi'));
    expect(store.size).toBe(2);
    expect(store.getRecent(10)).toHaveLength(2);
  });

  it('deduplicates identical messages', () => {
    const store = new MessageStore();
    const msg = makeMsg('Alice', 'Hello', '1/23/26 09:00');
    expect(store.add(msg)).toBe(true);
    expect(store.add(msg)).toBe(false);
    expect(store.size).toBe(1);
  });

  it('respects maxSize limit', () => {
    const store = new MessageStore(3);
    store.add(makeMsg('A', 'msg1', '1'));
    store.add(makeMsg('B', 'msg2', '2'));
    store.add(makeMsg('C', 'msg3', '3'));
    store.add(makeMsg('D', 'msg4', '4'));
    expect(store.size).toBe(3);
    // First message should have been evicted
    const recent = store.getRecent(10);
    expect(recent[0].sender).toBe('B');
  });

  it('getRecent returns only last N messages', () => {
    const store = new MessageStore();
    store.add(makeMsg('A', 'msg1', '1'));
    store.add(makeMsg('B', 'msg2', '2'));
    store.add(makeMsg('C', 'msg3', '3'));
    const recent = store.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].sender).toBe('B');
    expect(recent[1].sender).toBe('C');
  });

  it('findBySender returns most recent match', () => {
    const store = new MessageStore();
    store.add(makeMsg('Alice', 'first message', '1'));
    store.add(makeMsg('Bob', 'hello', '2'));
    store.add(makeMsg('Alice', 'second message', '3'));
    const found = store.findBySender('Alice');
    expect(found).not.toBeNull();
    expect(found!.message).toBe('second message');
  });

  it('findBySender returns null when not found', () => {
    const store = new MessageStore();
    store.add(makeMsg('Alice', 'hello'));
    expect(store.findBySender('Charlie')).toBeNull();
  });

  it('findBySender matches partial names', () => {
    const store = new MessageStore();
    store.add(makeMsg('Bheck Jason Pasion', 'hello'));
    expect(store.findBySender('Bheck')).not.toBeNull();
  });

  it('clear removes all messages', () => {
    const store = new MessageStore();
    store.add(makeMsg('A', 'msg1'));
    store.add(makeMsg('B', 'msg2'));
    store.clear();
    expect(store.size).toBe(0);
    expect(store.getRecent(10)).toEqual([]);
  });

  it('allows previously evicted message keys to be re-added', () => {
    const store = new MessageStore(2);
    store.add(makeMsg('A', 'msg1', '1'));
    store.add(makeMsg('B', 'msg2', '2'));
    store.add(makeMsg('C', 'msg3', '3'));
    // 'A msg1' was evicted, should be addable again
    expect(store.add(makeMsg('A', 'msg1', '1'))).toBe(true);
  });
});
