# payloadPusher: Network Payload Capture Tool

This tool captures JSON request bodies from Chrome's Network activity and saves them as JSON files on disk. You can then use the files as fixtures for API scripts.

It is for local development only. The server binds to `127.0.0.1` and has no auth.

```
┌──────────────── Chrome DevTools ────────────────┐         ┌──── capture-server ────┐
│ "Payload Capture" panel                          │  POST   │ 127.0.0.1:4545          │
│  onRequestFinished → list every request →        │ ──────▶ │ /capture                │ ──▶ <folder>/<schema>.json
│  you flag the ones to keep → Save flagged        │         │ /health, /config        │
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
2. Open your app (for example `http://localhost:3000`). Open DevTools (F12 or Cmd+Opt+I).
3. Click the **Payload Capture** tab. If you do not see it, look in the `»` overflow menu. The toolbar must show **server: ok**.
4. Optional: in **Save to**, type the folder for the files (refer to [Choosing the output folder](#choosing-the-output-folder)). The line below it shows the full path that the server will write to.
5. Use your app. **Every** request appears in the list, newest at the top.
6. Put a check mark in the box on each request you want to keep. Only requests with a JSON body have a box. By default, successful POST, PUT and PATCH requests get a check mark automatically (refer to [Matching rules](#matching-rules)).
7. Correct the **Schema name** if necessary. This is the file name.
8. Click **Save flagged (N)**. Each row changes to **SAVED** and shows the path it was written to. To save one row immediately, click **Save** on that row (or press Enter in its name field).

The extension starts to record when DevTools opens, not when you click the panel. It keeps requests from before your first click on the panel (up to 1000) and lists them when the panel opens. It does not see requests from before DevTools opened.

### The panel

**Toolbar**

| Control | What it does |
| ------- | ------------ |
| **Record** switch | Pauses and resumes the list. While it is off, new requests are not recorded. |
| **Matching rules** | What happens to JSON requests that match the rules: *do nothing*, *flag them* (default), or *save them immediately*. |
| **Save to** | Output folder for the next saves. The dropdown shows recent folders. ✕ goes back to the server default. |
| **Test server** | Calls `GET /health` and refreshes the "Save to" path. |

**View filters** (these change only what you see; the extension still records everything)

| Control | What it does |
| ------- | ------------ |
| Search box | Filters by URL or schema name. Plain text is a substring match; `re:` is a regex. |
| Method menu | Shows only one method. |
| **Fetch/XHR only** (on by default) | Hides documents, scripts, images, fonts and preflights. This is the same as Chrome's "Fetch/XHR" filter. |
| **JSON body only** | Hides requests that you cannot save. |
| **Save flagged (N)** | Saves all flagged rows, including rows that the filters hide. It saves them oldest first, so history files stay in request order. |
| **Unflag all**, header check box | Clears all flags. The header box flags or unflags every visible row that can be saved. |

**Rows**

| Column | Meaning |
| ------ | ------- |
| Check box | Flags the row for **Save flagged**. It shows only for requests with a JSON body. |
| Code | The HTTP response status. Codes 4xx and 5xx are red. Hover to see Chrome's resource type. |
| Schema name | Editable. The label shows where the name came from: `mapped`, `derived` (from the URL) or `edited`. It also shows `saves as …` if the server will sanitize the name. |
| Saved? | `NOT SAVED`, `SAVED` (with the path), or `FAILED` (with the server or network error). For requests without a JSON body, it shows why. |
| **Save / Save again** | Saves this row now, with the current name and folder. |
| **+ Map** | Adds a mapping row (URL path + method → current name) at the top of the mapping table. |
| **{ }** | Shows the request body. Non-JSON bodies show as raw text. |

### Matching rules

Open **Settings** to change the rules. A request with a JSON body matches when:

- its method is one of the selected methods (default POST, PUT, PATCH), **and**
- its response is 2xx, if **Only successful (2xx) responses** is on (default on), **and**
- its URL matches the **URL filter** (empty means all URLs; plain text is a substring match; `re:` is a regex).

The **Matching rules** menu in the toolbar sets what happens to a match. Set it to *do nothing* to flag everything by hand. Set it to *save them immediately* for fully automatic capture, which is how the first version worked.

### Choosing the output folder

The **Save to** field goes with each save, so you can change the folder at any time. For example, use one folder per scenario.

| You type | Files go to |
| -------- | ----------- |
| *(empty)* | The server default (`--output-dir`, normally `capture-server/payloads`) |
| `checkout-flow` | `<server default>/checkout-flow/` |
| `~/projects/api-script/fixtures` | That folder in your home directory |
| `/Users/me/projects/api-script/fixtures` or `C:\work\fixtures` | That exact folder |

The server makes the folder if it does not exist. The line under the toolbar shows the full resolved path before you save. Folders that saved correctly go into the dropdown list.

A browser extension cannot open a native "choose folder" dialog that gives a path to a server, so you type or paste the path. To change the **default** folder, start the server with `--output-dir` (or set `OUTPUT_DIR`).

Settings, mappings and recent folders are kept in `chrome.storage.local`. They stay after you close DevTools and restart Chrome.

## Using it with an app that runs on your computer

This works. DevTools records requests to `localhost` and `127.0.0.1` in the same way as requests to remote servers. Some points to know:

1. **Only requests that the browser makes are recorded.** If your frontend calls its own backend, and that backend then calls other APIs (server to server), the Network tab does not see those calls. You capture the payloads that the browser sends to your backend. To capture the backend's own outgoing calls, you need a proxy or logging in that backend.
2. **Dev-server proxies.** If your dev server proxies `/api` to a backend (Vite, webpack-dev-server, Next.js rewrites, CRA `proxy`), the browser sees `http://localhost:5173/api/...`, not the backend URL. Write mapping patterns for the URL in the list. Patterns like `/api/v1/users` match on any host and port.
3. **Port conflict.** The capture server uses port **4545**. If your app uses 4545, start the server with `--port 4546` and change *Capture server URL* in Settings.
4. **Do not save into a folder that your dev server watches.** If **Save to** points into your app's source tree, each saved file can start a hot reload and lose page state. Use a folder outside the app, or one the watcher ignores.
5. **Electron, React Native and similar apps.** Chrome DevTools extensions do not load there. The app must run in a normal Chrome or Edge tab.
6. **The capture server's own requests are not in the list.** The extension makes those requests, not the page, so they do not show.

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

## Security note

The server accepts requests only from extension pages (`chrome-extension://…`, or `extension://…` in Edge) and from tools that send no `Origin` header, such as `curl` and Node scripts. It returns `403` to requests from web pages.

This matters because a save request chooses its own output folder. If the server accepted any web page, a site you open could write `.json` files into any folder you can write to. For example, it could overwrite a project's `package.json`.

## Where to change things

| Change                                   | File |
| ---------------------------------------- | ---- |
| Which requests are auto-flagged/saved    | `devtools-extension/panel.js`: `matchesRules()` |
| What the list shows                      | `devtools-extension/panel.js`: `isVisible()` |
| Mapping match rules                      | `devtools-extension/panel.js`: `compilePattern()`, `resolveSchemaName()` |
| Fallback name from the URL               | `devtools-extension/panel.js`: `deriveSchemaName()`, `isIdLike()` |
| Default mapping rows                     | `devtools-extension/default-mappings.js` |
| File names, history and flat behavior    | `capture-server/src/storage.js` |

## Troubleshooting

- **No "Payload Capture" tab**: close and reopen DevTools after you load or reload the extension.
- **Every row FAILED "Cannot reach …"**: the server is not running, or the port in *Capture server URL* is not the server's port.
- **FAILED "Origin not allowed"**: a request came from outside the extension. Refer to the [Security note](#security-note).
- **Requests do not appear**: check that **Record** is on. The counter shows "showing X of Y". If X is less than Y, the view filters hide some rows. Turn off **Fetch/XHR only** to see all resource types.
- **No check box on a row**: the request has no JSON body. It is form data, multipart, plain text, or has no body. Only JSON bodies can be saved.
