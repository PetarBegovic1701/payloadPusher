// Default URL -> schemaName mapping table.
//
// These rows are only used to seed chrome.storage.local the very first time
// the panel opens. After that, edit mappings in the panel UI (Mappings
// section, or "Edit as JSON" to paste all your schemas at once). To re-seed
// from this file, click "Reset to defaults" in the panel.
//
// Row format:
//   {
//     pattern:    "/v1/users",   // matched against the FULL request URL
//                                //   - plain text        => substring match
//                                //   - "re:<expression>" => regular expression
//     method:     "POST",        // optional; "" = any method
//     schemaName: "createUser"   // becomes payloads/createUser.json
//   }
//
// Rows are checked top to bottom and the FIRST match wins, so put more
// specific patterns (e.g. ".../users/{id}") above broader ones ("/v1/users").
//
// Regex example: "re:/v1/users/[^/?]+$" matches ".../v1/users/123" but not
// ".../v1/users". (Backslashes must be doubled inside this JS file only; in
// the panel UI you type them normally.)

// eslint-disable-next-line no-unused-vars
const DEFAULT_MAPPINGS = [
  { pattern: 're:/v1/users/[^/?]+$', method: 'PATCH', schemaName: 'updateUser' },
  { pattern: '/v1/users', method: 'POST', schemaName: 'createUser' },
  { pattern: '/v1/orders', method: '', schemaName: 'createOrder' },
];
