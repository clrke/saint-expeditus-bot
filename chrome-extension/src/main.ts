import { MessageStore } from './message-store.js';
import {
  TriggerRegistry,
  createExpeditusTrigger,
} from './trigger-registry.js';
import { RequestQueue } from './request-queue.js';
import { parseRow, type ParserContext } from './message-parser.js';
import { askBridge, pingBridge, fetchProjects } from './bridge-client.js';
import { injectAndSend } from './response-injector.js';
import { findMessageRows, identifyChat } from './element-discovery.js';
import { observeNewMessages, startPolling } from './dom-observer.js';
import type { Trigger, ParsedMessage } from '../../shared/types.js';

const DEFAULT_BOT_NAME = 'Clarke Plumo';
const DEFAULT_TARGET_CHAT = 'SAINT EXPEDITUS SUBDIVISION';

interface Settings {
  botName: string;
  targetChat: string;
}

async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { botName: DEFAULT_BOT_NAME, targetChat: DEFAULT_TARGET_CHAT },
      (result) => resolve(result as Settings),
    );
  });
}

const store = new MessageStore(100);
const registry = new TriggerRegistry();
registry.register('/expeditus', createExpeditusTrigger);

const queue = new RequestQueue<void>(5000);
// Tracks trigger message text to prevent duplicate enqueuing
// (Messenger React re-renders create new DOM elements for same message)
const seenTriggers = new Set<string>();

async function handleTrigger(
  trigger: Trigger,
  repliedToMessage: ParsedMessage | null,
  botName: string,
): Promise<void> {
  // Post "Processing..." immediately
  await injectAndSend(`[${botName}] Processing…`);

  const response = await askBridge({
    trigger,
    recentMessages: [], // Sessions use resume — context already in session
    repliedToMessage,
  });
  // null means bridge already replied to this trigger — skip
  if (response === null) return;
  await injectAndSend(response);
}

function createRowProcessor(botName: string) {
  return (row: Element, ctx: ParserContext): ParserContext => {
    // DOM-level dedup — survives across observer/poller scans within a session
    if (row.hasAttribute('data-expeditus')) return ctx;
    row.setAttribute('data-expeditus', 'seen');

    const { message, updatedCtx } = parseRow(row, ctx);
    if (!message) return updatedCtx;
    if (!store.add(message)) return updatedCtx; // duplicate

    const trigger = registry.detect(message);

    // Skip own non-trigger messages (but allow own /expeditus triggers)
    // Messenger shows "You sent" for your own messages instead of your name
    const isOwnMessage = message.sender === botName
      || message.sender.toLowerCase() === 'you sent';
    if (!trigger && isOwnMessage) return updatedCtx;
    if (!trigger) return updatedCtx;

    // Dedup by message text — immune to DOM re-renders and sender name variations
    // Repeatable commands (e.g. /list, /info) skip dedup
    const repeatableCommands = ['list', 'details', 'info', 'vacation', 'unvacation', 'auto-decide-extend', 'register', 'update', 'reset', 'compact', 'nudge', 'help'];
    const cmdMatch = message.message.trim().match(/^\/([a-z0-9-]+)/i);
    const isRepeatable = cmdMatch && repeatableCommands.includes(cmdMatch[1].toLowerCase());

    const triggerText = message.message.slice(0, 120);
    if (!isRepeatable && seenTriggers.has(triggerText)) return updatedCtx;
    seenTriggers.add(triggerText);

    console.log(`[Expeditus] Trigger detected: "${message.message}" from ${message.sender}`);

    // Resolve reply context
    const repliedTo = trigger.replyTo
      ? store.findBySender(trigger.replyTo)
      : null;

    // Instant commands bypass the queue — they don't call Claude
    if (isRepeatable) {
      handleTrigger(trigger, repliedTo, botName).catch((err) => {
        console.error('[Expeditus]', err);
      });
    } else {
      queue
        .enqueue(() => handleTrigger(trigger, repliedTo, botName))
        .catch((err) => {
          console.error('[Expeditus]', err);
          injectAndSend(
            'Technical issue. Please try again later.',
          ).catch(() => {});
        });
    }

    return updatedCtx;
  };
}

async function init(): Promise<void> {
  const { botName, targetChat } = await loadSettings();
  const chatName = identifyChat();
  if (!chatName?.includes(targetChat)) {
    console.log(
      `[Expeditus] Not in target chat (found: "${chatName}", want: "${targetChat}"), pausing.`,
    );
    setTimeout(init, 5000);
    return;
  }

  console.log(`[Expeditus] Active on "${chatName}"`);

  // Check bridge connectivity
  pingBridge().then((ok) => {
    if (!ok) {
      console.warn('[Expeditus] Bridge server not reachable at localhost:3141');
    } else {
      console.log('[Expeditus] Bridge server connected');
    }
  });

  const processRow = createRowProcessor(botName);

  // Initial scan of visible messages
  let ctx: ParserContext = { sender: null, timestamp: null };
  const rows = findMessageRows();
  rows.forEach((row) => {
    ctx = processRow(row, ctx);
  });
  console.log(`[Expeditus] Loaded ${store.size} existing messages`);

  // MutationObserver for new messages
  observeNewMessages((row) => {
    ctx = processRow(row, ctx);
  });

  // Fallback polling
  startPolling((row) => {
    ctx = processRow(row, ctx);
  }, 3000);

  // Refresh project triggers on init and every 60s
  refreshProjectTriggers();
  setInterval(refreshProjectTriggers, 60_000);

  // Refresh Messenger page every 5 minutes to keep DOM fresh
  setInterval(() => {
    console.log('[Expeditus] Refreshing page...');
    window.location.reload();
  }, 5 * 60 * 1000);
}

// Dynamic project trigger registration
async function refreshProjectTriggers() {
  try {
    const { slugs, commands } = await fetchProjects();
    const allPrefixes = [
      ...commands.map(c => `/${c}`),
      ...slugs.filter(s => s !== 'expeditus').map(s => `/${s}`),
    ];
    for (const prefix of allPrefixes) {
      if (!registry.registeredTriggers.includes(prefix.toLowerCase())) {
        registry.register(prefix, createExpeditusTrigger);
      }
    }
  } catch (err) {
    console.warn('[Expeditus] Failed to refresh project triggers:', err);
  }
}

// Listen for proactive messages from cron/SSE
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROACTIVE_MESSAGE' && message.text) {
    injectAndSend(message.text).catch(console.error);
  }
});

// Start
if (document.readyState === 'complete') {
  init();
} else {
  window.addEventListener('load', init);
}
