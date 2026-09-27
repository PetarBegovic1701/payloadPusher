// Runs in the (invisible) DevTools page, once per DevTools window.
//
// Chrome only loads panel.html the first time you click the "Payload Capture"
// tab. To avoid losing requests made before that, we start listening here
// right away, buffer finished requests, and hand them to the panel as soon as
// it is shown for the first time. After that, requests are forwarded live.

const MAX_BUFFERED = 1000;
const buffered = [];
let panelWindow = null;

chrome.devtools.network.onRequestFinished.addListener((entry) => {
  if (panelWindow) {
    panelWindow.payloadCapture.ingest(entry);
  } else if (buffered.length < MAX_BUFFERED) {
    buffered.push(entry);
  }
});

chrome.devtools.panels.create('Payload Capture', '', 'panel.html', (panel) => {
  panel.onShown.addListener((win) => {
    if (panelWindow) return;
    panelWindow = win;
    for (const entry of buffered.splice(0)) {
      win.payloadCapture.ingest(entry);
    }
  });
});
