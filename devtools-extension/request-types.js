// Shared by devtools.js and panel.js: sorting requests into "static files"
// (scripts, styles, images, …) and everything else (API calls and friends).
//
// A local dev server (Vite, webpack) can load hundreds of source files per
// page view. They are kept on a small separate budget so they can never push
// API calls out of the list.

// Chrome's resource types (the "Type" column in the Network tab) that are
// never API calls. Anything else (fetch, xhr, ping, eventsource, other, …)
// counts as an API call.
const STATIC_RESOURCE_TYPES = new Set([
  'script',
  'stylesheet',
  'image',
  'media',
  'font',
  'manifest',
  'texttrack',
  'preflight',
]);

// eslint-disable-next-line no-unused-vars
function isStaticRequest(har) {
  const type = har._resourceType || '';
  if (STATIC_RESOURCE_TYPES.has(type)) return true;
  // Page loads are static; a form POST (document with a body) is not.
  if (type === 'document' && !(har.request.postData && har.request.postData.text)) return true;
  return false;
}

/** Identifies a request across onRequestFinished and getHAR(), to skip duplicates. */
// eslint-disable-next-line no-unused-vars
function requestKey(har) {
  return `${har.startedDateTime}|${har.request.method}|${har.request.url}`;
}
