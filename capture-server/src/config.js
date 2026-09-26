'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PORT = 4545;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OUTPUT_DIR = './payloads';

const USAGE = `Usage: npm start -- [options]

Options:
  --port <n>          Port to listen on           (env PORT, default ${DEFAULT_PORT})
  --output-dir <dir>  Directory for payload files (env OUTPUT_DIR, default ${DEFAULT_OUTPUT_DIR})
  --flat              Always overwrite <schema>.json, no history (env FLAT=true)
  -h, --help          Show this help
`;

/**
 * Load a .env file (if present) into process.env. Uses Node's built-in
 * loader, so no dotenv dependency. Existing env vars win over .env values.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  } else {
    console.warn(`[config] Found ${file} but this Node version cannot load it (need >= 20.12). Ignoring.`);
  }
}

/**
 * Minimal CLI parser. Supports "--key value", "--key=value" and bare "--flat".
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (key === 'flat') {
      args.flat = eq === -1 ? true : parseBool(arg.slice(eq + 1));
      continue;
    }
    if (key !== 'port' && key !== 'output-dir') {
      throw new Error(`Unknown option: --${key}`);
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') {
      throw new Error(`Option --${key} needs a value`);
    }
    args[key] = value;
  }
  return args;
}

function parseBool(value) {
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * Resolve the final config. Precedence: CLI args > environment / .env > defaults.
 */
function resolveConfig(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);

  const port = Number(args.port ?? env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${args.port ?? env.PORT}`);
  }

  return {
    help: Boolean(args.help),
    host: DEFAULT_HOST,
    port,
    outputDir: path.resolve(args['output-dir'] ?? env.OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR),
    flat: args.flat ?? (env.FLAT !== undefined ? parseBool(env.FLAT) : false),
  };
}

module.exports = { loadDotEnv, parseArgs, resolveConfig, USAGE };
