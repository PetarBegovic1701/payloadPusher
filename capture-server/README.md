# Capture server

A small Express server that receives payloads from the **Payload Capture** DevTools panel and writes them to disk as pretty-printed JSON files.

It listens on `127.0.0.1` only. It has no auth, because it is meant only for your own machine.

## Run

```bash
cd capture-server
npm install
npm start                       # http://127.0.0.1:4545, writes to ./payloads
npm start -- --port 5000        # other port
npm start -- --output-dir ../fixtures
npm start -- --flat             # always overwrite <schema>.json (no history)
npm run start:flat              # same as above
npm test                        # unit + HTTP tests (node:test, no extra deps)
```

## Configuration

Precedence: CLI flag > environment variable / `.env` > default.

| CLI flag             | Env var      | Default      | Meaning                                           |
| -------------------- | ------------ | ------------ | ------------------------------------------------- |
| `--port <n>`         | `PORT`       | `4545`       | Port to listen on                                 |
| `--output-dir <dir>` | `OUTPUT_DIR` | `./payloads` | Where files go (relative to where you run `npm`)  |
| `--flat`             | `FLAT=true`  | off          | Overwrite mode instead of history mode            |

To use a `.env` file, copy `.env.example` to `.env` in this folder. The server loads it with Node's built-in `process.loadEnvFile`, so you do not need `dotenv`. This needs Node 20.12 or later.

## Endpoints

### `GET /health`

```json
{ "status": "ok" }
```

### `POST /capture`

```json
{
  "schemaName": "createUser",
  "url": "https://api.example.com/v1/users",
  "method": "POST",
  "payload": { "name": "Ada" },
  "timestamp": "2026-09-27T12:00:00.000Z"
}
```

`schemaName` and `payload` are required. `url` and `method` are used only for the console log. `timestamp` sets the history file name. If you leave it out, the server uses the current time.

Response: `200 { "saved": "payloads/createUser.json" }`

| Status | When                                                             |
| ------ | ---------------------------------------------------------------- |
| 400    | Malformed JSON, body not an object, missing/empty `schemaName`, missing `payload` |
| 413    | Body larger than 25 MB                                           |
| 500    | The file could not be written (permissions, disk full, …)        |

Errors always come back as `{ "error": "<message>" }`. The server does not crash.

## File layout

The server sanitizes `schemaName` first. Every character outside `[a-zA-Z0-9_-]` becomes `_`. For example, `../v1 users` becomes `v1_users`.

**History mode (default):**

```
payloads/
  createUser.json                        <- first capture ever for this schema
  createUser/
    2026-09-27T12-00-05-123Z.json        <- every later capture
    2026-09-27T12-03-44-001Z.json
    latest.json                          <- copy of the most recent capture
```

- The first capture of a schema goes to `<schema>.json`.
- When `<schema>.json` or `<schema>/` already exists, the capture goes to `<schema>/<timestamp>.json`, and `<schema>/latest.json` is refreshed. The server does not change `<schema>.json` after that.
- The timestamp has `:` and `.` replaced by `-`, so the name is valid on Windows and still sorts by time. If two captures have the same timestamp, the second one gets a `_1` suffix.
- The server writes one schema at a time, so parallel captures of the same schema do not overwrite each other.

**Flat mode (`--flat`):** the server always overwrites `<schema>.json`. It does not make folders.

## Where to change things

- `src/storage.js`: schema-name sanitizing, file naming, history and flat logic.
- `src/app.js`: routes, validation, error responses.
- `src/config.js`: CLI and env parsing.
