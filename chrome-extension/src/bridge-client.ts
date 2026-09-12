import type { AskPayload } from '../../shared/types.js';

export interface BridgeClientConfig {
  retryAttempts: number;
  retryDelayMs: number;
}

const DEFAULT_CONFIG: BridgeClientConfig = {
  retryAttempts: 2,
  retryDelayMs: 1000,
};

function sendMessage(message: Record<string, unknown>): Promise<any> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, resolve);
  });
}

export async function askBridge(
  payload: AskPayload,
  config: BridgeClientConfig = DEFAULT_CONFIG,
): Promise<string | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.retryAttempts; attempt++) {
    const result = await sendMessage({ type: 'ASK_BRIDGE', payload });

    if (!result) {
      // Service worker may have been killed — set a diagnostic error and retry
      lastError = new Error('Background service worker returned null (may have been suspended)');
      if (attempt < config.retryAttempts) await sleep(config.retryDelayMs * (attempt + 1));
      continue;
    }

    // Bridge says this trigger was already replied to — skip silently
    if (result.alreadyReplied) {
      return null;
    }

    if (result.response) {
      return result.response;
    }

    if (result.error) {
      lastError = new Error(result.error);
      if (result.error.includes('Rate limited')) {
        await sleep(config.retryDelayMs * (attempt + 1));
        continue;
      }
    }

    if (attempt < config.retryAttempts) {
      await sleep(config.retryDelayMs * (attempt + 1));
    }
  }

  throw lastError ?? new Error('Bridge request failed');
}

export async function pingBridge(): Promise<boolean> {
  const result = await sendMessage({ type: 'PING_BRIDGE' });
  return result?.connected ?? false;
}

export async function fetchProjects(): Promise<{ slugs: string[]; commands: string[] }> {
  const result = await sendMessage({ type: 'FETCH_PROJECTS' });
  return result ?? { slugs: [], commands: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
