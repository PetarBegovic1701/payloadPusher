// Page capture bridge: runs in the extension's isolated world on the same page
// as page-hook.js. It forwards what the hook records to the DevTools panel.
// If no panel is open, the message goes nowhere and is dropped.

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'payload-capture-hook') return;
  try {
    chrome.runtime.sendMessage({ type: 'payload-capture/page-request', data: event.data.data }).catch(() => {});
  } catch {
    // The extension was reloaded; this old copy of the script can't reach it.
  }
});
