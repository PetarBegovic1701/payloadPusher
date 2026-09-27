// Runs in the (invisible) DevTools page, once per DevTools window.
//
// Chrome only loads panel.html the first time you click the "Payload Capture"
// tab. To avoid losing requests made before that, we start listening here
// right away, buffer finished requests, and hand them to the panel as soon as
// it is shown for the first time. After that, requests are forwarded live.
// (The panel also reads the Network tab's log with getHAR() when it opens and
// skips duplicates, so this buffer mainly covers requests from pages you
// navigated away from.)

/* global isStaticRequest */

const MAX_BUFFERED = 5000; // all requests
const MAX_BUFFERED_STATIC = 200; // of which scripts, images, … (oldest are dropped first)
const buffered = [];
let bufferedStatic = 0;
let panelWindow = null;

function bufferEntry(entry) {
  buffered.push(entry);
  if (isStaticRequest(entry)) bufferedStatic++;

  if (bufferedStatic > MAX_BUFFERED_STATIC) {
    buffered.splice(buffered.findIndex(isStaticRequest), 1);
    bufferedStatic--;
  }
  if (buffered.length > MAX_BUFFERED) {
    const dropped = buffered.shift();
    if (isStaticRequest(dropped)) bufferedStatic--;
  }
}

chrome.devtools.network.onRequestFinished.addListener((entry) => {
  if (panelWindow) {
    panelWindow.payloadCapture.ingest(entry);
  } else {
    bufferEntry(entry);
  }
});

chrome.devtools.panels.create('Payload Capture', '', 'panel.html', (panel) => {
  panel.onShown.addListener((win) => {
    if (panelWindow) return;
    panelWindow = win;
    for (const entry of buffered.splice(0)) {
      win.payloadCapture.ingest(entry);
    }
    bufferedStatic = 0;
  });
});
