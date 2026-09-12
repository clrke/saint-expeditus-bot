// ==========================================
// STRATEGY: All discovery is based on:
// 1. ARIA roles/labels (accessibility, rarely change)
// 2. Structural patterns (tag nesting, dir attributes)
// 3. Content heuristics (text patterns, image src patterns)
// 4. Layout characteristics (scrollHeight, visibility)
// ==========================================

/** Find all message row containers */
export function findMessageRows(root: Element | Document = document): Element[] {
  const rows = root.querySelectorAll('[role="row"]');
  if (rows.length > 0) return [...rows];

  const grid =
    root.querySelector('[role="grid"]') ?? root.querySelector('[role="list"]');
  if (grid) return [...grid.children].filter((el) => el.children.length > 0);

  return [];
}

/** Find the scrollable message container */
export function findMessageContainer(): Element | null {
  const grid = document.querySelector('[role="grid"]');
  if (grid) {
    let el: Element | null = grid;
    while (el && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 50) return el;
      el = el.parentElement;
    }
  }

  let best: Element | null = null;
  let maxHeight = 0;
  for (const div of document.querySelectorAll('div')) {
    const style = getComputedStyle(div);
    const scrollable =
      div.scrollHeight > div.clientHeight + 50 &&
      ['auto', 'scroll'].includes(style.overflowY);
    if (scrollable && div.scrollHeight > maxHeight) {
      maxHeight = div.scrollHeight;
      best = div;
    }
  }
  return best;
}

/** Extract message text from a row */
export function findMessageText(row: Element): string | null {
  const candidates = row.querySelectorAll('div[dir="auto"]');

  for (const el of candidates) {
    const text = el.textContent?.trim();
    if (text && text !== 'Enter' && text.length > 0 && text.length < 5000) {
      if (!el.closest('button') && !el.closest('[role="button"]')) {
        return text;
      }
    }
  }
  return null;
}

/** Extract sender name from a row using structural heuristics */
export function findSenderName(row: Element): string | null {
  const h5 = row.querySelector('h5');
  if (h5) {
    const text = h5.textContent?.trim();
    if (text && text.length > 0 && text.length < 100) return text;
  }

  const imgs = row.querySelectorAll('img[alt]');
  for (const img of imgs) {
    const alt = img.getAttribute('alt') ?? '';
    const src = img.getAttribute('src') ?? '';
    if (
      alt &&
      src.includes('fbcdn') &&
      !alt.includes('.png') &&
      alt !== 'Open photo' &&
      alt.length > 1 &&
      alt.length < 80
    ) {
      return alt;
    }
  }

  return null;
}

/** Extract timestamp from a row */
export function findTimestamp(row: Element): string | null {
  const DATE_PATTERN =
    /\d{1,2}\/\d{1,2}\/\d{2,4}|\b\d{1,2}:\d{2}\b|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/;

  const spans = row.querySelectorAll('span');
  for (const span of spans) {
    const text = span.textContent?.trim();
    if (text && DATE_PATTERN.test(text) && text.length < 50) {
      return text;
    }
  }

  const timeEl = row.querySelector('time');
  if (timeEl) {
    return (
      timeEl.getAttribute('datetime') ?? timeEl.textContent?.trim() ?? null
    );
  }

  return null;
}

/** Find the message input field */
export function findMessageInput(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(
    '[role="textbox"][contenteditable="true"]',
  );
  if (el) return el;

  const editables = document.querySelectorAll<HTMLElement>(
    '[contenteditable="true"]',
  );
  for (const ed of editables) {
    if (ed.offsetHeight > 0 && ed.offsetWidth > 0) return ed;
  }
  return null;
}

/** Find the send button */
export function findSendButton(): HTMLElement | null {
  const labels = ['Press enter to send', 'Send', 'Ipadala'];
  for (const label of labels) {
    const btn = document.querySelector<HTMLElement>(
      `[aria-label="${label}"]`,
    );
    if (btn) return btn;
  }

  const input = findMessageInput();
  if (input) {
    const parent = input.closest('form') ?? input.parentElement?.parentElement;
    if (parent) {
      const btn = parent.querySelector<HTMLElement>('[role="button"]');
      if (btn) return btn;
    }
  }
  return null;
}

/** Detect reply pattern from sender text: "Resa replied to Emva" */
export function parseReplyPattern(
  senderText: string,
): { sender: string; repliedTo: string } | null {
  const match = senderText.match(/^(.+?)\s+replied to\s+(.+)$/i);
  if (match) return { sender: match[1].trim(), repliedTo: match[2].trim() };
  return null;
}

/** Identify which group chat is currently open */
export function identifyChat(): string | null {
  // Strategy 1: aria-label="Conversation titled <name>" — most reliable
  const CONVO_PATTERN = /^Conversation titled\s+(.+)$/i;
  const labeled = document.querySelectorAll('[aria-label]');
  for (const el of labeled) {
    const match = el.getAttribute('aria-label')?.match(CONVO_PATTERN);
    if (match) return match[1].trim();
  }

  // Strategy 2: aria-label on role="main"
  const main = document.querySelector('[role="main"]');
  if (main) {
    const label = main.getAttribute('aria-label');
    if (label) {
      const match = label.match(CONVO_PATTERN);
      if (match) return match[1].trim();
      if (!label.includes('Messenger')) return label;
    }
  }

  // Strategy 3: Page title (if not generic "Messenger")
  const title = document.title;
  if (title && !title.includes('Messenger') && title.length < 100)
    return title;

  return null;
}

// ==========================================
// HEALTH CHECK
// ==========================================
export interface HealthReport {
  messageRows: number;
  messageContainer: boolean;
  messageInput: boolean;
  sendButton: boolean;
  chatIdentified: string | null;
}

export function checkHealth(): HealthReport {
  return {
    messageRows: findMessageRows().length,
    messageContainer: findMessageContainer() !== null,
    messageInput: findMessageInput() !== null,
    sendButton: findSendButton() !== null,
    chatIdentified: identifyChat(),
  };
}
