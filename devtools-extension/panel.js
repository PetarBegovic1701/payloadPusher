// Payload Capture panel.
//
// Sections:
//   1. Settings & storage
//   2. Filter + naming logic   <- the bits you'll most likely want to tweak
//   3. Capture pipeline (ingest -> filter -> parse -> name -> send)
//   4. Captured-requests list UI
//   5. Settings + mappings UI

/* global DEFAULT_MAPPINGS */

// ---------------------------------------------------------------------------
// 1. Settings & storage
// ---------------------------------------------------------------------------

const ALL_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'];
const MAX_ROWS = 500;

const DEFAULT_SETTINGS = {
  captureEnabled: true,
  autoSend: true,
  serverUrl: 'http://127.0.0.1:4545',
  methods: ['POST', 'PUT', 'PATCH'],
  urlFilter: '',
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  mappings: [],
  entries: [], // newest first
  ignored: 0,
};

async function loadState() {
  const stored = await chrome.storage.local.get(['settings', 'mappings']);
  state.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  if (Array.isArray(stored.mappings)) {
    state.mappings = stored.mappings;
  } else {
    // First run: seed from default-mappings.js.
    state.mappings = cloneDefaults();
    await saveMappings();
  }
}

function cloneDefaults() {
  return DEFAULT_MAPPINGS.map((m) => ({ pattern: m.pattern, method: m.method || '', schemaName: m.schemaName }));
}

function saveSettings() {
  return chrome.storage.local.set({ settings: state.settings });
}

function saveMappings() {
  reresolveUnsent();
  return chrome.storage.local.set({ mappings: state.mappings });
}

let mappingsSaveTimer = null;
function saveMappingsSoon() {
  clearTimeout(mappingsSaveTimer);
  mappingsSaveTimer = setTimeout(saveMappings, 300);
}

// ---------------------------------------------------------------------------
// 2. Filter + naming logic
// ---------------------------------------------------------------------------

/**
 * Compile a user pattern into a predicate over URLs.
 *   "re:<expr>" -> case-insensitive RegExp
 *   anything else -> case-insensitive substring
 * Throws on an invalid regex so the UI can flag it.
 */
function compilePattern(pattern) {
  if (pattern.startsWith('re:')) {
    const re = new RegExp(pattern.slice(3), 'i');
    return (url) => re.test(url);
  }
  const needle = pattern.toLowerCase();
  return (url) => url.toLowerCase().includes(needle);
}

function safeMatch(pattern, url) {
  try {
    return compilePattern(pattern)(url);
  } catch {
    return false;
  }
}

/** Should this finished request be captured at all? */
function passesFilters(method, url) {
  const { methods, urlFilter } = state.settings;
  if (!methods.includes(method)) return false;
  if (urlFilter.trim() && !safeMatch(urlFilter.trim(), url)) return false;
  return true;
}

/** Same rules as the server, so what you see is the file name you get. */
function sanitizeSchemaName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

/** Path segments that look like record IDs get replaced by "id". */
function isIdLike(segment) {
  return (
    /^\d+$/.test(segment) || // 42
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || // UUID
    /^[0-9a-f]{16,}$/i.test(segment) || // Mongo ObjectId / hashes
    (segment.length >= 20 && /\d/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment)) // opaque tokens
  );
}

/**
 * Fallback when no mapping matches:
 *   POST https://api.example.com/v1/users/42/roles?x=1 -> "post_v1_users_id_roles"
 */
function deriveSchemaName(url, method) {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((s) => (isIdLike(s) ? 'id' : decodeURIComponentSafe(s)));
  const base = segments.join('_') || 'root';
  return sanitizeSchemaName(`${method.toLowerCase()}_${base}`);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Mapping table first (top to bottom, first match wins), then fallback. */
function resolveSchemaName(url, method) {
  for (const m of state.mappings) {
    if (!m.pattern || !m.schemaName) continue;
    if (m.method && m.method.toUpperCase() !== method) continue;
    if (safeMatch(m.pattern, url)) {
      return { name: sanitizeSchemaName(m.schemaName), source: 'mapped' };
    }
  }
  return { name: deriveSchemaName(url, method), source: 'derived' };
}

// ---------------------------------------------------------------------------
// 3. Capture pipeline
// ---------------------------------------------------------------------------

let nextId = 1;
let resolveReady;
const ready = new Promise((r) => (resolveReady = r));

/**
 * Entry point called by devtools.js for every finished network request
 * (a HAR entry from chrome.devtools.network.onRequestFinished).
 */
async function ingest(har) {
  await ready;
  const { settings } = state;
  if (!settings.captureEnabled) return;

  const method = (har.request.method || '').toUpperCase();
  const url = har.request.url;
  if (!passesFilters(method, url)) {
    state.ignored++;
    renderCounters();
    return;
  }

  const entry = {
    id: nextId++,
    timestamp: har.startedDateTime || new Date().toISOString(),
    method,
    url,
    payload: undefined,
    schemaName: '',
    schemaSource: '',
    status: 'pending',
    detail: '',
  };

  const text = har.request.postData && har.request.postData.text;
  if (text === undefined || text === null || text === '') {
    entry.status = 'skipped';
    entry.detail = 'No request body';
  } else {
    try {
      entry.payload = JSON.parse(text);
    } catch (err) {
      const mime = (har.request.postData && har.request.postData.mimeType) || 'unknown type';
      entry.status = 'skipped';
      entry.detail = `Body is not valid JSON (${mime})`;
      console.warn(`[Payload Capture] Skipped ${method} ${url}: body is not JSON (${mime}).`, err);
    }
  }

  const resolved = resolveSchemaName(url, method);
  entry.schemaName = resolved.name;
  entry.schemaSource = resolved.source;

  addEntry(entry);

  if (entry.status === 'pending' && settings.autoSend) {
    send(entry);
  }
}

async function send(entry) {
  if (entry.payload === undefined) return;
  const schemaName = sanitizeSchemaName(entry.schemaName);
  if (!schemaName) {
    setStatus(entry, 'failed', 'Schema name is empty');
    return;
  }

  setStatus(entry, 'sending', '');
  const endpoint = state.settings.serverUrl.replace(/\/+$/, '') + '/capture';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaName,
        url: entry.url,
        method: entry.method,
        payload: entry.payload,
        timestamp: entry.timestamp,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setStatus(entry, 'sent', body.saved ? `→ ${body.saved}` : '');
      setServerStatus(true);
    } else {
      setStatus(entry, 'failed', body.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    setStatus(entry, 'failed', `Cannot reach ${endpoint} — is the capture server running? (${err.message})`);
    setServerStatus(false);
  }
}

// Exposed for devtools.js.
window.payloadCapture = { ingest };

// ---------------------------------------------------------------------------
// 4. Captured-requests list UI
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const rowEls = new Map(); // entry.id -> { row, detailRow }

function addEntry(entry) {
  state.entries.unshift(entry);
  const els = createRow(entry);
  rowEls.set(entry.id, els);
  $('captureRows').prepend(els.row);

  while (state.entries.length > MAX_ROWS) {
    const old = state.entries.pop();
    removeRow(old.id);
  }
  renderCounters();
}

function removeRow(id) {
  const els = rowEls.get(id);
  if (!els) return;
  els.row.remove();
  if (els.detailRow) els.detailRow.remove();
  rowEls.delete(id);
}

function createRow(entry) {
  const row = $('captureRowTemplate').content.firstElementChild.cloneNode(true);
  const els = { row, detailRow: null };

  row.querySelector('.col-time').textContent = formatTime(entry.timestamp);
  row.querySelector('.col-time').title = entry.timestamp;
  row.querySelector('.col-method').textContent = entry.method;
  row.querySelector('.col-method').className = `col-method method-${entry.method.toLowerCase()}`;
  const urlText = row.querySelector('.url-text');
  urlText.textContent = entry.url;
  urlText.title = entry.url;

  const input = row.querySelector('.schema-input');
  input.value = entry.schemaName;
  input.addEventListener('input', () => {
    entry.schemaName = input.value;
    entry.schemaSource = 'edited';
    updateRow(entry);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && entry.payload !== undefined) send(entry);
  });

  row.querySelector('.send-btn').addEventListener('click', () => send(entry));
  row.querySelector('.map-btn').addEventListener('click', () => addMappingFromEntry(entry));
  row.querySelector('.view-btn').addEventListener('click', () => toggleDetail(entry, els));

  updateRow(entry, els);
  return els;
}

function updateRow(entry, els = rowEls.get(entry.id)) {
  if (!els) return;
  const { row } = els;
  row.dataset.status = entry.status;

  const status = row.querySelector('.status');
  status.textContent = entry.status;
  status.className = `status status-${entry.status}`;
  const detail = row.querySelector('.status-detail');
  detail.textContent = entry.detail;
  detail.title = entry.detail;

  const preview = sanitizeSchemaName(entry.schemaName);
  row.querySelector('.schema-source').textContent =
    entry.schemaSource + (preview !== entry.schemaName ? ` · saves as ${preview || '(invalid)'}` : '');

  const sendBtn = row.querySelector('.send-btn');
  const hasPayload = entry.payload !== undefined;
  sendBtn.disabled = !hasPayload || entry.status === 'sending';
  sendBtn.textContent = entry.status === 'sent' || entry.status === 'failed' ? 'Resend' : 'Send';
  row.querySelector('.view-btn').disabled = !hasPayload;
}

/** After a mapping change, rename rows that haven't been sent or hand-edited. */
function reresolveUnsent() {
  for (const entry of state.entries) {
    if (entry.schemaSource === 'edited' || !['pending', 'skipped', 'failed'].includes(entry.status)) continue;
    const resolved = resolveSchemaName(entry.url, entry.method);
    entry.schemaName = resolved.name;
    entry.schemaSource = resolved.source;
    const els = rowEls.get(entry.id);
    if (els) els.row.querySelector('.schema-input').value = entry.schemaName;
    updateRow(entry);
  }
}

function setStatus(entry, status, detail) {
  entry.status = status;
  entry.detail = detail;
  updateRow(entry);
  renderCounters();
}

function toggleDetail(entry, els) {
  if (els.detailRow) {
    els.detailRow.remove();
    els.detailRow = null;
    return;
  }
  const tr = document.createElement('tr');
  tr.className = 'detail-row';
  const td = document.createElement('td');
  td.colSpan = 6;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(entry.payload, null, 2);
  td.appendChild(pre);
  tr.appendChild(td);
  els.row.after(tr);
  els.detailRow = tr;
}

function renderCounters() {
  const counts = { sent: 0, failed: 0, skipped: 0, pending: 0 };
  for (const e of state.entries) {
    if (e.status in counts) counts[e.status]++;
  }
  $('counters').textContent =
    `${counts.sent} sent · ${counts.failed} failed · ${counts.skipped} skipped · ` +
    `${counts.pending} pending · ${state.ignored} ignored by filters`;
  $('sendPending').disabled = counts.pending === 0;
  $('emptyHint').classList.toggle('hidden', state.entries.length > 0);
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function setServerStatus(ok, text) {
  const el = $('serverStatus');
  el.className = `server-status ${ok ? 'ok' : 'down'}`;
  el.textContent = text || (ok ? 'server: ok' : 'server: unreachable');
}

async function testServer() {
  const url = state.settings.serverUrl.replace(/\/+$/, '') + '/health';
  const el = $('serverStatus');
  el.className = 'server-status unknown';
  el.textContent = 'server: checking…';
  try {
    const res = await fetch(url);
    const body = await res.json();
    setServerStatus(res.ok && body.status === 'ok');
  } catch (err) {
    setServerStatus(false, `server: unreachable (${err.message})`);
  }
}

// ---------------------------------------------------------------------------
// 5. Settings + mappings UI
// ---------------------------------------------------------------------------

function initToolbar() {
  const capture = $('captureEnabled');
  capture.checked = state.settings.captureEnabled;
  capture.addEventListener('change', () => {
    state.settings.captureEnabled = capture.checked;
    saveSettings();
  });

  const autoSend = $('autoSend');
  autoSend.checked = state.settings.autoSend;
  autoSend.addEventListener('change', () => {
    state.settings.autoSend = autoSend.checked;
    saveSettings();
  });

  $('testServer').addEventListener('click', testServer);
  $('sendPending').addEventListener('click', () => {
    state.entries.filter((e) => e.status === 'pending').forEach(send);
  });
  $('clearList').addEventListener('click', () => {
    for (const e of state.entries) removeRow(e.id);
    state.entries = [];
    state.ignored = 0;
    renderCounters();
  });
}

function initSettings() {
  const serverUrl = $('serverUrl');
  serverUrl.value = state.settings.serverUrl;
  serverUrl.addEventListener('change', () => {
    state.settings.serverUrl = serverUrl.value.trim() || DEFAULT_SETTINGS.serverUrl;
    serverUrl.value = state.settings.serverUrl;
    saveSettings();
    testServer();
  });

  const methodBox = $('methodFilters');
  for (const method of ALL_METHODS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = method;
    cb.checked = state.settings.methods.includes(method);
    cb.addEventListener('change', () => {
      state.settings.methods = [...methodBox.querySelectorAll('input:checked')].map((c) => c.value);
      saveSettings();
    });
    label.append(cb, ' ', method);
    methodBox.appendChild(label);
  }

  const urlFilter = $('urlFilter');
  urlFilter.value = state.settings.urlFilter;
  const validate = () => {
    const err = patternError(urlFilter.value.trim());
    $('urlFilterError').textContent = err;
    $('urlFilterError').classList.toggle('hidden', !err);
    urlFilter.classList.toggle('invalid', Boolean(err));
  };
  urlFilter.addEventListener('input', () => {
    state.settings.urlFilter = urlFilter.value;
    validate();
    saveSettings();
  });
  validate();
}

function patternError(pattern) {
  if (!pattern) return '';
  try {
    compilePattern(pattern);
    return '';
  } catch (err) {
    return `Invalid regex: ${err.message}`;
  }
}

function renderMappings() {
  const tbody = $('mappingRows');
  tbody.textContent = '';
  state.mappings.forEach((m, index) => {
    const tr = document.createElement('tr');

    const order = document.createElement('td');
    order.className = 'order';
    order.append(
      iconButton('▲', 'Move up', index === 0, () => moveMapping(index, -1)),
      iconButton('▼', 'Move down', index === state.mappings.length - 1, () => moveMapping(index, 1)),
    );

    const pattern = textCell(m.pattern, '/v1/users  or  re:/v1/users/[^/]+$', (v) => {
      m.pattern = v;
      const err = patternError(v.trim());
      pattern.input.classList.toggle('invalid', Boolean(err));
      pattern.input.title = err;
    });
    const err = patternError((m.pattern || '').trim());
    pattern.input.classList.toggle('invalid', Boolean(err));
    pattern.input.title = err;

    const methodTd = document.createElement('td');
    const select = document.createElement('select');
    for (const opt of ['', ...ALL_METHODS]) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt || 'any';
      select.appendChild(o);
    }
    select.value = (m.method || '').toUpperCase();
    select.addEventListener('change', () => {
      m.method = select.value;
      saveMappingsSoon();
    });
    methodTd.appendChild(select);

    const schema = textCell(m.schemaName, 'createUser', (v) => (m.schemaName = v));

    const del = document.createElement('td');
    del.appendChild(
      iconButton('✕', 'Delete row', false, () => {
        state.mappings.splice(index, 1);
        saveMappings();
        renderMappings();
      }),
    );

    tr.append(order, pattern.td, methodTd, schema.td, del);
    tbody.appendChild(tr);
  });
}

function textCell(value, placeholder, onInput) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('input', () => {
    onInput(input.value);
    saveMappingsSoon();
  });
  td.appendChild(input);
  return { td, input };
}

function iconButton(text, title, disabled, onClick) {
  const b = document.createElement('button');
  b.className = 'icon';
  b.textContent = text;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function moveMapping(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.mappings.length) return;
  const [m] = state.mappings.splice(index, 1);
  state.mappings.splice(target, 0, m);
  saveMappings();
  renderMappings();
}

/** "+ Map" on a captured row: new mapping at the top for that URL path + method. */
function addMappingFromEntry(entry) {
  let pattern = entry.url;
  try {
    pattern = new URL(entry.url).pathname;
  } catch {
    /* keep full URL */
  }
  state.mappings.unshift({
    pattern,
    method: entry.method,
    schemaName: sanitizeSchemaName(entry.schemaName) || deriveSchemaName(entry.url, entry.method),
  });
  saveMappings();
  renderMappings();
  $('mappingsSection').open = true;
  $('mappingRows').querySelector('input')?.focus();
}

function initMappings() {
  renderMappings();

  $('addMapping').addEventListener('click', () => {
    state.mappings.push({ pattern: '', method: '', schemaName: '' });
    saveMappings();
    renderMappings();
    const inputs = $('mappingRows').querySelectorAll('tr:last-child input');
    inputs[0]?.focus();
  });

  $('resetMappings').addEventListener('click', () => {
    if (!confirm('Replace all mappings with the defaults from default-mappings.js?')) return;
    state.mappings = cloneDefaults();
    saveMappings();
    renderMappings();
  });

  $('toggleJson').addEventListener('click', () => {
    const editor = $('jsonEditor');
    const opening = editor.classList.contains('hidden');
    editor.classList.toggle('hidden', !opening);
    $('toggleJson').textContent = opening ? 'Close JSON' : 'Edit as JSON';
    if (opening) {
      $('mappingsJson').value = JSON.stringify(state.mappings, null, 2);
      $('jsonError').textContent = '';
    }
  });

  $('applyJson').addEventListener('click', () => {
    try {
      const parsed = JSON.parse($('mappingsJson').value);
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of { pattern, method, schemaName }');
      state.mappings = parsed.map((m, i) => {
        if (!m || typeof m.pattern !== 'string' || typeof m.schemaName !== 'string') {
          throw new Error(`Row ${i}: "pattern" and "schemaName" must be strings`);
        }
        const err = patternError(m.pattern.trim());
        if (err) throw new Error(`Row ${i}: ${err}`);
        return { pattern: m.pattern, method: (m.method || '').toUpperCase(), schemaName: m.schemaName };
      });
      saveMappings();
      renderMappings();
      $('jsonError').textContent = `Applied ${state.mappings.length} mappings.`;
    } catch (err) {
      $('jsonError').textContent = err.message;
    }
  });
}

function applyTheme() {
  const theme = chrome.devtools?.panels?.themeName;
  document.body.classList.toggle('theme-dark', theme === 'dark');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function init() {
  applyTheme();
  await loadState();
  initToolbar();
  initSettings();
  initMappings();
  renderCounters();
  resolveReady();
  testServer();
})();
