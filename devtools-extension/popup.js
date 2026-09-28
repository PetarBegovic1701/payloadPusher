// Toolbar popup: explains where the panel is and checks the capture server.

const DEFAULT_SERVER_URL = 'http://127.0.0.1:4545';

(async function checkServer() {
  const el = document.getElementById('server');
  let serverUrl = DEFAULT_SERVER_URL;
  try {
    const { settings } = await chrome.storage.local.get('settings');
    if (settings && settings.serverUrl) serverUrl = settings.serverUrl;
  } catch {
    /* use the default */
  }
  const base = serverUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(base + '/health');
    const body = await res.json();
    if (!res.ok || body.status !== 'ok') throw new Error(`HTTP ${res.status}`);
    el.textContent = `Capture server: running at ${base}`;
    el.className = 'server ok';
  } catch {
    el.textContent = `Capture server: not running at ${base}. Start it with "npm start" in capture-server/.`;
    el.className = 'server down';
  }
})();
