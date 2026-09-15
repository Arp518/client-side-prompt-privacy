/**
 * PHASE 0 — MAIN WORLD INTERCEPTOR (entry point)
 * ------------------------------------------------
 * STATUS: Phase 0 validated (2026-08-31 / 2026-09-01) against live
 * chatgpt.com. All four risks confirmed with real evidence:
 *   1. Plaintext request body IS visible before it leaves the browser.
 *   2. A MUTATED body IS accepted by ChatGPT (200 OK, coherent reply
 *      referencing the injected placeholders verbatim).
 *   3. tee() on the streamed response does NOT break ChatGPT's own
 *      rendering — normal replies kept streaming in throughout testing.
 *   4. DOM fallback (content-bridge.js) independently confirms role
 *      via [data-message-author-role] + .closest().
 *
 * This script runs inside ChatGPT's own JS context (not the extension's
 * sandboxed "isolated world"). That's the only way to see and modify the
 * arguments to window.fetch before ChatGPT's own code calls it.
 *
 * It does NOT talk to chrome.* APIs — MAIN world can't. Everything it
 * finds gets relayed to the isolated-world content script via
 * window.postMessage, which content-bridge.js picks up and can log to
 * chrome.storage / the extension's own console context.
 *
 * ARCHITECTURE (as of this pass — further modularization step):
 *   inject.js               <- you are here: wiring only, no logic
 *   ├── relay.js             the postMessage bridge
 *   ├── request-mutator.js   finds + tokenizes PII in a request body
 *   ├── request-interceptor.js  patches window.fetch, rebuilds Request,
 *   │                           tee()s the response
 *   └── payload-adapters.js  (used by request-mutator) knows the current
 *                            ChatGPT payload shape(s)
 *
 * Previously all of the above lived directly in this file. Splitting it
 * up means each piece can be read, tested, and changed independently —
 * e.g. adding chrome.storage.session persistence (Phase 1.5) only touches
 * request-mutator.js, and response detokenization (Phase 2) will mostly
 * live inside request-interceptor.js's tee() block, not here.
 *
 * KNOWN LIMITATION (documented, not fixed): only window.fetch is patched.
 * If a target site sends its prompt-carrying request via XMLHttpRequest or
 * WebSocket instead of fetch, this extension will not see or tokenize it.
 * For chatgpt.com specifically this is low-risk today — the live test log
 * confirms the real /backend-api/f/conversation request goes through
 * fetch(). Revisit only if (a) ChatGPT changes transport, or (b) this
 * extension is pointed at a different target site that doesn't use fetch
 * for its prompt requests. Not worth speculative XHR/WebSocket
 * interception code until one of those is actually true.
 */

(function () {
  const LOG_PREFIX = "[PII-REDACT PHASE0]";

  const { relay } = require('./relay');
  const { createRequestMutator } = require('./request-mutator');
  const { installFetchInterceptor } = require('./request-interceptor');

  // Flip to false to leave requests untouched and only observe (useful if
  // you want to isolate "can we see it" from "can we survive mutating it").
  const MUTATE_BODY = true;

  const { mutateBodyText } = createRequestMutator({ relay });

  installFetchInterceptor({ relay, mutateBodyText, mutateBody: MUTATE_BODY });

  relay("injector-ready", { url: location.href });
  console.log(`${LOG_PREFIX} injector active — patched window.fetch`);
})();
