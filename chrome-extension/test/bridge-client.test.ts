import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { askBridge, pingBridge } from '../src/bridge-client.js';
import type { BridgeClientConfig } from '../src/bridge-client.js';

const testConfig: BridgeClientConfig = {
  retryAttempts: 1,
  retryDelayMs: 100,
};

const makePayload = () => ({
  trigger: {
    type: 'inline' as const,
    query: 'test',
    sender: 'User',
    replyTo: null,
    originalMessage: '/expeditus test',
  },
  recentMessages: [],
  repliedToMessage: null,
});

// Mock chrome.runtime.sendMessage
const mockSendMessage = vi.fn();
vi.stubGlobal('chrome', {
  runtime: { sendMessage: mockSendMessage },
});

describe('askBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockSendMessage.mockReset();
  });

  it('returns response text on success', async () => {
    mockSendMessage.mockImplementation((_msg: any, cb: any) => {
      cb({ response: 'Kumusta po!' });
    });

    const result = await askBridge(makePayload(), testConfig);
    expect(result).toBe('Kumusta po!');
  });

  it('sends ASK_BRIDGE message with payload', async () => {
    mockSendMessage.mockImplementation((_msg: any, cb: any) => {
      cb({ response: 'ok' });
    });

    const payload = makePayload();
    await askBridge(payload, testConfig);
    expect(mockSendMessage).toHaveBeenCalledWith(
      { type: 'ASK_BRIDGE', payload },
      expect.any(Function),
    );
  });

  it('retries on error response', async () => {
    mockSendMessage
      .mockImplementationOnce((_msg: any, cb: any) => {
        cb({ error: 'network error' });
      })
      .mockImplementationOnce((_msg: any, cb: any) => {
        cb({ response: 'ok' });
      });

    const result = await askBridge(makePayload(), testConfig);
    expect(result).toBe('ok');
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('retries on rate limit', async () => {
    mockSendMessage
      .mockImplementationOnce((_msg: any, cb: any) => {
        cb({ error: 'Rate limited. Try again in a minute.' });
      })
      .mockImplementationOnce((_msg: any, cb: any) => {
        cb({ response: 'ok' });
      });

    const result = await askBridge(makePayload(), testConfig);
    expect(result).toBe('ok');
  });

  it('throws after all retries exhausted', async () => {
    mockSendMessage.mockImplementation((_msg: any, cb: any) => {
      cb({ error: 'persistent error' });
    });

    await expect(askBridge(makePayload(), testConfig)).rejects.toThrow(
      'persistent error',
    );
  });

  it('retries and throws diagnostic error when service worker returns null', async () => {
    mockSendMessage.mockImplementation((_msg: any, cb: any) => {
      cb(null);
    });

    await expect(askBridge(makePayload(), testConfig)).rejects.toThrow(
      'service worker returned null',
    );
    // retryAttempts = 1 means 2 total calls
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it('returns null when bridge reports already replied', async () => {
    mockSendMessage.mockImplementation((_msg: any, cb: any) => {
      cb({ alreadyReplied: true });
    });

    const result = await askBridge(makePayload(), testConfig);
    expect(result).toBeNull();
  });
});

describe('pingBridge', () => {
  afterEach(() => {
    mockSendMessage.mockReset();
  });

  it('returns true when bridge is healthy', async () => {
    mockSendMessage.mockImplementation((_msg: any, cb: any) => {
      cb({ connected: true });
    });
    expect(await pingBridge()).toBe(true);
  });

  it('returns false when bridge is down', async () => {
    mockSendMessage.mockImplementation((_msg: any, cb: any) => {
      cb({ connected: false });
    });
    expect(await pingBridge()).toBe(false);
  });
});
