import { findMessageRows } from './element-discovery.js';

export type RowCallback = (row: Element) => void;

export function observeNewMessages(
  onNewRow: RowCallback,
): MutationObserver {
  const grid =
    document.querySelector('[role="grid"]') ??
    findMessageRows()[0]?.closest('[role="grid"]') ??
    document.body;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        const newRows = node.matches('[role="row"]')
          ? [node]
          : [...node.querySelectorAll('[role="row"]')];
        for (const row of newRows) {
          onNewRow(row);
        }
      }
    }
  });

  observer.observe(grid, { childList: true, subtree: true });
  return observer;
}

export function startPolling(
  onRow: RowCallback,
  intervalMs = 3000,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const allRows = findMessageRows();
    for (const row of allRows) {
      onRow(row);
    }
  }, intervalMs);
}
