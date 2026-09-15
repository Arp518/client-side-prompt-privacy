/**
 * message-validator.js — validates window.postMessage events claiming to
 * be from inject.js before content-bridge.js acts on them.
 *
 * Pulled out of content-bridge.js so it's testable under plain Node
 * (content-bridge.js itself isn't — it runs top-level browser code against
 * `document`/`chrome` as soon as it's loaded, so requiring it directly
 * would execute a content script outside a browser).
 *
 * See relay.js's header note for what this validation does and does not
 * protect against: it rejects structurally-wrong or unexpected-kind
 * messages, but does not make the window.postMessage channel private.
 */

'use strict';

// Every kind inject.js is allowed to send. Anything else is dropped before
// it reaches storage — this is what stops a spoofed message (e.g. from
// another extension's MAIN-world script, or an XSS payload sharing this
// page's JS context) from injecting arbitrary data into the extension's
// storage.
const ALLOWED_KINDS = new Set([
  'injector-ready',
  'request-seen',
  'body-not-json',
  'body-received',
  'no-text-parts-found',
  'no-pii-matched',
  'body-mutated',
  'error',
  'fetch-threw',
  'response-status',
  'possible-rejection',
  'stream-chunk-sample',
  'stream-complete',
]);

// Per-kind field validation. Deliberately loose (checking types, not exact
// values) — the goal is rejecting structurally-wrong messages, not
// re-implementing inject.js's business logic here.
const KIND_VALIDATORS = {
  'injector-ready': (p) => typeof p?.url === 'string',
  'request-seen': (p) => typeof p?.url === 'string',
  'body-not-json': (p) => typeof p?.rawBodyLength === 'number',
  'body-received': (p) =>
    typeof p?.endpointMatched === 'boolean' &&
    typeof p?.textLocationsFound === 'number',
  'no-text-parts-found': (p) => typeof p?.note === 'string',
  'no-pii-matched': (p) => typeof p?.note === 'string',
  'body-mutated': (p) =>
    typeof p?.replacements === 'number' &&
    typeof p?.matchTypeCounts === 'object' &&
    typeof p?.locationsMutated === 'number',
  error: (p) => typeof p?.where === 'string' && typeof p?.message === 'string',
  'fetch-threw': (p) => typeof p?.message === 'string',
  'response-status': (p) => typeof p?.status === 'number' && typeof p?.ok === 'boolean',
  'possible-rejection': (p) => typeof p?.note === 'string' && typeof p?.status === 'number',
  'stream-chunk-sample': (p) =>
    typeof p?.chunkCount === 'number' && typeof p?.preview === 'string',
  'stream-complete': (p) =>
    typeof p?.chunkCount === 'number' && typeof p?.totalBytesApprox === 'number',
};

/**
 * @param {MessageEvent} event
 * @param {Window} expectedSource - pass `window` at the call site; taken as
 *   a parameter (rather than referencing the global directly) so this
 *   function runs the same way under Node tests and in the browser.
 * @returns {boolean}
 */
function isValidPhase0Message(event, expectedSource) {
  // MAIN-world inject.js posts on the same window this script runs in (no
  // iframe/window boundary is crossed), so event.source should be exactly
  // that window. A message claiming to be from inject.js but arriving via
  // a different route is suspicious.
  if (event.source !== expectedSource) return false;

  const msg = event.data;
  if (!msg || typeof msg !== 'object') return false;
  if (msg.source !== 'pii-redact-phase0') return false;
  if (typeof msg.kind !== 'string' || !ALLOWED_KINDS.has(msg.kind)) return false;
  if (typeof msg.payload !== 'object' || msg.payload === null) return false;

  const validator = KIND_VALIDATORS[msg.kind];
  // Every entry in ALLOWED_KINDS has a matching validator — this check
  // exists so an ALLOWED_KINDS addition without a validator fails closed
  // (rejected) rather than silently skipping validation.
  if (!validator) return false;

  try {
    return validator(msg.payload);
  } catch (e) {
    return false;
  }
}

module.exports = { isValidPhase0Message, ALLOWED_KINDS, KIND_VALIDATORS };
