'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Make a schema name safe to use as a file/folder name.
 * Anything outside [a-zA-Z0-9_-] becomes "_", runs of "_" are collapsed,
 * and leading/trailing "_" are trimmed. Returns "" if nothing usable is left.
 */
function sanitizeSchemaName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

/**
 * Turn an ISO timestamp into a file-name-safe string that still sorts
 * chronologically, e.g. "2026-09-27T12:00:00.000Z" -> "2026-09-27T12-00-00-000Z".
 * Falls back to "now" when the timestamp is missing or unparseable.
 */
function timestampToFileName(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  return iso.replace(/[:.]/g, '-');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function toJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Persist a payload and return the absolute path of the file written.
 *
 * Flat mode (flat = true):
 *   <outputDir>/<schema>.json is always overwritten.
 *
 * History mode (default):
 *   - First capture for a schema  -> <outputDir>/<schema>.json
 *   - Every later capture         -> <outputDir>/<schema>/<timestamp>.json
 *                                    and <outputDir>/<schema>/latest.json is
 *                                    refreshed with the same content.
 *   The original <schema>.json is left untouched (it's the first capture).
 */
function savePayload(opts) {
  return withSchemaLock(path.join(opts.outputDir, opts.schemaName), () => writePayload(opts));
}

// Captures for the same schema often arrive in parallel (the extension sends
// as soon as each request finishes). Serialize writes per schema so the
// "does a file already exist?" check can't race and lose a capture.
const schemaLocks = new Map();

function withSchemaLock(key, fn) {
  const previous = schemaLocks.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  schemaLocks.set(key, tail);
  tail.then(() => {
    if (schemaLocks.get(key) === tail) schemaLocks.delete(key);
  });
  return run;
}

async function writePayload({ outputDir, schemaName, payload, timestamp, flat }) {
  await fs.mkdir(outputDir, { recursive: true });

  const flatFile = path.join(outputDir, `${schemaName}.json`);
  const historyDir = path.join(outputDir, schemaName);
  const content = toJson(payload);

  const hasHistory = !flat && ((await exists(flatFile)) || (await exists(historyDir)));
  if (!hasHistory) {
    await fs.writeFile(flatFile, content, 'utf8');
    return flatFile;
  }

  await fs.mkdir(historyDir, { recursive: true });

  // Avoid clobbering if two captures share the same millisecond.
  const base = timestampToFileName(timestamp);
  let file = path.join(historyDir, `${base}.json`);
  for (let n = 1; await exists(file); n++) {
    file = path.join(historyDir, `${base}_${n}.json`);
  }

  await fs.writeFile(file, content, 'utf8');
  await fs.writeFile(path.join(historyDir, 'latest.json'), content, 'utf8');
  return file;
}

module.exports = { sanitizeSchemaName, timestampToFileName, savePayload };
