const dot = document.getElementById('bridge-dot')!;
const label = document.getElementById('bridge-label')!;
const targetChatInput = document.getElementById('targetChat') as HTMLInputElement;
const botNameInput = document.getElementById('botName') as HTMLInputElement;
const savedMsg = document.getElementById('saved')!;
const resetBtn = document.getElementById('resetBtn') as HTMLButtonElement;
const resetMsg = document.getElementById('resetMsg')!;

// Load saved settings
chrome.storage.sync.get(
  { botName: 'Clarke Plumo', targetChat: 'SAINT EXPEDITUS SUBDIVISION' },
  (result) => {
    targetChatInput.value = result.targetChat;
    botNameInput.value = result.botName;
  },
);

// Save on change (debounced)
let saveTimeout: ReturnType<typeof setTimeout>;
function saveSettings() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    chrome.storage.sync.set({
      targetChat: targetChatInput.value.trim(),
      botName: botNameInput.value.trim(),
    }, () => {
      savedMsg.classList.add('show');
      setTimeout(() => savedMsg.classList.remove('show'), 2000);
    });
  }, 500);
}

targetChatInput.addEventListener('input', saveSettings);
botNameInput.addEventListener('input', saveSettings);

// Reset conversation button
resetBtn.addEventListener('click', () => {
  resetBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'RESET_CONVERSATION' }, (response) => {
    resetBtn.disabled = false;
    if (chrome.runtime.lastError) {
      resetMsg.textContent = 'Error: ' + chrome.runtime.lastError.message;
      resetMsg.classList.add('show');
      setTimeout(() => resetMsg.classList.remove('show'), 3000);
      return;
    }
    if (response?.ok) {
      resetMsg.textContent = 'Reset!';
      resetMsg.classList.add('show');
      setTimeout(() => resetMsg.classList.remove('show'), 2000);
    }
  });
});

// Check bridge status
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
  if (chrome.runtime.lastError) {
    dot.classList.remove('green');
    dot.classList.add('red');
    label.textContent = 'Bridge: service worker inactive';
    return;
  }
  if (response?.connected) {
    dot.classList.remove('red');
    dot.classList.add('green');
    label.textContent = 'Bridge: connected';
  } else {
    dot.classList.remove('green');
    dot.classList.add('red');
    label.textContent = 'Bridge: disconnected';
  }
});
