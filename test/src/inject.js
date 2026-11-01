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

  // Flip to false to leave the reply untouched, so the user sees raw
  // placeholders. Useful for isolating "did masking work" from "did
  // restoration work" during a live session.
  const RESTORE_RESPONSES = true;

  const { relay } = require('./relay');
  const { createTokenSession } = require('./tokenizer');
  const { initVaultClient } = require('./vault-client');
  const { createRequestMutator } = require('./request-mutator');
  const { installFetchInterceptor } = require('./request-interceptor');
  const { installTransportCanary } = require('./transport-canary');

  // One tokenizer for the lifetime of this page's MAIN world, so placeholder
  // numbering is monotonic across turns and repeated values keep their token.
  const tokenSession = createTokenSession();

  /**
   * Whether masking is switched off for this tab.
   *
   * Starts false — masking ON — and that direction is deliberate. The
   * interceptor is live before the real setting can arrive from the
   * service worker, so there is a short window on every page load where it
   * acts on this assumption. Assuming "paused" would send the first prompt
   * of that window in the clear; assuming "active" masks a prompt the user
   * may have wanted raw. The first is a disclosure the user cannot undo,
   * the second is an annoyance they can see and fix.
   *
   * It arrives over the PRIVATE port, never window.postMessage. A forged
   * "paused" on a page-readable channel would switch masking off while the
   * interface went on reporting it active, which is the one lie this
   * extension must not tell.
   */
  let maskingPaused = false;

  // Private channel to transfer token map deltas securely to the isolated world
  const { sendVaultDelta } = initVaultClient({
    relay,
    onControl: (msg) => {
      if (msg.kind === 'pause' && typeof msg.paused === 'boolean') {
        maskingPaused = msg.paused;
      }
    },
  });

  // Which markers the model actually gave back. Tokens only, never values.
  // Compared against the session map, this is what lets the interface
  // eventually distinguish "restored" from "the model dropped it", instead
  // of silently presenting an incomplete reply as if it were whole.
  const restoredTokens = new Set();

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

    // Response restoration. getMap is read lazily on each frame because the
    // session keeps minting tokens while a reply streams -- a later turn
    // can add entries before this one finishes.
    getMap: () => tokenSession.getMap(),
    restoreResponses: RESTORE_RESPONSES,

    // Echo instrumentation: counts which markers actually came back, so the
    // UI can eventually say "5 restored, 2 could not be". Receives tokens,
    // never values.
    onRestored: (token) => {
      restoredTokens.add(token);
    },

    // Read per request, not captured once: the setting arrives after the
    // page has already loaded, so a value sampled at install time would be
    // permanently stale.
    isPaused: () => maskingPaused,
  });

  installTransportCanary({
    relay,
    logPrefix: LOG_PREFIX,
  });

  relay("injector-ready", { url: location.href });
  console.log(`${LOG_PREFIX} injector active — patched window.fetch`);
})();
