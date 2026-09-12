const BRIDGE_URL = 'http://localhost:3141';

async function checkBridge(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function updateBadge(): Promise<void> {
  const connected = await checkBridge();
  await chrome.action.setBadgeText({ text: connected ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({
    color: connected ? '#22c55e' : '#ef4444',
  });
}

// Check bridge status periodically
setInterval(updateBadge, 15_000);

// Check on startup
updateBadge();

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_STATUS') {
    checkBridge().then((connected) => {
      sendResponse({ connected });
    });
    return true;
  }

  if (message.type === 'PING_BRIDGE') {
    checkBridge().then((connected) => {
      sendResponse({ connected });
    });
    return true;
  }

  if (message.type === 'RESET_CONVERSATION') {
    fetch(`${BRIDGE_URL}/reset`, { method: 'POST' })
      .then(async (res) => {
        const data = await res.json();
        sendResponse({ ok: res.ok, message: data.message });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: (err as Error).message });
      });
    return true;
  }

  if (message.type === 'FETCH_PROJECTS') {
    fetch(`${BRIDGE_URL}/projects`)
      .then(res => res.json())
      .then(data => sendResponse(data))
      .catch(() => sendResponse({ slugs: [], commands: [] }));
    return true;
  }

  if (message.type === 'ASK_BRIDGE') {
    fetch(`${BRIDGE_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message.payload),
    })
      .then(async (res) => {
        if (res.status === 429) {
          sendResponse({ error: 'Rate limited. Try again in a minute.' });
          return;
        }
        if (!res.ok) {
          sendResponse({ error: `Bridge error: ${res.status}` });
          return;
        }
        const data = await res.json();
        sendResponse({ response: data.response, alreadyReplied: data.alreadyReplied });
      })
      .catch((err) => {
        sendResponse({ error: (err as Error).message });
      });
    return true;
  }
});

// SSE connection for proactive messages (auto-decide cron)
function connectSSE() {
  const eventSource = new EventSource(`${BRIDGE_URL}/events`);
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'message') {
        chrome.tabs.query({ url: 'https://www.messenger.com/*' }, (tabs) => {
          for (const tab of tabs) {
            if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'PROACTIVE_MESSAGE', text: data.text, slug: data.slug ?? null });
          }
        });
      }
      // 'connected' event is expected on connect — no action needed
    } catch {}
  };
  eventSource.onerror = () => {
    eventSource.close();
    setTimeout(connectSSE, 10_000);
  };
}

connectSSE();
