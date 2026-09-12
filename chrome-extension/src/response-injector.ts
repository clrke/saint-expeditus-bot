import { findMessageInput, findSendButton } from './element-discovery.js';

export async function injectAndSend(text: string): Promise<void> {
  const input = findMessageInput();
  if (!input) throw new Error('Message input not found');

  input.focus();
  await sleep(100);

  // Clear any existing content
  document.execCommand('selectAll', false, undefined);
  document.execCommand('delete', false, undefined);
  await sleep(50);

  // Insert text line by line, using Shift+Enter for line breaks.
  // Empty lines must still trigger insertLineBreak (not skipped) so
  // blank-line paragraph separators are preserved in the injected text.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Insert line content (including empty strings — execCommand('insertText', …, '') is a no-op
    // but we call it unconditionally so the logic is uniform)
    if (lines[i]) {
      document.execCommand('insertText', false, lines[i]);
    }
    if (i < lines.length - 1) {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          shiftKey: true,
          bubbles: true,
        }),
      );
      document.execCommand('insertLineBreak', false, undefined);
    }
  }
  await sleep(100);

  // Verify the first non-empty line of text appears in the input.
  // Use the first non-whitespace slice for comparison to avoid issues with
  // special characters or whitespace-only prefixes causing false mismatches.
  const firstNonEmpty = lines.find(l => l.trim()) ?? text;
  const verifySlice = firstNonEmpty.slice(0, 20);
  if (verifySlice && !input.textContent?.includes(verifySlice)) {
    input.textContent = text;
  }

  // Notify React that content changed (do NOT put full text in data —
  // Messenger's handler will process and send it, causing a double-send)
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true }),
  );
  await sleep(200);

  // Send
  const sendBtn = findSendButton();
  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        bubbles: true,
      }),
    );
  }

  await sleep(200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
