# payloadPusher: Network Payload Capture Tool

This tool captures JSON request bodies from Chrome's Network activity and saves them as JSON files on disk. You can then use the files as fixtures for API scripts.

It is for local development only. The server binds to `127.0.0.1` and has no auth.

```
┌──────────────── Chrome DevTools ────────────────┐         ┌──── capture-server ────┐
│ "Payload Capture" panel                          │  POST   │ 127.0.0.1:4545          │
│  onRequestFinished → filter → parse JSON →       │ ──────▶ │ /capture                │ ──▶ payloads/<schema>.json
│  resolve schema name (mapping table / URL)       │         │ /health                 │
└──────────────────────────────────────────────────┘         └─────────────────────────┘
```

| Folder                                    | What                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| [`capture-server/`](capture-server/)      | Express server that writes the files ([details](capture-server/README.md)) |
| [`devtools-extension/`](devtools-extension/) | Unpacked Manifest V3 extension that adds the DevTools panel |

## 1. Start the capture server

You need Node 20.12 or later.

```bash
cd capture-server
npm install
npm start
# Payload capture server listening on http://127.0.0.1:4545
```

Check that it runs: `curl http://127.0.0.1:4545/health` returns `{"status":"ok"}`.

Options: `--port`, `--output-dir`, `--flat` (or `PORT`, `OUTPUT_DIR`, `FLAT` in `.env`). Refer to [capture-server/README.md](capture-server/README.md).

## 2. Load the extension in Chrome (or Edge)

1. Open `chrome://extensions` (in Edge, `edge://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `devtools-extension/` folder.
4. If DevTools is already open on a tab, close it and open it again. Chrome adds panels only when DevTools opens.

When you edit the extension code, click the reload icon on the extension card. Then close and reopen DevTools.

## 3. From "open DevTools" to "JSON file on disk"

1. Start the server (step 1).
2. Open the page that calls your API. Open DevTools (F12 or Cmd+Opt+I).
3. Click the **Payload Capture** tab. If you do not see it, look in the `»` overflow menu. The toolbar must show **server: ok**. If it shows **unreachable**, check the server and the *Capture server URL* setting.
4. Make sure **Capture** is on. The default method filter is POST, PUT and PATCH.
5. In the page, do the action that sends the request (submit a form, save, and so on).
6. The request appears at the top of the list with status **SENT** and the path it was written to, for example `→ payloads/createUser.json`.
7. Open `capture-server/payloads/createUser.json`. It contains the pretty-printed request body.

The extension starts to listen when DevTools opens, not when you click the panel. It keeps requests from before your first click on the panel (up to 500) and processes them when the panel opens. It does not see requests from before DevTools opened.

### The panel

| Area | What it does |
| ---- | ------------ |
| **Capture** switch | Pauses and resumes capture. The setting is kept. |
| **Auto-send** switch | On: each matching request goes to the server immediately. Off: rows wait as **PENDING** so you can fix the schema name first. Then click **Send** (or press Enter in the name field), or **Send pending** for all rows. |
| **Test server** | Calls `GET /health` on the configured server. |
| Row: **Schema name** | Editable. The small label shows where the name came from: `mapped`, `derived` (from the URL) or `edited`. It also shows `saves as …` if the server will sanitize the name. |
| Row: **Send / Resend** | Sends the payload again with the current name. Use this to correct a name after a send. |
| Row: **+ Map** | Adds a mapping row (URL path + method → current name) at the top of the mapping table. |
| Row: **{ }** | Shows the parsed payload. |
| Status | `SENT` (with the saved path), `FAILED` (with the server or network error), `SKIPPED` (no body, or the body is not JSON), `PENDING`. |

Requests that do not match the method or URL filters are not listed. The counter shows how many were ignored.

### Settings

- **Capture server URL**: default `http://127.0.0.1:4545`. If you start the server with `--port 5000`, set this to `http://127.0.0.1:5000`.
- **Methods**: POST, PUT, PATCH, DELETE, GET. A GET usually has no body, so it shows as SKIPPED.
- **URL filter**: empty means all URLs. Plain text is a case-insensitive substring match, for example `/api/`. Use the `re:` prefix for a case-insensitive regex, for example `re:/v\d+/(users|orders)`.

All settings and mappings are kept in `chrome.storage.local`. They stay after you close DevTools and restart Chrome.

## 4. The mapping table (URL pattern → schema name)

The mapping table sets the file name for each request.

- The panel checks the rows **from top to bottom** against the **full request URL**. The **first match wins**. Use ▲/▼ to change the order, and put specific patterns above broad ones.
- **Pattern**: plain text is a substring match. `re:<regex>` is a regular expression. Both are case-insensitive.
- **Method**: select a method, or `any`.
- **Schema name**: becomes `payloads/<schemaName>.json`.

The table starts with these example rows, from [`devtools-extension/default-mappings.js`](devtools-extension/default-mappings.js):

| Pattern                  | Method | Schema name  |
| ------------------------ | ------ | ------------ |
| `re:/v1/users/[^/?]+$`   | PATCH  | `updateUser` |
| `/v1/users`              | POST   | `createUser` |
| `/v1/orders`             | any    | `createOrder`|

**If no row matches**, the panel makes a name from the method and the URL path. Segments that look like IDs (numbers, UUIDs, long hex strings, long tokens) become `id`:

```
POST  https://api.example.com/v1/users            → post_v1_users
PATCH https://api.example.com/v1/users/42         → patch_v1_users_id
PUT   https://x/api/things/507f1f77bcf86cd799439011/meta?x=1 → put_api_things_id_meta
```

When you change the mappings, rows that are not sent yet (and that you did not rename by hand) get the new name.

### Adding your own schemas

You can add them in three ways:

- **One at a time**: click **+ Add row**, or click **+ Map** on a captured request.
- **All at once**: click **Edit as JSON**, paste an array, and click **Apply JSON**:

  ```json
  [
    { "pattern": "re:/v1/users/[^/?]+$", "method": "PATCH", "schemaName": "updateUser" },
    { "pattern": "/v1/users",            "method": "POST",  "schemaName": "createUser" },
    { "pattern": "/v1/orders",           "method": "",      "schemaName": "createOrder" }
  ]
  ```

  In JSON, write a regex backslash as `\\`. For example, `"re:/v\\d+/users"`.
- **As new defaults**: edit `default-mappings.js`, reload the extension, and click **Reset to defaults**. The file is read only on first run and on reset.

## Manifest notes

- `manifest.json` uses only the `storage` permission. `chrome.devtools.network` needs no host permissions to read the inspected page's requests.
- `host_permissions` has only `http://127.0.0.1/*` and `http://localhost/*`, which the panel needs for its `fetch()` to the server. These Chrome match patterns have no port, so they **match any port**. If you change the server port, you do not need to edit the manifest. You change only the URL in the panel settings. (JSON does not allow comments, so this note is here and not in `manifest.json`.)
- If the server runs on a different host, add that origin to `host_permissions` and reload the extension.

## Where to change things

| Change                                   | File |
| ---------------------------------------- | ---- |
| Which requests are captured              | `devtools-extension/panel.js`: `passesFilters()` |
| Mapping match rules                      | `devtools-extension/panel.js`: `compilePattern()`, `resolveSchemaName()` |
| Fallback name from the URL               | `devtools-extension/panel.js`: `deriveSchemaName()`, `isIdLike()` |
| Default mapping rows                     | `devtools-extension/default-mappings.js` |
| File names, history and flat behavior    | `capture-server/src/storage.js` |

## Troubleshooting

- **No "Payload Capture" tab**: close and reopen DevTools after you load or reload the extension.
- **Every row FAILED "Cannot reach …"**: the server is not running, or the port in *Capture server URL* is not the server's port.
- **Requests do not appear**: check that **Capture** is on and look at the method and URL filters. The "ignored by filters" counter goes up when a filter drops a request.
- **SKIPPED "not valid JSON"**: the body is form data, multipart or plain text. Only JSON bodies are captured.
