// Page capture: runs inside the app's page (the page's own JavaScript world)
// and records every fetch() and XMLHttpRequest (what Axios uses): the request
// body as the app passed it, and the response body. This works even when
// DevTools does not hand a request to extensions.
//
// Nothing here changes what the app sends or receives: the original fetch/XHR
// run unchanged, bodies are read from clones, and every error is swallowed.
// Results go to page-bridge.js with window.postMessage.

(() => {
  if (window.__payloadCaptureHook) return;
  window.__payloadCaptureHook = true;

  const TAG = 'payload-capture-hook';
  const MAX_BODY = 5 * 1024 * 1024; // don't copy bodies bigger than 5 MB
  const TEXT_TYPES = /json|text\/|javascript|xml|x-www-form-urlencoded/i;

  const post = (data) => {
    try {
      window.postMessage({ source: TAG, data }, '*');
    } catch {
      /* ignore */
    }
  };

  const absolute = (url) => {
    try {
      return new URL(String(url), location.href).href;
    } catch {
      return String(url);
    }
  };

  /** Any fetch/XHR body -> { text, params, mimeType } or { note }. */
  async function readBody(body, contentType) {
    if (body === undefined || body === null) return null;
    try {
      if (typeof body === 'string') {
        return { text: body.slice(0, MAX_BODY), mimeType: contentType || 'text/plain;charset=UTF-8' };
      }
      if (body instanceof URLSearchParams) {
        return { text: body.toString(), mimeType: contentType || 'application/x-www-form-urlencoded;charset=UTF-8' };
      }
      if (body instanceof FormData) {
        const params = [];
        for (const [name, value] of body.entries()) {
          params.push(typeof value === 'string' ? { name, value } : { name, fileName: value.name, contentType: value.type });
        }
        return { text: '', params, mimeType: 'multipart/form-data' };
      }
      if (body instanceof Blob) {
        if (body.size > MAX_BODY) return { note: `Body is a ${body.size}-byte Blob (too large to copy)` };
        return { text: await body.text(), mimeType: contentType || body.type };
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        if (body.byteLength > MAX_BODY) return { note: `Body is ${body.byteLength} bytes (too large to copy)` };
        return { text: new TextDecoder().decode(body), mimeType: contentType || '' };
      }
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
        return { note: 'Body is a stream; it cannot be copied without breaking the request' };
      }
      if (typeof Document !== 'undefined' && body instanceof Document) {
        return { text: new XMLSerializer().serializeToString(body), mimeType: contentType || 'application/xml' };
      }
      return { text: String(body), mimeType: contentType || '' };
    } catch (err) {
      return { note: `Could not read the body: ${err && err.message}` };
    }
  }

  function headerValue(headers, name) {
    if (!headers) return undefined;
    try {
      if (headers instanceof Headers) return headers.get(name) || undefined;
      if (Array.isArray(headers)) {
        const pair = headers.find(([k]) => String(k).toLowerCase() === name);
        return pair ? pair[1] : undefined;
      }
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
      return key ? headers[key] : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Copy a fetch response body, but only for text/JSON of a sane size: other
   * responses (downloads, streams, server-sent events) are left untouched.
   * Must be called synchronously when the response arrives, before the app
   * reads the body, because it clones the response.
   */
  function readResponse(res) {
    const type = res.headers.get('content-type') || '';
    const length = Number(res.headers.get('content-length') || 0);
    if (!TEXT_TYPES.test(type) || /event-stream/i.test(type) || length > MAX_BODY || res.bodyUsed) {
      return Promise.resolve({ mimeType: type, text: null });
    }
    return res.clone().text().then((text) => ({ mimeType: type, text: text.length > MAX_BODY ? null : text }));
  }

  // ----- fetch -------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      // Gather request details first: a Request's body can only be cloned
      // before the original fetch() consumes it.
      let capture = null;
      try {
        const request = input instanceof Request ? input : null;
        const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
        const contentType = headerValue(init && init.headers, 'content-type') || (request && request.headers.get('content-type')) || '';
        let bodyPromise = Promise.resolve(null);
        if (init && init.body !== undefined && init.body !== null) {
          bodyPromise = readBody(init.body, contentType);
        } else if (request && method !== 'GET' && method !== 'HEAD' && !request.bodyUsed) {
          bodyPromise = request.clone().text().then((text) => (text ? { text: text.slice(0, MAX_BODY), mimeType: contentType } : null));
        }
        bodyPromise = bodyPromise.catch((err) => ({ note: `Could not read the body: ${err && err.message}` }));
        capture = { method, url: absolute(request ? request.url : input), contentType, bodyPromise,
          started: new Date().toISOString(), t0: performance.now() };
      } catch {
        capture = null; // never break the app
      }

      const promise = originalFetch.apply(this, arguments);
      if (capture) {
        const { method, url, contentType, bodyPromise, started, t0 } = capture;
        promise.then(
          async (res) => {
            let response = { mimeType: '', text: null };
            try {
              response = await readResponse(res);
            } catch {
              /* ignore */
            }
            post({ kind: 'fetch', method, url, started, duration: performance.now() - t0, requestContentType: contentType,
              requestBody: await bodyPromise, status: res.status, responseContentType: response.mimeType, responseBody: response.text });
          },
          async (err) => {
            post({ kind: 'fetch', method, url, started, duration: performance.now() - t0, requestContentType: contentType,
              requestBody: await bodyPromise, status: 0, error: String((err && err.message) || err) });
          },
        );
      }
      return promise;
    };
  }

  // ----- XMLHttpRequest (Axios) --------------------------------------------
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetHeader = proto.setRequestHeader;

  proto.open = function (method, url) {
    try {
      this.__payloadCapture = { method: String(method || 'GET').toUpperCase(), url: absolute(url), headers: {} };
    } catch {
      /* ignore */
    }
    return originalOpen.apply(this, arguments);
  };

  proto.setRequestHeader = function (name, value) {
    try {
      if (this.__payloadCapture) this.__payloadCapture.headers[String(name).toLowerCase()] = String(value);
    } catch {
      /* ignore */
    }
    return originalSetHeader.apply(this, arguments);
  };

  proto.send = function (body) {
    try {
      const info = this.__payloadCapture;
      if (info) {
        const started = new Date().toISOString();
        const t0 = performance.now();
        const contentType = info.headers['content-type'] || '';
        const bodyPromise = readBody(body, contentType);
        this.addEventListener('loadend', async () => {
          let responseBody = null;
          let responseType = '';
          try {
            responseType = this.getResponseHeader('content-type') || '';
            if (this.responseType === '' || this.responseType === 'text') responseBody = this.responseText;
            else if (this.responseType === 'json') responseBody = JSON.stringify(this.response);
          } catch {
            /* ignore */
          }
          post({ kind: 'xhr', method: info.method, url: info.url, started, duration: performance.now() - t0,
            requestContentType: contentType, requestBody: await bodyPromise, status: this.status,
            responseContentType: responseType, responseBody });
        });
      }
    } catch {
      /* never break the app */
    }
    return originalSend.apply(this, arguments);
  };
})();
