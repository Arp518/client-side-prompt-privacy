/**
 * relay.js — the one place that knows how to talk to content-bridge.js.
 *
 * Deliberately tiny and dependency-free. Everything else (request-mutator,
 * request-interceptor) takes a `relay` function as a parameter rather than
 * importing this module directly — that's what makes them independently
 * testable in Node without a `window` global.
 *
 * SECURITY NOTE (documented limitation, not fixed here — see
 * context-further2.md "later phases"): this posts on the *same* window
 * it's running in, so `targetOrigin` doesn't provide isolation the way it
 * would across a frame/window boundary — any other script sharing this JS
 * context can already do `window.addEventListener('message', ...)` and see
 * everything, regardless of what origin string is passed here. Real
 * isolation would mean replacing this broadcast-style bridge with a
 * one-time MessageChannel handshake (see README). Until then, the actual
 * mitigations are (a) never put PII/real values in relayed payloads — see
 * request-mutator.js, which only ever sends counts/types — and (b) strict
 * shape validation on the receiving end (content-bridge.js).
 */

'use strict';

const SOURCE = 'pii-redact-phase0';

/**
 * @param {string} kind - event name, e.g. "request-seen", "body-mutated"
 * @param {object} payload - metadata only; never raw PII or prompt text
 */
function relay(kind, payload) {
  window.postMessage(
    { source: SOURCE, kind, payload, ts: Date.now() },
    '*'
  );
}

module.exports = { relay, SOURCE };
