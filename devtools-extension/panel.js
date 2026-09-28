// Payload Capture panel.
//
// Every finished request in the inspected tab is listed. Requests with a JSON
// body can be flagged (checkbox) and saved to the capture server, either one
// by one or with "Save flagged". Optional matching rules can pre-flag or
// auto-save requests as they arrive.
//
// Sections:
//   1. Settings & storage
//   2. Filter + naming logic   <- the bits you'll most likely want to tweak
//   3. Capture pipeline (ingest -> parse -> name -> rules -> save)
//   4. Request list UI (view filters, flagging, saving)
//   5. Output folder
//   6. Settings + mappings UI

/* global DEFAULT_MAPPINGS, isStaticRequest, requestKey */

// ---------------------------------------------------------------------------
// 1. Settings & storage
// ---------------------------------------------------------------------------

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_ROWS = 5000; // all rows
const MAX_STATIC_ROWS = 300; // of which scripts, images, … (oldest are dropped first)
const MAX_RECENT_DIRS = 8;
const MAX_RAW_BODY = 100 * 1024; // keep at most 100 KB of non-JSON bodies for viewing

const DEFAULT_SETTINGS = {
  captureEnabled: true,
  serverUrl: 'http://127.0.0.1:4545',
  outputDir: '', // '' = server's default (--output-dir)
  recentOutputDirs: [],
  // Matching rules: what to do with a JSON request that matches them.
  ruleAction: 'flag', // 'off' | 'flag' | 'save'
  ruleMethods: ['POST', 'PUT', 'PATCH'],
  ruleUrlFilter: '',
  ruleOkOnly: true, // only match requests whose response was 2xx
  // What the list shows. Does not affect what is recorded.
  view: { search: '', method: '', hideStatic: true, jsonOnly: false },
};

const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  mappings: [],
  entries: [], // newest first
  seen: new Set(), // requestKey() of everything listed, to skip duplicates
  staticCount: 0,
  dropped: 0, // non-static rows removed because of MAX_ROWS
  batching: false,
};

async function loadState() {
  const stored = await chrome.storage.local.get(['settings', 'mappings']);
  const saved = stored.settings || {};
  // Settings from the first version used methods/urlFilter/autoSend.
  if (saved.methods && !saved.ruleMethods) saved.ruleMethods = saved.methods;
  if (saved.urlFilter !== undefined && saved.ruleUrlFilter === undefined) saved.ruleUrlFilter = saved.urlFilter;
  delete saved.methods;
  delete saved.urlFilter;
  delete saved.autoSend;
  if (saved.view) delete saved.view.apiOnly; // replaced by hideStatic
  state.settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    view: { ...DEFAULT_SETTINGS.view, ...(saved.view || {}) },
  };

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
  reresolveUnsaved();
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
 * Compile a user pattern into a predicate over strings.
 *   "re:<expr>" -> case-insensitive RegExp
 *   anything else -> case-insensitive substring
 * Throws on an invalid regex so the UI can flag it.
 */
function compilePattern(pattern) {
  if (pattern.startsWith('re:')) {
    const re = new RegExp(pattern.slice(3), 'i');
    return (s) => re.test(s);
  }
  const needle = pattern.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

function safeMatch(pattern, s) {
  try {
    return compilePattern(pattern)(s);
  } catch {
    return false;
  }
}

/** Does this request match the matching rules (Settings -> Matching rules)? */
function matchesRules(method, url, responseStatus) {
  const { ruleMethods, ruleUrlFilter, ruleOkOnly } = state.settings;
  if (!ruleMethods.includes(method)) return false;
  if (ruleOkOnly && !(responseStatus >= 200 && responseStatus < 300)) return false;
  if (ruleUrlFilter.trim() && !safeMatch(ruleUrlFilter.trim(), url)) return false;
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

/** List view filter. Only changes what is shown, never what is recorded. */
function isVisible(entry) {
  const v = state.settings.view;
  if (v.hideStatic && entry.isStatic) return false;
  if (v.jsonOnly && !entry.hasJson) return false;
  if (v.method && entry.method !== v.method) return false;
  const search = v.search.trim();
  if (search && !safeMatch(search, entry.url) && !safeMatch(search, entry.schemaName)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 3. Capture pipeline
// ---------------------------------------------------------------------------

let nextId = 1;
let resolveReady;
const ready = new Promise((r) => (resolveReady = r));

/**
 * Entry point for every finished network request (a HAR entry). Called by
 * devtools.js for live requests, and by backfill() for the Network tab's log.
 *
 * options.backfill: the request is from the Network tab's log, not live. It
 *   ignores the Record switch, and "save them immediately" only flags it, so
 *   a sync never saves a pile of old requests by surprise.
 * Returns true if a row was added.
 */
async function ingest(har, options = {}) {
  await ready;
  if (!state.settings.captureEnabled && !options.backfill) return false;

  const url = har.request.url;
  if (/^(data|blob|chrome-extension):/.test(url)) return false;
  const key = requestKey(har);
  if (state.seen.has(key)) return false;
  state.seen.add(key);
  const method = (har.request.method || '').toUpperCase();
  const timestamp = har.startedDateTime || new Date().toISOString();

  const entry = {
    id: nextId++,
    timestamp,
    time: Date.parse(timestamp) || Date.now(),
    isStatic: isStaticRequest(har),
    method,
    url,
    resourceType: har._resourceType || '',
    responseStatus: har.response ? har.response.status : 0,
    hasJson: false,
    payload: undefined,
    rawBody: '',
    schemaName: '',
    schemaSource: '',
    flagged: false,
    status: 'nobody', // 'nobody' | 'new' | 'sending' | 'saved' | 'failed'
    detail: '',
  };

  const postData = har.request.postData;
  const text = postData && postData.text;
  if (!text) {
    entry.detail = 'No request body';
  } else {
    try {
      entry.payload = JSON.parse(text);
      entry.hasJson = true;
      entry.status = 'new';
    } catch {
      entry.rawBody = text.length > MAX_RAW_BODY ? text.slice(0, MAX_RAW_BODY) + '\n… (truncated)' : text;
      entry.detail = `Body is not JSON (${(postData && postData.mimeType) || 'unknown type'})`;
    }
  }

  const resolved = resolveSchemaName(url, method);
  entry.schemaName = resolved.name;
  entry.schemaSource = resolved.source;

  const action = state.settings.ruleAction === 'save' && options.backfill ? 'flag' : state.settings.ruleAction;
  const ruleHit = entry.hasJson && action !== 'off' && matchesRules(method, url, entry.responseStatus);
  if (ruleHit && action === 'flag') entry.flagged = true;

  addEntry(entry);

  if (ruleHit && action === 'save') save(entry);
  return true;
}

/** Add every request the Network tab has that the list doesn't. */
async function backfill() {
  const log = await new Promise((resolve) => chrome.devtools.network.getHAR(resolve));
  const entries = (log && log.entries) || [];
  let added = 0;
  state.batching = true; // skip per-row counter updates; one render at the end
  try {
    for (const har of entries) {
      if (await ingest(har, { backfill: true })) added++;
    }
  } finally {
    state.batching = false;
    renderCounters();
  }
  return added;
}

async function save(entry) {
  if (!entry.hasJson || entry.status === 'sending') return;
  const schemaName = sanitizeSchemaName(entry.schemaName);
  if (!schemaName) {
    setStatus(entry, 'failed', 'Schema name is empty');
    return;
  }

  const outputDir = state.settings.outputDir.trim();
  setStatus(entry, 'sending', '');
  const endpoint = serverBase() + '/capture';
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
        outputDir: outputDir || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      entry.flagged = false;
      setStatus(entry, 'saved', body.saved ? `→ ${body.saved}` : '');
      setServerStatus(true);
      rememberOutputDir(outputDir);
    } else {
      setStatus(entry, 'failed', body.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    setStatus(entry, 'failed', `Cannot reach ${endpoint}. Is the capture server running? (${err.message})`);
    setServerStatus(false);
  }
}

/** Oldest first and one at a time, so history files keep the request order. */
async function saveFlagged() {
  const flagged = state.entries.filter((e) => e.flagged).reverse();
  for (const entry of flagged) {
    await save(entry);
  }
}

// Exposed for devtools.js.
window.payloadCapture = { ingest };

// ---------------------------------------------------------------------------
// 4. Request list UI
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const rowEls = new Map(); // entry.id -> { row, detailRow }

const STATUS_LABELS = {
  nobody: '',
  new: 'not saved',
  sending: 'saving…',
  saved: 'saved',
  failed: 'failed',
};

function addEntry(entry) {
  // Keep newest first. Live requests go straight to the top; backfilled
  // ones may belong further down.
  let index = 0;
  while (index < state.entries.length && state.entries[index].time > entry.time) index++;
  const before = state.entries[index];
  state.entries.splice(index, 0, entry);

  const els = createRow(entry);
  rowEls.set(entry.id, els);
  const tbody = $('captureRows');
  tbody.insertBefore(els.row, before ? rowEls.get(before.id).row : null);

  if (entry.isStatic) state.staticCount++;
  // Static files have their own small budget so they can't push API calls out.
  if (state.staticCount > MAX_STATIC_ROWS) {
    evict(state.entries.findLastIndex((e) => e.isStatic));
  }
  while (state.entries.length > MAX_ROWS) {
    const last = state.entries[state.entries.length - 1];
    if (!last.isStatic) state.dropped++;
    evict(state.entries.length - 1);
  }
  if (!state.batching) renderCounters();
}

function evict(index) {
  const [old] = state.entries.splice(index, 1);
  if (old.isStatic) state.staticCount--;
  removeRow(old.id);
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

  row.classList.toggle('no-json', !entry.hasJson);

  const flag = row.querySelector('.flag');
  flag.addEventListener('change', () => {
    entry.flagged = flag.checked;
    renderCounters();
  });

  row.querySelector('.col-time').textContent = formatTime(entry.timestamp);
  row.querySelector('.col-time').title = entry.timestamp;
  const methodCell = row.querySelector('.col-method');
  methodCell.textContent = entry.method;
  methodCell.classList.add(`method-${entry.method.toLowerCase()}`);
  const code = row.querySelector('.col-code');
  code.textContent = entry.responseStatus || '';
  code.classList.toggle('code-error', entry.responseStatus >= 400 || entry.responseStatus === 0);
  code.title = entry.resourceType ? `Chrome type: ${entry.resourceType}` : '';
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
    if (e.key === 'Enter') save(entry);
  });

  row.querySelector('.send-btn').addEventListener('click', () => save(entry));
  row.querySelector('.map-btn').addEventListener('click', () => addMappingFromEntry(entry));
  row.querySelector('.view-btn').addEventListener('click', () => toggleDetail(entry, els));

  updateRow(entry, els);
  return els;
}

function updateRow(entry, els = rowEls.get(entry.id)) {
  if (!els) return;
  const { row } = els;
  row.dataset.status = entry.status;
  row.hidden = !isVisible(entry);
  if (els.detailRow) els.detailRow.hidden = row.hidden;

  const flag = row.querySelector('.flag');
  flag.checked = entry.flagged;
  flag.disabled = !entry.hasJson || entry.status === 'sending';
  flag.title = entry.hasJson ? 'Flag to save with "Save flagged"' : 'Only requests with a JSON body can be saved';

  const status = row.querySelector('.status');
  status.textContent = STATUS_LABELS[entry.status];
  status.className = `status status-${entry.status}`;
  const detail = row.querySelector('.status-detail');
  detail.textContent = entry.detail;
  detail.title = entry.detail;

  const preview = sanitizeSchemaName(entry.schemaName);
  row.querySelector('.schema-source').textContent =
    entry.schemaSource + (preview !== entry.schemaName ? ` · saves as ${preview || '(invalid)'}` : '');

  const sendBtn = row.querySelector('.send-btn');
  sendBtn.disabled = !entry.hasJson || entry.status === 'sending';
  sendBtn.textContent = entry.status === 'saved' || entry.status === 'failed' ? 'Save again' : 'Save';
  row.querySelector('.view-btn').disabled = !entry.hasJson && !entry.rawBody;
}

function setStatus(entry, status, detail) {
  entry.status = status;
  entry.detail = detail;
  updateRow(entry);
  renderCounters();
}

/** After a mapping change, rename rows that haven't been saved or hand-edited. */
function reresolveUnsaved() {
  for (const entry of state.entries) {
    if (entry.schemaSource === 'edited' || entry.status === 'saved' || entry.status === 'sending') continue;
    const resolved = resolveSchemaName(entry.url, entry.method);
    entry.schemaName = resolved.name;
    entry.schemaSource = resolved.source;
    const els = rowEls.get(entry.id);
    if (els) els.row.querySelector('.schema-input').value = entry.schemaName;
    updateRow(entry);
  }
}

function applyView() {
  for (const entry of state.entries) updateRow(entry);
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
  td.colSpan = 8;
  const pre = document.createElement('pre');
  pre.textContent = entry.hasJson ? JSON.stringify(entry.payload, null, 2) : entry.rawBody;
  td.appendChild(pre);
  tr.appendChild(td);
  els.row.after(tr);
  els.detailRow = tr;
}

function renderCounters() {
  let shown = 0;
  let flagged = 0;
  let saved = 0;
  let failed = 0;
  let visibleSavable = 0;
  let visibleFlagged = 0;
  for (const e of state.entries) {
    const visible = isVisible(e);
    if (visible) shown++;
    if (e.flagged) flagged++;
    if (e.status === 'saved') saved++;
    if (e.status === 'failed') failed++;
    if (visible && e.hasJson && e.status !== 'sending') {
      visibleSavable++;
      if (e.flagged) visibleFlagged++;
    }
  }
  $('counters').textContent =
    `showing ${shown} of ${state.entries.length} · ${saved} saved` +
    (failed ? ` · ${failed} failed` : '') +
    (state.dropped ? ` · ${state.dropped} oldest dropped (limit ${MAX_ROWS})` : '');
  $('saveFlagged').textContent = `Save flagged (${flagged})`;
  $('saveFlagged').disabled = flagged === 0;
  $('unflagAll').disabled = flagged === 0;

  const all = $('flagAll');
  all.disabled = visibleSavable === 0;
  all.checked = visibleSavable > 0 && visibleFlagged === visibleSavable;
  all.indeterminate = visibleFlagged > 0 && visibleFlagged < visibleSavable;

  $('emptyHint').classList.toggle('hidden', shown > 0);
  $('emptyHint').textContent =
    state.entries.length === 0
      ? 'No requests yet. Use the inspected page and its requests appear here. ' +
        'Requests made before DevTools was opened are not visible: reload the page with DevTools open.'
      : `${state.entries.length} request(s) hidden by the view filters above.`;
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function initList() {
  $('saveFlagged').addEventListener('click', saveFlagged);
  $('unflagAll').addEventListener('click', () => {
    for (const e of state.entries) e.flagged = false;
    applyView();
  });
  $('flagAll').addEventListener('change', () => {
    const value = $('flagAll').checked;
    for (const e of state.entries) {
      if (e.hasJson && e.status !== 'sending' && isVisible(e)) e.flagged = value;
    }
    applyView();
  });
  $('clearList').addEventListener('click', () => {
    for (const e of state.entries) removeRow(e.id);
    state.entries = [];
    state.seen.clear();
    state.staticCount = 0;
    state.dropped = 0;
    renderCounters();
  });
  $('syncNetwork').addEventListener('click', async () => {
    const button = $('syncNetwork');
    button.disabled = true;
    const added = await backfill();
    button.disabled = false;
    button.textContent = `Sync from Network tab (+${added})`;
    setTimeout(() => (button.textContent = 'Sync from Network tab'), 2500);
  });

  // View filters.
  const v = state.settings.view;
  const search = $('viewSearch');
  search.value = v.search;
  search.addEventListener('input', () => {
    v.search = search.value;
    search.classList.toggle('invalid', Boolean(patternError(search.value.trim())));
    saveSettings();
    applyView();
  });

  const methodSelect = $('viewMethod');
  for (const m of ['', ...ALL_METHODS]) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m || 'All methods';
    methodSelect.appendChild(o);
  }
  methodSelect.value = v.method;
  methodSelect.addEventListener('change', () => {
    v.method = methodSelect.value;
    saveSettings();
    applyView();
  });

  for (const [id, key] of [['viewHideStatic', 'hideStatic'], ['viewJsonOnly', 'jsonOnly']]) {
    const cb = $(id);
    cb.checked = v[key];
    cb.addEventListener('change', () => {
      v[key] = cb.checked;
      saveSettings();
      applyView();
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Output folder + server status
// ---------------------------------------------------------------------------

function serverBase() {
  return state.settings.serverUrl.replace(/\/+$/, '');
}

function setServerStatus(ok, text) {
  const el = $('serverStatus');
  el.className = `server-status ${ok ? 'ok' : 'down'}`;
  el.textContent = text || (ok ? 'server: ok' : 'server: unreachable');
}

async function testServer() {
  const el = $('serverStatus');
  el.className = 'server-status unknown';
  el.textContent = 'server: checking…';
  try {
    const res = await fetch(serverBase() + '/health');
    const body = await res.json();
    setServerStatus(res.ok && body.status === 'ok');
  } catch (err) {
    setServerStatus(false, `server: unreachable (${err.message})`);
  }
  checkOutputDir();
}

/** Ask the server where the folder setting resolves to, and show it. */
async function checkOutputDir() {
  const hint = $('outputDirHint');
  const dir = state.settings.outputDir.trim();
  try {
    const res = await fetch(`${serverBase()}/config?outputDir=${encodeURIComponent(dir)}`);
    const body = await res.json();
    $('outputDir').placeholder = `server default: ${body.defaultOutputDir}`;
    hint.textContent = `→ ${body.outputDir}${body.exists ? '' : ' (new folder, created on first save)'}`;
    hint.title = body.flat ? 'Server runs in --flat mode: files are overwritten' : 'History mode: earlier captures are kept';
    hint.className = 'dir-hint';
  } catch {
    hint.textContent = 'Start the server to see where files will go';
    hint.className = 'dir-hint muted';
  }
}

function rememberOutputDir(dir) {
  if (!dir) return;
  const recent = state.settings.recentOutputDirs.filter((d) => d !== dir);
  recent.unshift(dir);
  state.settings.recentOutputDirs = recent.slice(0, MAX_RECENT_DIRS);
  saveSettings();
  renderRecentDirs();
}

function renderRecentDirs() {
  const list = $('recentDirs');
  list.textContent = '';
  for (const dir of state.settings.recentOutputDirs) {
    const o = document.createElement('option');
    o.value = dir;
    list.appendChild(o);
  }
}

function initOutputDir() {
  const input = $('outputDir');
  input.value = state.settings.outputDir;
  renderRecentDirs();
  let timer = null;
  input.addEventListener('input', () => {
    state.settings.outputDir = input.value;
    saveSettings();
    clearTimeout(timer);
    timer = setTimeout(checkOutputDir, 300);
  });
  $('resetOutputDir').addEventListener('click', () => {
    input.value = '';
    state.settings.outputDir = '';
    saveSettings();
    checkOutputDir();
  });
}

// ---------------------------------------------------------------------------
// 6. Settings + mappings UI
// ---------------------------------------------------------------------------

function initToolbar() {
  const capture = $('captureEnabled');
  capture.checked = state.settings.captureEnabled;
  capture.addEventListener('change', () => {
    state.settings.captureEnabled = capture.checked;
    saveSettings();
  });

  const action = $('ruleAction');
  action.value = state.settings.ruleAction;
  action.addEventListener('change', () => {
    state.settings.ruleAction = action.value;
    saveSettings();
  });

  $('testServer').addEventListener('click', testServer);
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

  const methodBox = $('ruleMethods');
  for (const method of ALL_METHODS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = method;
    cb.checked = state.settings.ruleMethods.includes(method);
    cb.addEventListener('change', () => {
      state.settings.ruleMethods = [...methodBox.querySelectorAll('input:checked')].map((c) => c.value);
      saveSettings();
    });
    label.append(cb, ' ', method);
    methodBox.appendChild(label);
  }

  const okOnly = $('ruleOkOnly');
  okOnly.checked = state.settings.ruleOkOnly;
  okOnly.addEventListener('change', () => {
    state.settings.ruleOkOnly = okOnly.checked;
    saveSettings();
  });

  const urlFilter = $('ruleUrlFilter');
  urlFilter.value = state.settings.ruleUrlFilter;
  const validate = () => {
    const err = patternError(urlFilter.value.trim());
    $('ruleUrlFilterError').textContent = err;
    $('ruleUrlFilterError').classList.toggle('hidden', !err);
    urlFilter.classList.toggle('invalid', Boolean(err));
  };
  urlFilter.addEventListener('input', () => {
    state.settings.ruleUrlFilter = urlFilter.value;
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

/** "+ Map" on a row: new mapping at the top for that URL path + method. */
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
  initOutputDir();
  initList();
  initSettings();
  initMappings();
  renderCounters();
  resolveReady();
  // Pick up what the Network tab recorded before this panel was first opened.
  backfill();
  testServer();
})();
