/**
 * PHASE 0 — MAIN WORLD INTERCEPTOR
 * ---------------------------------
 * STATUS: Phase 0 validated against live chatgpt.com.
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
 * ARCHITECTURE (modular):
 *   inject.js                   <- coordinator: wiring only
 *   ├── relay.js                the postMessage bridge (counts, types, shapes only)
 *   ├── tokenizer.js            session tokenizer (monotonic placeholder numbering)
 *   ├── vault-client.js         private MessageChannel port for secure token map transfer
 *   ├── request-mutator.js      finds + tokenizes PII in request body
 *   │   └── payload-adapters.js understands ChatGPT request payload shape(s)
 *   ├── request-interceptor.js  patches window.fetch, rebuilds Request, tee()s stream
 *   └── transport-canary.js     watches XHR, sendBeacon, and WebSocket for drift
 */

(function () {
  const LOG_PREFIX = "[PII-REDACT PHASE0]";

  // Escape hatch for debugging payload-shape drift. MUST be false in every
  // committed build: when true, full request bodies (with real PII) are
  // posted to the page and persisted to chrome.storage.local.
  const DEBUG_DUMP_RAW = false;

  // Flip to false to leave requests untouched and only observe.
  const MUTATE_BODY = true;

  const { relay } = require('./relay');
  const { createTokenSession } = require('./tokenizer');
  const { initVaultClient } = require('./vault-client');
  const { createRequestMutator } = require('./request-mutator');
  const { installFetchInterceptor } = require('./request-interceptor');
  const { installTransportCanary } = require('./transport-canary');

  // One tokenizer for the lifetime of this page's MAIN world, so placeholder
  // numbering is monotonic across turns and repeated values keep their token.
  const tokenSession = createTokenSession();

  // Private channel to transfer token map deltas securely to the isolated world
  const { sendVaultDelta } = initVaultClient({ relay });

  const { mutateBodyText } = createRequestMutator({
    relay,
    tokenSession,
    sendVaultDelta,
    debugDumpRaw: DEBUG_DUMP_RAW,
  });

  installFetchInterceptor({
    relay,
    mutateBodyText,
    mutateBody: MUTATE_BODY,
  });

  installTransportCanary({
    relay,
    logPrefix: LOG_PREFIX,
  });

  relay("injector-ready", { url: location.href });
  console.log(`${LOG_PREFIX} injector active — patched window.fetch`);
})();
