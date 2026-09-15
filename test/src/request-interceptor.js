/**
 * request-interceptor.js — owns window.fetch patching and everything that
 * requires being inside a live fetch() call: endpoint matching, reading
 * the outgoing body, rebuilding the Request, and tee()-ing the response.
 *
 * Deliberately does NOT know how to find or replace PII in a body — that's
 * request-mutator.js, injected as a dependency. This module's only job is
 * "get bytes in, get (possibly different) bytes out, don't break fetch."
 */

'use strict';

// Exact pathnames only — NOT substring matching. An earlier version used
// s.includes("/backend-api/f/conversation"), which (harmlessly, since it's
// a prefix) still matched /backend-api/f/conversation/prepare too. Prepare
// is a handshake request with no messages[].content.parts[], so it always
// produced a wasted mutation call ending in no-text-parts-found — pure log
// noise, not a functional bug, but worth closing off explicitly so a
// future endpoint that happens to share this one as a *substring* (rather
// than a prefix) can't silently get swept in too.
//
// If ChatGPT changes this endpoint again, re-run the Phase 0 Network-tab
// check (send a message, watch for the real POST) before adding a new
// entry here — don't guess.
const ENDPOINT_MATCHERS = [
  '/backend-api/f/conversation',
];

function isTargetEndpoint(url) {
  try {
    const s = typeof url === 'string' ? url : url.url;
    const pathname = new URL(s, location.origin).pathname;
    // Exact match only. Matching is done against the pathname alone, not
    // the full string, so query params or a different origin can't cause
    // an accidental match either.
    return ENDPOINT_MATCHERS.some((m) => pathname === m);
  } catch (e) {
    return false;
  }
}

/**
 * Patches window.fetch in place.
 *
 * @param {object} deps
 * @param {(kind: string, payload: object) => void} deps.relay
 * @param {(rawBodyText: string) => {mutated: boolean, bodyText: string}} deps.mutateBodyText
 * @param {boolean} [deps.mutateBody=true] - flip to false to observe only
 */
function installFetchInterceptor({ relay, mutateBodyText, mutateBody = true }) {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    const targeted = isTargetEndpoint(input);

    if (!targeted) {
      return originalFetch(input, init);
    }

    relay('request-seen', { url: typeof input === 'string' ? input : input.url });

    // Normalize so we can read + optionally rewrite the body regardless of
    // whether the caller passed fetch(url, init) or fetch(new Request(...)).
    let finalInput = input;
    let finalInit = init;

    try {
      let rawBodyText = null;

      if (input instanceof Request) {
        const cloned = input.clone();
        rawBodyText = await cloned.text();
      } else if (init && typeof init.body === 'string') {
        rawBodyText = init.body;
      }

      if (rawBodyText && mutateBody) {
        const { mutated, bodyText } = mutateBodyText(rawBodyText);
        if (mutated) {
          if (input instanceof Request) {
            // Inherit everything from the original Request and override
            // only the body, instead of manually copying a fixed property
            // list (which silently drops anything not on that list —
            // signal, integrity, keepalive, referrerPolicy, duplex).
            // `new Request(existingRequest, init)` inherits the full set
            // per spec.
            //
            // Important: `input` here must be the *original*, unconsumed
            // Request, not `cloned` (which had its body read via .text()
            // above) — using the already-read one would throw.
            finalInput = new Request(input, { body: bodyText });
          } else {
            // fetch(url, init) form: init is a plain object, so spreading
            // it already preserves every field the caller set (headers,
            // credentials, signal, etc.) — only body needs overriding.
            finalInit = Object.assign({}, init, { body: bodyText });
          }
        }
      } else if (rawBodyText) {
        // Observation-only mode
        mutateBodyText(rawBodyText); // still relays body-received/body-mutated metadata, just discards the rewrite
      }
    } catch (e) {
      relay('error', { where: 'pre-fetch mutation', message: String(e) });
      // Fall through and send the original, unmodified request rather than
      // silently dropping the user's message.
    }

    let response;
    try {
      response = await originalFetch(finalInput, finalInit);
    } catch (e) {
      // If ChatGPT's backend signs/hashes the payload and rejects
      // tampering, it usually surfaces as a non-2xx response rather than a
      // thrown error, so also check the 'response-status' log below. A
      // thrown error here more likely means a network-level problem, not
      // payload rejection.
      relay('fetch-threw', { message: String(e) });
      throw e;
    }

    relay('response-status', { status: response.status, ok: response.ok });
    if (!response.ok) {
      relay('possible-rejection', {
        note: 'Non-2xx after mutation. If this only happens with mutateBody=true and not with it false, that indicates ChatGPT is rejecting tampered payloads.',
        status: response.status,
      });
    }

    // Split the body into two identical streams: one we read ourselves (to
    // log/eventually detokenize — Phase 2, not yet implemented), one we
    // hand back untouched so ChatGPT's own UI renders exactly as it
    // normally would.
    if (response.body) {
      try {
        const [uiBranch, spyBranch] = response.body.tee();

        // Read our branch in the background without blocking the response
        // we return to the page.
        (async () => {
          const reader = spyBranch.getReader();
          const decoder = new TextDecoder();
          let chunkCount = 0;
          let totalChars = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunkCount += 1;
              totalChars += value.length;
              const text = decoder.decode(value, { stream: true });
              if (chunkCount <= 3) {
                // Only log the first few chunks to avoid flooding the console
                relay('stream-chunk-sample', { chunkCount, preview: text.slice(0, 150) });
              }
            }
            relay('stream-complete', { chunkCount, totalBytesApprox: totalChars });
          } catch (e) {
            relay('error', { where: 'tee spy branch read', message: String(e) });
          }
        })();

        response = new Response(uiBranch, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        relay('error', { where: 'tee()', message: String(e) });
        // If tee() itself throws, return the original response untouched —
        // better to fail open (redaction skipped) than break ChatGPT's UI.
      }
    }

    return response;
  };
}

module.exports = { installFetchInterceptor, isTargetEndpoint, ENDPOINT_MATCHERS };
