'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { sanitizeSchemaName } = require('../src/storage');
const { resolveConfig } = require('../src/config');

async function startServer(opts) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'payloads-'));
  const app = createApp({ outputDir, flat: false, log: () => {}, ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { outputDir, base, close: () => new Promise((r) => server.close(r)) };
}

function post(base, body, raw = false, headers = {}) {
  return fetch(`${base}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw ? body : JSON.stringify(body),
  });
}

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));

test('sanitizeSchemaName', () => {
  assert.equal(sanitizeSchemaName('createUser'), 'createUser');
  assert.equal(sanitizeSchemaName('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeSchemaName('v1/users create'), 'v1_users_create');
  assert.equal(sanitizeSchemaName('///'), '');
});

test('resolveConfig precedence', () => {
  const c = resolveConfig(['--port', '5000', '--flat'], { PORT: '1234', OUTPUT_DIR: 'x' });
  assert.equal(c.port, 5000);
  assert.equal(c.flat, true);
  assert.equal(c.outputDir, path.resolve('x'));
  assert.throws(() => resolveConfig(['--bogus'], {}));
  assert.throws(() => resolveConfig(['--port', 'abc'], {}));
});

test('GET /health', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('history mode keeps previous captures', async (t) => {
  const s = await startServer();
  t.after(s.close);

  const first = { schemaName: 'createUser', url: 'https://x/v1/users', method: 'POST', payload: { n: 1 }, timestamp: '2026-09-27T12:00:00.000Z' };
  let res = await post(s.base, first);
  assert.equal(res.status, 200);
  assert.match((await res.json()).saved, /createUser\.json$/);
  assert.deepEqual(await readJson(path.join(s.outputDir, 'createUser.json')), { n: 1 });

  res = await post(s.base, { ...first, payload: { n: 2 }, timestamp: '2026-09-27T12:00:01.000Z' });
  assert.equal(res.status, 200);
  assert.match((await res.json()).saved, /createUser[\\/]2026-09-27T12-00-01-000Z\.json$/);

  // Same timestamp again must not clobber the previous history file.
  res = await post(s.base, { ...first, payload: { n: 3 }, timestamp: '2026-09-27T12:00:01.000Z' });
  assert.match((await res.json()).saved, /2026-09-27T12-00-01-000Z_1\.json$/);

  assert.deepEqual(await readJson(path.join(s.outputDir, 'createUser.json')), { n: 1 });
  assert.deepEqual(await readJson(path.join(s.outputDir, 'createUser', 'latest.json')), { n: 3 });
  const raw = await fs.readFile(path.join(s.outputDir, 'createUser.json'), 'utf8');
  assert.equal(raw, '{\n  "n": 1\n}\n');
});

test('parallel captures of one schema are all kept', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const ts = '2026-09-27T12:00:00.000Z';
  const results = await Promise.all(
    [1, 2, 3, 4].map((n) => post(s.base, { schemaName: 'p', payload: { n }, timestamp: ts }).then((r) => r.json())),
  );
  assert.equal(new Set(results.map((r) => r.saved)).size, 4);
  const history = await fs.readdir(path.join(s.outputDir, 'p'));
  assert.equal(history.length, 4); // 3 timestamped + latest.json
});

test('flat mode overwrites', async (t) => {
  const s = await startServer({ flat: true });
  t.after(s.close);
  await post(s.base, { schemaName: 'a', payload: { n: 1 } });
  await post(s.base, { schemaName: 'a', payload: { n: 2 } });
  assert.deepEqual(await readJson(path.join(s.outputDir, 'a.json')), { n: 2 });
  await assert.rejects(fs.access(path.join(s.outputDir, 'a')));
});

test('validation errors', async (t) => {
  const s = await startServer();
  t.after(s.close);

  let res = await post(s.base, '{not json', true);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Malformed JSON/);

  res = await post(s.base, { payload: {} });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /schemaName/);

  res = await post(s.base, { schemaName: '!!!', payload: {} });
  assert.equal(res.status, 400);

  res = await post(s.base, { schemaName: 'x' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /payload/);
});

test('write failure returns 500 without crashing', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'payloads-'));
  const blocker = path.join(dir, 'file');
  await fs.writeFile(blocker, 'x');
  // outputDir is "inside" a regular file, so mkdir fails.
  const s = await startServer({ outputDir: path.join(blocker, 'sub') });
  t.after(s.close);

  const res = await post(s.base, { schemaName: 'x', payload: {} });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Failed to write/);

  const health = await fetch(`${s.base}/health`);
  assert.equal(health.status, 200);
});

test('outputDir per request: relative, absolute, home', async (t) => {
  const s = await startServer();
  t.after(s.close);

  let res = await post(s.base, { schemaName: 'rel', payload: { a: 1 }, outputDir: 'sub/dir' });
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(path.join(s.outputDir, 'sub', 'dir', 'rel.json')), { a: 1 });

  const abs = await fs.mkdtemp(path.join(os.tmpdir(), 'abs-'));
  res = await post(s.base, { schemaName: 'abs', payload: { b: 2 }, outputDir: abs });
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(path.join(abs, 'abs.json')), { b: 2 });

  res = await post(s.base, { schemaName: 'x', payload: {}, outputDir: 42 });
  assert.equal(res.status, 400);

  const { resolveOutputDir } = require('../src/storage');
  assert.equal(resolveOutputDir('/base', ''), '/base');
  assert.equal(resolveOutputDir('/base', '~/fx'), path.join(os.homedir(), 'fx'));
});

test('GET /config resolves folders', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/config?outputDir=${encodeURIComponent('nested')}`);
  const body = await res.json();
  assert.equal(body.defaultOutputDir, s.outputDir);
  assert.equal(body.outputDir, path.join(s.outputDir, 'nested'));
  assert.equal(body.exists, false);
});

test('rejects web-page origins, allows extension origins', async (t) => {
  const s = await startServer();
  t.after(s.close);

  let res = await post(s.base, { schemaName: 'x', payload: {} }, false, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  res = await post(s.base, { schemaName: 'x', payload: {} }, false, { Origin: 'http://localhost:3000' });
  assert.equal(res.status, 403);

  res = await post(s.base, { schemaName: 'x', payload: {} }, false, { Origin: 'chrome-extension://abcdef' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'chrome-extension://abcdef');

  const pre = await fetch(`${s.base}/capture`, { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdef' } });
  assert.equal(pre.status, 204);
});
