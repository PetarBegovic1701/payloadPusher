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
5. The tool is **not** in the Extensions (puzzle-piece) menu. Open DevTools on your app's tab (F12) and click the **Payload Capture** tab. The toolbar button only shows these instructions.

When you edit the extension code, click the reload icon on the extension card. Then close and reopen DevTools.

## 3. From "open DevTools" to "JSON file on disk"

1. Start the server (step 1).
2. Open your app (for example `http://localhost:3000`). Open DevTools (F12 or Cmd+Opt+I).
3. Click the **Payload Capture** tab. If you do not see it, look in the `»` overflow menu. The toolbar must show **server: ok**.
4. Optional: in **Save to**, type the folder for the files (refer to [Choosing the output folder](#choosing-the-output-folder)). The line below it shows the full path that the server will write to.
5. Use your app. **Every** request appears in the list, newest at the top.
6. In the **Save** menu, select what to save: the **request payload** (what the frontend sent, the default), the **response body** (what the backend returned), or **both**.
7. Put a check mark in the box on each request you want to keep. Only rows with something to save for the **Save** setting have a box. By default, successful POST, PUT and PATCH requests get a check mark automatically (refer to [Matching rules](#matching-rules)).
8. Correct the **Schema name** if necessary. This is the file name.
9. Click **Save flagged (N)**. Each row changes to **SAVED** and shows the path it was written to. To save one row immediately, click **Save** on that row (or press Enter in its name field).

The extension starts to record when DevTools opens, not when you click the panel. When the panel opens, it also reads everything that the Network tab has already recorded. It does not see requests from before DevTools opened, so open DevTools first and then reload the page.

The list keeps up to 5000 requests. Static files (scripts, styles, images and similar) have a separate limit of 300 and are dropped first. This is so that a dev server that loads hundreds of source files per page cannot push API calls out of the list.

### The panel

**Toolbar**

| Control | What it does |
| ------- | ------------ |
| **Record** switch | Pauses and resumes the list. While it is off, new requests are not recorded. |
| **Save** | What is written to disk: *request payload* (default), *response body*, or *both*. Refer to [Request payload and response body](#request-payload-and-response-body). |
| **Matching rules** | What happens to requests that match the rules: *do nothing*, *flag them* (default), or *save them immediately*. |
| **Save to** | Output folder for the next saves. The dropdown shows recent folders. ✕ goes back to the server default. |
| **Test server** | Calls `GET /health` and refreshes the "Save to" path. |

**View filters** (these change only what you see; the extension still records everything)

| Control | What it does |
| ------- | ------------ |
| Search box | Filters by URL or schema name. Plain text is a substring match; `re:` is a regex. |
| Method menu | Shows only one method. |
| **Hide static files** (on by default) | Hides scripts, styles, images, fonts, media, preflights and page loads. It shows all other types, for example `fetch`, `xhr`, `ping` (`sendBeacon`), `eventsource` and `other`. A form POST is not hidden. Hover over the **Code** cell to see Chrome's type. |
| **Savable only** | Hides rows that have nothing to save for the current **Save** setting. |
| **Save flagged (N)** | Saves all flagged rows, including rows that the filters hide. It saves them oldest first, so history files stay in request order. |
| **Unflag all**, header check box | Clears all flags. The header box flags or unflags every visible row that can be saved. |
| **Copy diagnostics** | Opens a report about what Chrome gave the extension for the newest 40 requests. Refer to [Help to find a problem](#help-to-find-a-problem). |
| **Sync from Network tab** | Adds each request from the Network tab's log that the list does not have yet, and skips duplicates. It adds requests even when **Record** is off. If the matching rules are set to *save them immediately*, a sync only flags the requests. |

**Rows**

| Column | Meaning |
| ------ | ------- |
| Check box | Flags the row for **Save flagged**. It shows only for rows with something to save for the **Save** setting. |
| Code | The HTTP response status. Codes 4xx and 5xx are red. Hover to see Chrome's resource type. |
| Schema name | Editable. The label shows where the name came from: `mapped`, `derived` (from the URL) or `edited`. It also shows `saves as …` if the server will sanitize the name. |
| Saved? | `NOT SAVED`, `SAVED` (with the path), or `FAILED` (with the server or network error). With **Save: both**, there is one line for the request and one for the response. If there is nothing to save, it shows why, for example "Body is not JSON (text/xml)". |
| **Save / Save again** | Saves this row now, with the current name and folder. |
| **+ Map** | Adds a mapping row (URL path + method → current name) at the top of the mapping table. |
| **{ }** | Shows the request payload, the response body and the diagnostics for this request. Non-JSON bodies show as raw text. |

### Matching rules

Open **Settings** to change the rules. A request with something to save (for the **Save** setting) matches when:

- its method is one of the selected methods (default POST, PUT, PATCH), **and**
- its response is 2xx, if **Only successful (2xx) responses** is on (default on), **and**
- its URL matches the **URL filter** (empty means all URLs; plain text is a substring match; `re:` is a regex).

The **Matching rules** menu in the toolbar sets what happens to a match. Set it to *do nothing* to flag everything by hand. Set it to *save them immediately* for fully automatic capture, which is how the first version worked.

### Request payload and response body

- The **request payload** is the body that the frontend sent (Chrome's "Payload" tab). It is saved as `<schema>.json`.
- The **response body** is what the backend returned (Chrome's "Response" tab). It is saved as `<schema>_response.json`, next to the request payload. History mode works the same for both. To change the suffix, edit `RESPONSE_SUFFIX` in `panel.js`.

What can be saved:

| Body | Result |
| ---- | ------ |
| JSON, with any `Content-Type` (also `text/plain`, `sendBeacon`, `keepalive`, `Blob`, typed arrays, XHR) | Saved as is. |
| Form data (`application/x-www-form-urlencoded` or `multipart/form-data`) | Saved as a JSON object of the fields, for example `{ "name": "Ada", "age": "36" }`. A repeated field becomes an array. A file field becomes `{ "fileName": "…", "contentType": "…" }`, without the file content. |
| A response with the `)]}'` prefix or a byte-order mark | The prefix is removed, then the JSON is saved. |
| A body sent as a stream (`fetch` with a `ReadableStream` body) | Cannot be saved. Chrome does not record streamed bodies. |
| XML, GraphQL over `multipart` with files, protobuf, other binary data | Cannot be saved. The row shows the type. |
| A response that DevTools no longer has in memory | Cannot be saved. Reload the page with DevTools open and do the action again. |

The panel does not load response bodies of static files (scripts, images and similar).

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

## Page capture (fetch and Axios from inside the page)

The panel has two sources of requests:

1. **DevTools**: what Chrome's Network tab gives to extensions. This is the default source, and it covers all request types.
2. **Page capture**: a small script (`page-hook.js`) that runs inside your app's page. It wraps `fetch()` and `XMLHttpRequest`, which Axios uses. It copies each request body when your code sends it, and copies the response body when it arrives. It does not change what your app sends or receives.

Page capture exists because on some machines Chrome does not give every request to extensions. A typical symptom is that the preflight (`OPTIONS`, 204) of a cross-origin call is in the list, but the `POST` itself is not. Page capture does not depend on DevTools, so it records such a `POST` anyway.

- Page capture is on by default. To turn it off, open **Settings** and clear **Page capture**.
- It works for apps that run on `localhost` or `127.0.0.1`, over `http` or `https`, on any port. It records calls to any API, for example a deployed service on another domain.
- After you install or update the extension, **reload your app's page**. Chrome adds the script only when a page loads.
- Rows from page capture have a **page** mark next to the method. When both sources see the same request, the list keeps only the first copy.
- Page capture copies bodies up to 5 MB. It copies response bodies only for text and JSON. It cannot copy a body that the app sends as a stream (`ReadableStream`).
- To use page capture on another host, for example `http://myapp.test:3000`, add the host to both `content_scripts` entries in `manifest.json` (for example `"http://myapp.test/*"`) and reload the extension.

## Manifest notes

- `manifest.json` uses the `storage` permission. `chrome.devtools.network` needs no host permissions to read the inspected page's requests.
- The two `content_scripts` entries are for page capture: `page-hook.js` runs in the page's own JavaScript world (`"world": "MAIN"`, which needs Chrome 111 or later), and `page-bridge.js` sends its results to the panel.
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
| What counts as a static file             | `devtools-extension/request-types.js`: `isStaticRequest()` |
| Mapping match rules                      | `devtools-extension/panel.js`: `compilePattern()`, `resolveSchemaName()` |
| Fallback name from the URL               | `devtools-extension/panel.js`: `deriveSchemaName()`, `isIdLike()` |
| How request and response bodies are read | `devtools-extension/panel.js`: `parseRequestBody()`, `loadResponseBody()` |
| Page capture (fetch/XHR inside the page) | `devtools-extension/page-hook.js`; hosts in `manifest.json` → `content_scripts` |
| File name suffix for response bodies     | `devtools-extension/panel.js`: `RESPONSE_SUFFIX` |
| Default mapping rows                     | `devtools-extension/default-mappings.js` |
| File names, history and flat behavior    | `capture-server/src/storage.js` |

## Help to find a problem

If a request is missing, or its payload or response cannot be saved, send a diagnostics report to the maintainer:

1. Reproduce the problem with DevTools open: do the action in your app again.
2. In the Payload Capture panel, click **Copy diagnostics**. For one request only, click **{ }** on its row and then **Copy** next to "Diagnostics".
3. Read the text. It contains **no** request or response bodies, cookies or auth headers. URL query values are replaced with `…`. Paths and host names stay in the report. Remove any that you do not want to share.
4. Paste the text into your message. Add:
   - the method and path of the request that has the problem,
   - what Chrome's own Network tab shows for it: open the request, then the **Payload** tab (is there a payload? "Request Payload" or "Form Data"?), and the **Headers** tab (`Content-Type` of the request),
   - which library the frontend uses for the call, if you know it (fetch, axios, Apollo, a generated client, and so on).

Useful fields in the report:

| Field | Meaning |
| ----- | ------- |
| `extensionVersion` | The version that runs. If it is not the newest, reload the extension in `chrome://extensions` and reopen DevTools. |
| `chromeNetworkLog.newest` | The newest requests in Chrome's own log for this tab (`getHAR()`), with `inPanel` for each. A request with `inPanel: false` was lost by the panel. A request that is not in this list at all is not given to extensions by Chrome. |
| `receivedEvents` | Every request that Chrome delivered to the panel, and what the panel did with it: `added`, `duplicate`, `record off`, or `error: …`. |
| `panelErrors` | Errors in the panel. A request that causes an error still gets a row, which shows the error. |
| `request.postData` | What Chrome gave the extension. `"(missing)"` means Chrome recorded no body. |
| `request.postData.firstChar` | The first character of the body: `{` or `[` is JSON, a letter is often form data. |
| `request.result` | `json`, `form`, or why the payload cannot be saved. |
| `response.hasGetContent`, `responseResult` | Whether Chrome could give the response body, and the result. |
| `chromeType`, `viaServiceWorker` | Chrome's resource type, and whether a service worker handled the request. |
| `visible`, `flagged`, `saves` | What the panel did with the row. |

## Missing API calls

If a call from your frontend to your backend is not in the list, do these checks in this order:

1. **Is the call in Chrome's own Network tab?**
   - **No, it is not.** The extension cannot see it either. Usually DevTools was opened after the call. Keep DevTools open and reload the page, or repeat the action. Also make sure that DevTools is open on the correct tab. A popup window or a new tab (for example, a login flow) has its own DevTools.
   - **Yes, it is.** Make sure that [page capture](#page-capture-fetch-and-axios-from-inside-the-page) is on, reload your app's page, and do the action again. If the call is still missing, click **Sync from Network tab**. If the call then appears, something removed it from the list before. Send a report (refer to [Help to find a problem](#help-to-find-a-problem)), because this should not happen.
2. **Does the counter show "showing X of Y" with X less than Y?** The view filters hide some rows. Clear the search box, set the method menu to *All methods*, and turn off **Savable only** and **Hide static files**.
3. **Is Record on?** While it is off, new requests are not recorded. **Sync from Network tab** still adds them.
4. **Does the frontend call the backend through WebSockets** (Socket.IO, GraphQL subscriptions and similar)? WebSocket messages are not HTTP requests, so they are not captured. Only the first connection request shows.
5. **Does the backend make the call, not the browser?** The browser cannot see server-to-server calls. Refer to [Using it with an app that runs on your computer](#using-it-with-an-app-that-runs-on-your-computer).
6. **Does a service worker handle the call** (Mock Service Worker, Workbox, a PWA)? Chrome records the page's request. A request that the service worker itself sends to the backend can be missing from the page's log.

## Troubleshooting

- **No "Payload Capture" tab**: close and reopen DevTools after you load or reload the extension.
- **The extension's toolbar button does nothing useful**: this is correct. The extension works inside DevTools. The toolbar button only opens a short help popup, which also shows whether the capture server runs.
- **Every row FAILED "Cannot reach …"**: the server is not running, or the port in *Capture server URL* is not the server's port.
- **FAILED "Origin not allowed"**: a request came from outside the extension. Refer to the [Security note](#security-note).
- **Requests do not appear**: refer to [Missing API calls](#missing-api-calls).
- **No check box on a row**: there is nothing to save for the current **Save** setting. The **Saved?** column shows why. Refer to [Request payload and response body](#request-payload-and-response-body).
