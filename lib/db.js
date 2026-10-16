// Compatibility shim. The storage implementation moved to lib/storage/ in
// Phase 2; this module preserves the historical `require("./lib/db")` entry
// point and its exact method surface so existing callers are unaffected.
//
// Backend selection lives in lib/storage/index.js (STORAGE_BACKEND, default
// "sqlite"). Set STORAGE_BACKEND=json to fall back to the legacy JSON store.

module.exports = require("./storage");
