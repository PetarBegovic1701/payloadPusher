// Payload Capture panel.
//
// Every finished request in the inspected tab is listed. For each request the
// panel reads the request payload and (for non-static requests) the response
// body. Rows with something to save can be flagged (checkbox) and saved to the
// capture server, one by one or with "Save flagged". The "Save" menu picks
// what is saved: the request payload, the response body, or both. Optional
// matching rules can pre-flag or auto-save requests as they arrive.
//
// Sections:
//   1. Settings & storage
//   2. Filter + naming logic   <- the bits you'll most likely want to tweak
//   3. Body parsing (request payload, response body)
//   4. Capture pipeline (ingest -> parse -> name -> rules -> save)
//   5. Request list UI (view filters, flagging, saving)
//   6. Diagnostics
//   7. Output folder
//   8. Settings + mappings UI

/* global DEFAULT_MAPPINGS, isStaticRequest, requestKey */

// ---------------------------------------------------------------------------
// 1. Settings & storage
// ---------------------------------------------------------------------------

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_ROWS = 5000; // all rows
const MAX_STATIC_ROWS = 300; // of which scripts, images, … (oldest are dropped first)
const MAX_RECENT_DIRS = 8;
const MAX_RAW_BODY = 100 * 1024; // keep at most 100 KB of non-JSON bodies for viewing
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024; // don't load response bodies bigger than this
const RESPONSE_TIMEOUT_MS = 5000;
// A response body is saved as "<schema><suffix>.json", e.g. createUser_response.json.
const RESPONSE_SUFFIX = '_response';

const KINDS = ['request', 'response'];
const KIND_LABELS = { request: 'request', response: 'response' };

const DEFAULT_SETTINGS = {
  captureEnabled: true,
  serverUrl: 'http://127.0.0.1:4545',
  outputDir: '', // '' = server's default (--output-dir)
  recentOutputDirs: [],
  saveMode: 'request', // 'request' | 'response' | 'both'
  // Matching rules: what to do with a request that matches them.
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
  events: [], // every request Chrome delivered and what the panel did with it (for diagnostics)
  errors: [], // uncaught errors in the panel (for diagnostics)
};

const MAX_EVENTS = 500;
const MAX_ERRORS = 50;

function recordError(where, err) {
  state.errors.push({ at: new Date().toISOString(), where, message: String((err && err.stack) || err).slice(0, 600) });
  if (state.errors.length > MAX_ERRORS) state.errors.shift();
}
window.addEventListener('error', (e) => recordError('window.onerror', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => recordError('unhandledrejection', e.reason));

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
  if (v.jsonOnly && savableKinds(entry).length === 0) return false;
  if (v.method && entry.method !== v.method) return false;
  const search = v.search.trim();
  if (search && !safeMatch(search, entry.url) && !safeMatch(search, entry.schemaName)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 3. Body parsing
// ---------------------------------------------------------------------------
//
// Each body becomes { has, json, note, raw, converted }:
//   has        true when there is JSON to save
//   json       the parsed value
//   note       why there is nothing to save (shown in the row)
//   raw        the original text when it is not JSON (for the { } viewer)
//   converted  'form' when a form body was turned into a JSON object

const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

function noBody(note) {
  return { has: false, json: undefined, note, raw: '', converted: '' };
}

function clip(text) {
  return text.length > MAX_RAW_BODY ? text.slice(0, MAX_RAW_BODY) + '\n… (truncated)' : text;
}

/**
 * Parse JSON leniently: ignores a byte-order mark and the ")]}'" anti-JSON-
 * hijacking prefix some backends put in front of responses.
 */
function parseJson(text) {
  const cleaned = text.replace(/^﻿/, '').replace(/^\)\]\}',?\s*/, '');
  return JSON.parse(cleaned);
}

/** Form fields -> { name: value }, repeated names -> arrays, files -> a stub. */
function paramsToObject(params) {
  const out = {};
  for (const p of params) {
    const value = p.fileName !== undefined ? { fileName: p.fileName, contentType: p.contentType || '' } : p.value ?? '';
    if (Object.prototype.hasOwnProperty.call(out, p.name)) {
      out[p.name] = [].concat(out[p.name], value);
    } else {
      out[p.name] = value;
    }
  }
  return out;
}

/** The request payload, from the HAR entry's request.postData. */
function parseRequestBody(har) {
  const method = (har.request.method || '').toUpperCase();
  const postData = har.request.postData;

  if (!postData) {
    if (!BODY_METHODS.includes(method)) return noBody('');
    if (har.request.bodySize > 0) {
      return noBody(`Chrome did not record the body (${har.request.bodySize} bytes were sent)`);
    }
    return noBody('No request body. Empty, or sent as a stream, which Chrome does not record');
  }

  const mime = (postData.mimeType || '').toLowerCase();
  const text = postData.text;
  const isForm = mime.includes('application/x-www-form-urlencoded') || mime.includes('multipart/form-data');

  if (typeof text === 'string' && text.trim() !== '' && !isForm) {
    try {
      return { has: true, json: parseJson(text), note: '', raw: '', converted: '' };
    } catch {
      return { ...noBody(`Body is not JSON (${postData.mimeType || 'unknown type'})`), raw: clip(text) };
    }
  }

  if (isForm) {
    let fields = null;
    if (Array.isArray(postData.params) && postData.params.length) {
      fields = paramsToObject(postData.params);
    } else if (typeof text === 'string' && mime.includes('urlencoded')) {
      fields = paramsToObject([...new URLSearchParams(text)].map(([name, value]) => ({ name, value })));
    }
    if (fields) return { has: true, json: fields, note: '', raw: clip(text || ''), converted: 'form' };
    return { ...noBody(`Form body that could not be read (${postData.mimeType})`), raw: clip(text || '') };
  }

  return noBody('Empty request body');
}

function getContent(har) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ content: null, encoding: '', timedOut: true }), RESPONSE_TIMEOUT_MS);
    try {
      har.getContent((content, encoding) => {
        clearTimeout(timer);
        resolve({ content, encoding });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ content: null, encoding: '', error: err.message });
    }
  });
}

/** The response body. Uses content.text when the HAR has it, else getContent(). */
async function loadResponseBody(har) {
  const res = har.response || {};
  const info = res.content || {};
  const mime = info.mimeType || 'unknown type';
  if (!res.status) return noBody('No response (request failed or was cancelled)');
  if (res.status === 204 || res.status === 304) return noBody(`No response body (${res.status})`);
  if (info.size > MAX_RESPONSE_BYTES) return noBody(`Response too large to load (${Math.round(info.size / 1048576)} MB)`);

  let content = info.text;
  let encoding = info.encoding || '';
  if (content === undefined) {
    if (typeof har.getContent !== 'function') return noBody('Response body not available from Chrome');
    const result = await getContent(har);
    if (result.timedOut) return noBody('Chrome did not return the response body in time');
    content = result.content;
    encoding = result.encoding;
  }
  if (content === null || content === undefined) {
    return noBody('Response body no longer available in DevTools (reload the page with DevTools open)');
  }

  if (encoding === 'base64') {
    if (!/json|text|javascript/i.test(mime)) return noBody(`Binary response (${mime})`);
    try {
      content = new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
    } catch {
      return noBody(`Binary response (${mime})`);
    }
  }
  if (content.trim() === '') return noBody('Empty response body');
  try {
    return { has: true, json: parseJson(content), note: '', raw: '', converted: '' };
  } catch {
    return { ...noBody(`Response is not JSON (${mime})`), raw: clip(content) };
  }
}

// ---------------------------------------------------------------------------
// 4. Capture pipeline
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
 *
 * Never fails silently: every request is logged in state.events with what
 * happened to it, and if reading it throws, a row with the error is shown.
 */
async function ingest(har, options = {}) {
  await ready;
  const ctx = { entry: null };
  let outcome;
  try {
    outcome = await ingestRequest(har, options, ctx);
  } catch (err) {
    outcome = `error: ${err && err.message}`;
    recordError('ingest', err);
    showIngestError(har, err, ctx);
  }
  logEvent(har, options.backfill ? 'sync' : 'live', outcome);
  return outcome === 'added';
}

function logEvent(har, source, outcome) {
  const req = (har && har.request) || {};
  state.events.push({
    at: new Date().toISOString(),
    source,
    method: req.method,
    chromeType: har && har._resourceType,
    status: har && har.response ? har.response.status : undefined,
    url: redactUrl(String(req.url || '')),
    hasPostData: Boolean(req.postData),
    outcome,
  });
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

/** Something threw while reading a request: show it as a row instead of dropping it. */
function showIngestError(har, err, ctx) {
  const message = `Error while reading this request: ${err && err.message}. Use "Copy diagnostics".`;
  if (ctx.entry) {
    // The row exists; show the error on it.
    ctx.entry.request = noBody(message);
    ctx.entry.response = noBody('');
    updateRow(ctx.entry);
    return;
  }
  try {
    const req = (har && har.request) || {};
    const timestamp = (har && har.startedDateTime) || new Date().toISOString();
    addEntry({
      id: nextId++,
      timestamp,
      time: Date.parse(timestamp) || Date.now(),
      isStatic: false,
      method: String(req.method || '?').toUpperCase(),
      url: String(req.url || '(unknown URL)'),
      resourceType: (har && har._resourceType) || '',
      responseStatus: har && har.response ? har.response.status : 0,
      request: noBody(message),
      response: noBody(''),
      schemaName: '',
      schemaSource: '',
      flagged: false,
      saves: { request: { status: '', detail: '' }, response: { status: '', detail: '' } },
      diag: { error: String(err && err.message) },
    });
  } catch (err2) {
    recordError('showIngestError', err2);
  }
}

/** Returns what happened: 'added', 'duplicate', 'record off' or 'skipped: …'. */
async function ingestRequest(har, options, ctx) {
  if (!state.settings.captureEnabled && !options.backfill) return 'record off';

  const url = har.request.url;
  if (/^(data|blob|chrome-extension):/.test(url)) return 'skipped: data/blob/extension URL';
  const key = requestKey(har);
  if (state.seen.has(key)) return 'duplicate';
  state.seen.add(key);
  const method = (har.request.method || '').toUpperCase();
  const timestamp = har.startedDateTime || new Date().toISOString();
  const isStatic = isStaticRequest(har);

  const entry = {
    id: nextId++,
    timestamp,
    time: Date.parse(timestamp) || Date.now(),
    isStatic,
    method,
    url,
    resourceType: har._resourceType || '',
    responseStatus: har.response ? har.response.status : 0,
    request: parseRequestBody(har),
    response: isStatic ? noBody('') : { ...noBody('Loading response…'), loading: true },
    schemaName: '',
    schemaSource: '',
    flagged: false,
    saves: { request: { status: '', detail: '' }, response: { status: '', detail: '' } },
    diag: buildDiagnostics(har, isStatic),
  };

  entry.diag.request.result = entry.request.has ? entry.request.converted || 'json' : entry.request.note;

  const resolved = resolveSchemaName(url, method);
  entry.schemaName = resolved.name;
  entry.schemaSource = resolved.source;

  addEntry(entry);
  ctx.entry = entry;

  if (!isStatic) {
    entry.response = await loadResponseBody(har);
    entry.diag.responseResult = entry.response.has ? 'json' : entry.response.note;
    updateRow(entry);
    if (!state.batching) renderCounters();
  }

  const action = state.settings.ruleAction === 'save' && options.backfill ? 'flag' : state.settings.ruleAction;
  const ruleHit = action !== 'off' && savableKinds(entry).length > 0 && matchesRules(method, url, entry.responseStatus);
  if (ruleHit && action === 'flag') {
    entry.flagged = true;
    updateRow(entry);
    if (!state.batching) renderCounters();
  }
  if (ruleHit && action === 'save') save(entry);
  return 'added';
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

/** Which bodies of this entry the current "Save" setting would save. */
function savableKinds(entry) {
  const mode = state.settings.saveMode;
  const wanted = mode === 'both' ? KINDS : [mode];
  return wanted.filter((kind) => entry[kind].has);
}

function isSending(entry) {
  return KINDS.some((kind) => entry.saves[kind].status === 'sending');
}

/** Save what the "Save" setting asks for. Unflags the row when all of it saved. */
async function save(entry) {
  const kinds = savableKinds(entry);
  if (kinds.length === 0 || isSending(entry)) return;
  let allOk = true;
  for (const kind of kinds) {
    if (!(await saveKind(entry, kind))) allOk = false;
  }
  if (allOk) entry.flagged = false;
  updateRow(entry);
  renderCounters();
}

async function saveKind(entry, kind) {
  const base = sanitizeSchemaName(entry.schemaName);
  if (!base) {
    setSaveStatus(entry, kind, 'failed', 'Schema name is empty');
    return false;
  }
  const schemaName = kind === 'response' ? base + RESPONSE_SUFFIX : base;
  const outputDir = state.settings.outputDir.trim();
  setSaveStatus(entry, kind, 'sending', '');
  const endpoint = serverBase() + '/capture';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaName,
        url: entry.url,
        method: entry.method,
        payload: entry[kind].json,
        timestamp: entry.timestamp,
        outputDir: outputDir || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setSaveStatus(entry, kind, 'saved', body.saved ? `→ ${body.saved}` : '');
      setServerStatus(true);
      rememberOutputDir(outputDir);
      return true;
    }
    setSaveStatus(entry, kind, 'failed', body.error || `HTTP ${res.status}`);
  } catch (err) {
    setSaveStatus(entry, kind, 'failed', `Cannot reach ${endpoint}. Is the capture server running? (${err.message})`);
    setServerStatus(false);
  }
  return false;
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
// 5. Request list UI
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const rowEls = new Map(); // entry.id -> { row, detailRow }

const STATUS_LABELS = { sending: 'saving…', saved: 'saved', failed: 'failed' };

function addEntry(entry) {
  // Keep newest first. Live requests go straight to the top; backfilled
  // ones may belong further down.
  // Build the row first: if that throws, the list stays consistent.
  const els = createRow(entry);
  let index = 0;
  while (index < state.entries.length && state.entries[index].time > entry.time) index++;
  state.entries.splice(index, 0, entry);
  rowEls.set(entry.id, els);

  // Insert before the next older entry that has a row.
  let beforeRow = null;
  for (let i = index + 1; i < state.entries.length && !beforeRow; i++) {
    const other = rowEls.get(state.entries[i].id);
    if (other) beforeRow = other.row;
  }
  $('captureRows').insertBefore(els.row, beforeRow);

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

/** Lines for the "Saved?" cell: one per body the Save setting covers. */
function statusLines(entry) {
  const mode = state.settings.saveMode;
  const kinds = mode === 'both' ? KINDS : [mode];
  const lines = [];
  for (const kind of kinds) {
    const save = entry.saves[kind];
    const body = entry[kind];
    const prefix = kinds.length > 1 ? `${KIND_LABELS[kind]}: ` : '';
    if (save.status) {
      lines.push({ cls: `status-${save.status}`, text: prefix + STATUS_LABELS[save.status], detail: save.detail });
    } else if (body.has) {
      const note = body.converted === 'form' ? 'form fields, saved as JSON' : '';
      lines.push({ cls: 'status-new', text: prefix + 'not saved', detail: note });
    } else if (body.note) {
      lines.push({ cls: body.loading ? 'status-sending' : 'status-none', text: '', detail: prefix + body.note });
    }
  }
  return lines;
}

function updateRow(entry, els = rowEls.get(entry.id)) {
  if (!els) return;
  const { row } = els;
  const savable = savableKinds(entry).length > 0;
  const sending = isSending(entry);
  row.classList.toggle('no-json', !savable);
  row.hidden = !isVisible(entry);
  if (els.detailRow) {
    els.detailRow.hidden = row.hidden;
    renderDetail(entry, els.detailRow);
  }

  const flag = row.querySelector('.flag');
  flag.checked = entry.flagged;
  flag.disabled = !savable || sending;
  flag.title = savable ? 'Flag to save with "Save flagged"' : 'Nothing to save for the current "Save" setting';

  const cell = row.querySelector('.col-status');
  cell.textContent = '';
  for (const line of statusLines(entry)) {
    const div = document.createElement('div');
    if (line.text) {
      const status = document.createElement('span');
      status.className = `status ${line.cls}`;
      status.textContent = line.text;
      div.appendChild(status);
    }
    if (line.detail) {
      const detail = document.createElement('div');
      detail.className = 'status-detail';
      detail.textContent = line.detail;
      detail.title = line.detail;
      div.appendChild(detail);
    }
    cell.appendChild(div);
  }

  const preview = sanitizeSchemaName(entry.schemaName);
  row.querySelector('.schema-source').textContent =
    entry.schemaSource + (preview !== entry.schemaName ? ` · saves as ${preview || '(invalid)'}` : '');

  const sendBtn = row.querySelector('.send-btn');
  sendBtn.disabled = !savable || sending;
  const anyDone = KINDS.some((k) => ['saved', 'failed'].includes(entry.saves[k].status));
  sendBtn.textContent = anyDone ? 'Save again' : 'Save';
}

function setSaveStatus(entry, kind, status, detail) {
  entry.saves[kind] = { status, detail };
  updateRow(entry);
}

/** After a mapping change, rename rows that haven't been saved or hand-edited. */
function reresolveUnsaved() {
  for (const entry of state.entries) {
    if (entry.schemaSource === 'edited') continue;
    if (KINDS.some((k) => ['saved', 'sending'].includes(entry.saves[k].status))) continue;
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
  els.row.after(tr);
  els.detailRow = tr;
  renderDetail(entry, tr);
}

/** The { } viewer: request payload, response body, and diagnostics. */
function renderDetail(entry, tr) {
  tr.textContent = '';
  const td = document.createElement('td');
  td.colSpan = 8;
  const grid = document.createElement('div');
  grid.className = 'detail-grid';

  for (const kind of KINDS) {
    const body = entry[kind];
    const section = document.createElement('section');
    const h = document.createElement('h4');
    h.textContent = kind === 'request' ? 'Request payload' : 'Response body';
    if (body.converted === 'form') h.textContent += ' (form fields as JSON)';
    const pre = document.createElement('pre');
    if (body.has) pre.textContent = JSON.stringify(body.json, null, 2);
    else if (body.raw) pre.textContent = `(${body.note})\n\n${body.raw}`;
    else pre.textContent = `(${body.note || 'none'})`;
    section.append(h, pre);
    grid.appendChild(section);
  }

  const diag = document.createElement('section');
  diag.className = 'diag';
  const h = document.createElement('h4');
  h.textContent = 'Diagnostics (no body contents)';
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => showReport(JSON.stringify(entry.diag, null, 2)));
  h.append(' ', copy);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(entry.diag, null, 2);
  diag.append(h, pre);
  grid.appendChild(diag);

  td.appendChild(grid);
  tr.appendChild(td);
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
    if (KINDS.some((k) => e.saves[k].status === 'saved')) saved++;
    if (KINDS.some((k) => e.saves[k].status === 'failed')) failed++;
    if (visible && savableKinds(e).length > 0 && !isSending(e)) {
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
      if (savableKinds(e).length > 0 && !isSending(e) && isVisible(e)) e.flagged = value;
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
  $('copyDiagnostics').addEventListener('click', async () => {
    try {
      showReport(await buildReport());
    } catch (err) {
      recordError('buildReport', err);
      showReport(`The report failed: ${err && err.stack}\n\nPanel errors:\n${JSON.stringify(state.errors, null, 2)}`);
    }
  });
  $('closeReport').addEventListener('click', () => $('reportDialog').close());
  $('copyReport').addEventListener('click', copyReport);

  const saveMode = $('saveMode');
  saveMode.value = state.settings.saveMode;
  saveMode.addEventListener('change', () => {
    state.settings.saveMode = saveMode.value;
    saveSettings();
    // Flags only make sense for rows that still have something to save.
    for (const e of state.entries) if (savableKinds(e).length === 0) e.flagged = false;
    applyView();
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
// 6. Diagnostics
// ---------------------------------------------------------------------------
//
// Facts about what Chrome handed the extension, without any body contents,
// cookies or auth headers, so they can be pasted into a bug report.

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : undefined;
}

/** URL without query values (keeps the keys), so tokens in URLs are not shared. */
function redactUrl(url) {
  try {
    const u = new URL(url);
    const keys = [...u.searchParams.keys()];
    return u.origin + u.pathname + (keys.length ? '?' + keys.map((k) => `${k}=…`).join('&') : '');
  } catch {
    return url.split('?')[0];
  }
}

/** First non-space character of a body, to tell JSON / form / other apart. */
function firstChar(text) {
  const m = typeof text === 'string' ? text.match(/\S/) : null;
  return m ? m[0] : '';
}

function buildDiagnostics(har, isStatic) {
  const req = har.request || {};
  const res = har.response || {};
  const pd = req.postData;
  return {
    method: req.method,
    url: redactUrl(req.url || ''),
    chromeType: har._resourceType || '(none)',
    isStatic,
    initiator: har._initiator ? har._initiator.type : undefined,
    viaServiceWorker: res._fetchedViaServiceWorker,
    request: {
      contentTypeHeader: header(req.headers, 'content-type'),
      contentEncodingHeader: header(req.headers, 'content-encoding'),
      bodySize: req.bodySize,
      postData: pd
        ? {
            mimeType: pd.mimeType,
            textLength: typeof pd.text === 'string' ? pd.text.length : '(missing)',
            firstChar: firstChar(pd.text),
            paramsCount: Array.isArray(pd.params) ? pd.params.length : undefined,
          }
        : '(missing)',
      result: undefined, // filled in below
    },
    response: {
      status: res.status,
      mimeType: res.content ? res.content.mimeType : undefined,
      size: res.content ? res.content.size : undefined,
      contentTextInHar: res.content ? res.content.text !== undefined : false,
      hasGetContent: typeof har.getContent === 'function',
      error: res._error || undefined,
    },
    responseResult: isStatic ? '(not loaded for static files)' : 'loading',
  };
}

/**
 * What Chrome's own Network log (getHAR) has, next to what the panel has.
 * If a request is in Chrome's log but not in the panel, the panel lost it;
 * if it is not in Chrome's log either, Chrome does not give it to extensions.
 */
async function chromeLogSummary() {
  let log;
  try {
    log = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('getHAR() timed out')), 5000);
      chrome.devtools.network.getHAR((l) => { clearTimeout(timer); resolve(l); });
    });
  } catch (err) {
    return { error: err.message };
  }
  // Non-static requests, plus preflights (they show which calls were cross-origin).
  const entries = ((log && log.entries) || []).filter((e) => !isStaticRequest(e) || e._resourceType === 'preflight');
  return {
    nonStaticEntries: entries.length,
    postPutPatchDelete: entries.filter((e) => BODY_METHODS.includes(e.request.method)).length,
    preflights: entries.filter((e) => e._resourceType === 'preflight').length,
    // Newest 60 of them, and whether the panel has each one.
    newest: entries.slice(-60).reverse().map((e) => ({
      method: e.request.method,
      chromeType: e._resourceType,
      status: e.response && e.response.status,
      url: redactUrl(e.request.url),
      hasPostData: Boolean(e.request.postData),
      inPanel: state.seen.has(requestKey(e)),
    })),
  };
}

async function buildReport() {
  const nonStatic = state.entries.filter((e) => !e.isStatic);
  const bodyMethods = nonStatic.filter((e) => BODY_METHODS.includes(e.method));
  const withRequestJson = bodyMethods.filter((e) => e.request.has).length;
  const report = {
    extensionVersion: chrome.runtime?.getManifest?.().version,
    userAgent: navigator.userAgent,
    inspectedTabId: chrome.devtools?.inspectedWindow?.tabId,
    panelErrors: state.errors,
    chromeNetworkLog: await chromeLogSummary(),
    // The newest 150 requests Chrome delivered to the panel, and what happened to each.
    receivedEvents: state.events.filter((ev) => ev.chromeType !== 'script' && ev.chromeType !== 'image' && ev.chromeType !== 'stylesheet' && ev.chromeType !== 'font').slice(-150).reverse(),
    settings: {
      record: state.settings.captureEnabled,
      saveMode: state.settings.saveMode,
      ruleAction: state.settings.ruleAction,
      ruleMethods: state.settings.ruleMethods,
      ruleOkOnly: state.settings.ruleOkOnly,
      ruleUrlFilterSet: Boolean(state.settings.ruleUrlFilter.trim()),
      view: { ...state.settings.view, search: state.settings.view.search ? '(set)' : '' },
      mappings: state.mappings.length,
    },
    counts: {
      listed: state.entries.length,
      static: state.staticCount,
      droppedByLimit: state.dropped,
      nonStatic: nonStatic.length,
      postPutPatchDelete: bodyMethods.length,
      ofWhichRequestSavable: withRequestJson,
      ofWhichResponseSavable: bodyMethods.filter((e) => e.response.has).length,
      visible: state.entries.filter(isVisible).length,
    },
    // Newest 40 requests that are not static files.
    requests: nonStatic.slice(0, 40).map((e) => ({
      ...e.diag,
      request: { ...(e.diag.request || {}), result: e.request.has ? e.request.converted || 'json' : e.request.note },
      visible: isVisible(e),
      flagged: e.flagged,
      saves: e.saves,
    })),
  };
  return JSON.stringify(report, null, 2);
}

function showReport(text) {
  $('reportText').value = text;
  $('reportStatus').textContent = 'Check the text, then paste it into your message.';
  $('reportDialog').showModal();
  $('reportText').select();
}

async function copyReport() {
  const textarea = $('reportText');
  textarea.select();
  let ok = false;
  try {
    await navigator.clipboard.writeText(textarea.value);
    ok = true;
  } catch {
    // DevTools panels may not get clipboard permission; fall back.
    ok = document.execCommand('copy');
  }
  $('reportStatus').textContent = ok ? 'Copied.' : 'Copy failed: select the text and press Ctrl+C / Cmd+C.';
}

// ---------------------------------------------------------------------------
// 7. Output folder + server status
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
// 8. Settings + mappings UI
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
