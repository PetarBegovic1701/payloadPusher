'use strict';

const path = require('node:path');
const express = require('express');
const { sanitizeSchemaName, resolveOutputDir, savePayload, exists } = require('./storage');

// Browsers attach an Origin header to cross-origin requests. Only the
// extension (chrome-extension://…, or extension://… in Edge) and non-browser tools like curl (no Origin)
// may use the server. Without this, any web page you visit could POST here
// and, because the output folder is chosen per request, write JSON files
// anywhere your user account can write.
function isAllowedOrigin(origin) {
  return !origin || origin.startsWith('chrome-extension://') || origin.startsWith('extension://');
}

/**
 * Build the Express app. Kept separate from server.js so it can be tested
 * without binding a port.
 *
 * @param {{ outputDir: string, flat: boolean, log?: (msg: string) => void }} config
 */
function createApp(config) {
  const log = config.log ?? ((msg) => console.log(msg));
  const app = express();

  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (!isAllowedOrigin(origin)) {
      log(`[capture] Rejected ${req.method} ${req.path} from origin ${origin}`);
      return res.status(403).json({ error: `Origin not allowed: ${origin}` });
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '25mb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Lets the panel show where a folder setting will actually write to.
  // GET /config?outputDir=<dir>
  app.get('/config', async (req, res) => {
    const requested = typeof req.query.outputDir === 'string' ? req.query.outputDir : '';
    const resolved = resolveOutputDir(config.outputDir, requested);
    res.json({
      defaultOutputDir: config.outputDir,
      outputDir: resolved,
      exists: await exists(resolved),
      flat: config.flat,
    });
  });

  app.post('/capture', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object (is Content-Type application/json?)' });
    }

    const { schemaName, url, method, payload, timestamp, outputDir } = body;

    if (typeof schemaName !== 'string' || schemaName.trim() === '') {
      return res.status(400).json({ error: 'Missing or empty "schemaName" (string)' });
    }
    const safeName = sanitizeSchemaName(schemaName);
    if (!safeName) {
      return res.status(400).json({ error: `"schemaName" has no usable characters after sanitizing: ${JSON.stringify(schemaName)}` });
    }
    if (payload === undefined) {
      return res.status(400).json({ error: 'Missing "payload"' });
    }
    if (outputDir !== undefined && outputDir !== null && typeof outputDir !== 'string') {
      return res.status(400).json({ error: '"outputDir" must be a string' });
    }

    let saved;
    try {
      saved = await savePayload({
        outputDir: resolveOutputDir(config.outputDir, outputDir),
        schemaName: safeName,
        payload,
        timestamp,
        flat: config.flat,
      });
    } catch (err) {
      log(`[capture] ERROR writing ${safeName}: ${err.message}`);
      return res.status(500).json({ error: `Failed to write payload: ${err.message}` });
    }

    // Show a short relative path when the file is under the cwd, else absolute.
    const relative = path.relative(process.cwd(), saved);
    const rel = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : saved;
    log(`[capture] ${String(method ?? '?').toUpperCase()} ${url ?? '(no url)'} -> ${rel}`);
    res.json({ saved: rel });
  });

  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // Final error handler: malformed JSON, oversized bodies, anything unexpected.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: `Malformed JSON body: ${err.message}` });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    const status = err.status || err.statusCode || 500;
    log(`[capture] ERROR ${status}: ${err.message}`);
    res.status(status).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
