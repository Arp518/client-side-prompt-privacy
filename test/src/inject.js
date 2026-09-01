/**
 * PHASE 0 — MAIN WORLD INTERCEPTOR
 * ---------------------------------
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
 * NEXT: the EMAIL_RE toy detector below proved the substitution
 * mechanism end-to-end and its job is done. Phase 1 replaces it with the
 * real detection engine (regex tiers + compromise.js NER, built and
 * tested standalone in detection/) bundled in here.
 */

(function () {
  const LOG_PREFIX = "[PII-REDACT PHASE0]";

  // --- CONFIG -----------------------------------------------------------
  // Confirmed via live testing: the message-send endpoint is exactly
  // /backend-api/f/conversation. Narrowed from the earlier broad
  // "conversation" substring match, which was also catching
  // /conversation/prepare, /conversation/experimental/generate_autocompletions,
  // /conversations?..., and /conversation/<id>/stream_status — none of
  // which carry the user's message text, so they only added log noise and
  // wasted mutateBodyText() calls that always ended in no-text-parts-found.
  //
  // If ChatGPT changes this endpoint again, re-run the Phase 0 Network-tab
  // check (send a message, watch for the real POST) before re-widening
  // this — don't just guess a new substring.
  const ENDPOINT_MATCHERS = [
    "/backend-api/f/conversation",
  ];

  // Flip to false to leave requests untouched and only observe (useful if
  // you want to isolate "can we see it" from "can we survive mutating it").
  const MUTATE_BODY = true;

  // Toy detector — real detection engine (regex + compromise.js) comes in
  // Phase 1. This is only here to prove the substitution mechanism works
  // end-to-end, which it has: verified live, ChatGPT echoed
  // [EMAIL_PLACEHOLDER_1]/[EMAIL_PLACEHOLDER_2] back verbatim in its reply.
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  function relay(kind, payload) {
    window.postMessage(
      { source: "pii-redact-phase0", kind, payload, ts: Date.now() },
      "*"
    );
  }

  function isTargetEndpoint(url) {
    try {
      const s = typeof url === "string" ? url : url.url;
      return ENDPOINT_MATCHERS.some((m) => s.includes(m));
    } catch (e) {
      return false;
    }
  }

  // Walk ChatGPT's message payload shape looking for the actual prompt
  // text. Confirmed live: messages[].content.parts[] holds the user's
  // typed text as a plain string. If ChatGPT changes this shape in the
  // future, log the raw parsed body (done below via 'raw-body-captured')
  // and adjust this walk to match.
  function findTextParts(parsedBody) {
    const hits = [];
    try {
      const messages = parsedBody?.messages || [];
      for (const m of messages) {
        const parts = m?.content?.parts;
        if (Array.isArray(parts)) {
          parts.forEach((p, i) => {
            if (typeof p === "string") hits.push({ messageRef: m, key: i, arr: parts });
          });
        }
      }
    } catch (e) {
      relay("error", { where: "findTextParts", message: String(e) });
    }
    return hits;
  }

  function mutateBodyText(rawBodyText) {
    let parsed;
    try {
      parsed = JSON.parse(rawBodyText);
    } catch (e) {
      // Not JSON, or not the shape we expect — bail out and send unmodified.
      relay("body-not-json", { rawBodyPreview: rawBodyText.slice(0, 200) });
      return { mutated: false, bodyText: rawBodyText };
    }

    relay("raw-body-captured", { parsed }); // <-- TEST 1: can we see plaintext?

    const hits = findTextParts(parsed);
    if (hits.length === 0) {
      relay("no-text-parts-found", {
        note: "Payload shape didn't match messages[].content.parts[]. Inspect 'raw-body-captured' and update findTextParts().",
      });
      return { mutated: false, bodyText: rawBodyText };
    }

    let replacedAny = false;
    let counter = 0;
    for (const hit of hits) {
      const original = hit.arr[hit.key];
      const replaced = original.replace(EMAIL_RE, () => {
        counter += 1;
        replacedAny = true;
        return `[EMAIL_PLACEHOLDER_${counter}]`;
      });
      hit.arr[hit.key] = replaced;
    }

    if (!replacedAny) {
      relay("no-pii-matched", { note: "No email-shaped text found in this prompt — try including one to test mutation." });
      return { mutated: false, bodyText: rawBodyText };
    }

    const newBodyText = JSON.stringify(parsed);
    relay("body-mutated", {           // <-- TEST 2: proof we changed it
      replacements: counter,
      before: rawBodyText.slice(0, 300),
      after: newBodyText.slice(0, 300),
    });
    return { mutated: true, bodyText: newBodyText };
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    const targeted = isTargetEndpoint(input);

    if (!targeted) {
      return originalFetch(input, init);
    }

    relay("request-seen", { url: typeof input === "string" ? input : input.url });

    // Normalize so we can read + optionally rewrite the body regardless of
    // whether the caller passed fetch(url, init) or fetch(new Request(...)).
    let finalInput = input;
    let finalInit = init;

    try {
      let rawBodyText = null;

      if (input instanceof Request) {
        const cloned = input.clone();
        rawBodyText = await cloned.text();
      } else if (init && typeof init.body === "string") {
        rawBodyText = init.body;
      }

      if (rawBodyText && MUTATE_BODY) {
        const { mutated, bodyText } = mutateBodyText(rawBodyText);
        if (mutated) {
          if (input instanceof Request) {
            finalInput = new Request(input.url, {
              method: input.method,
              headers: input.headers,
              body: bodyText,
              credentials: input.credentials,
              mode: input.mode,
              cache: input.cache,
              redirect: input.redirect,
              referrer: input.referrer,
            });
          } else {
            finalInit = Object.assign({}, init, { body: bodyText });
          }
        }
      } else if (rawBodyText) {
        // Observation-only mode
        mutateBodyText(rawBodyText); // still relays raw-body-captured, just discards the rewrite
      }
    } catch (e) {
      relay("error", { where: "pre-fetch mutation", message: String(e) });
      // Fall through and send the original, unmodified request rather than
      // silently dropping the user's message.
    }

    let response;
    try {
      response = await originalFetch(finalInput, finalInit);
    } catch (e) {
      // THIS is the important failure mode for TEST 2: if ChatGPT's backend
      // signs/hashes the payload and rejects tampering, it usually surfaces
      // as a non-2xx response rather than a thrown error, so also check the
      // 'response-status' log below. A thrown error here more likely means
      // a network-level problem, not payload rejection.
      relay("fetch-threw", { message: String(e) });
      throw e;
    }

    relay("response-status", { status: response.status, ok: response.ok });
    if (!response.ok) {
      relay("possible-rejection", {
        note: "Non-2xx after mutation. If this only happens with MUTATE_BODY=true and not with it false, that's your Risk-2 signal: ChatGPT is rejecting tampered payloads.",
        status: response.status,
      });
    }

    // --- TEST 3: tee() the stream ---------------------------------------
    // We split the body into two identical streams: one we read ourselves
    // (to log/eventually detokenize), one we hand back untouched so
    // ChatGPT's own UI renders exactly as it normally would.
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
                relay("stream-chunk-sample", { chunkCount, preview: text.slice(0, 150) });
              }
            }
            relay("stream-complete", { chunkCount, totalBytesApprox: totalChars });
          } catch (e) {
            relay("error", { where: "tee spy branch read", message: String(e) });
          }
        })();

        response = new Response(uiBranch, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        relay("error", { where: "tee()", message: String(e) });
        // If tee() itself throws, return the original response untouched —
        // better to fail open (redaction skipped) than break ChatGPT's UI.
      }
    }

    return response;
  };

  relay("injector-ready", { url: location.href });
  console.log(`${LOG_PREFIX} injector active — patched window.fetch`);
})();