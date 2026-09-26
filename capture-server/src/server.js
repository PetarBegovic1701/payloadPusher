#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { loadDotEnv, resolveConfig, USAGE } = require('./config');
const { createApp } = require('./app');

loadDotEnv(path.join(__dirname, '..', '.env'));

let config;
try {
  config = resolveConfig();
} catch (err) {
  console.error(`Error: ${err.message}\n\n${USAGE}`);
  process.exit(1);
}

if (config.help) {
  console.log(USAGE);
  process.exit(0);
}

const app = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`Payload capture server listening on http://${config.host}:${config.port}`);
  console.log(`  output dir : ${config.outputDir}`);
  console.log(`  mode       : ${config.flat ? 'flat (overwrite)' : 'history (keep previous captures)'}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Pick another with --port or PORT=...`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
