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
 * STAGE 1: the EMAIL_RE toy detector proved the substitution mechanism
 * end-to-end and its job is done. It has now been replaced with the real
 * detection + tokenization engine (detector.js + tokenizer.js), bundled
 * into this file via esbuild (`npm run build`).
 *
 * STAGE 2 (current): log hygiene. Nothing relayed across the postMessage
 * bridge may contain raw PII. This script runs in the page's own JS realm,
 * so anything posted here is readable by any script on the page —
 * including ChatGPT's own. Relay counts, types and shapes; never values.
 */

(function () {
  const LOG_PREFIX = "[PII-REDACT PHASE0]";

  // Escape hatch for debugging payload-shape drift. MUST be false in every
  // committed build: when true, full request bodies (with real PII) are
  // posted to the page and persisted to chrome.storage.local.
  const DEBUG_DUMP_RAW = false;

  // --- REAL DETECTION / TOKENIZATION ENGINE ------------------------------
  // Bundled in by esbuild from src/tokenizer.js (which itself requires
  // src/detector.js). Do NOT call detector.js directly here — always go
  // through tokenize() so span-to-placeholder numbering stays consistent
  // with what tokenizer.js's own smoke tests validated.
  const { createTokenSession } = require('./tokenizer');

  // One tokenizer for the lifetime of this page's MAIN world, so placeholder
  // numbering is monotonic across turns and a repeated value keeps its token.
  //
  // This replaces a plain object that was merged with Object.assign() after
  // each per-call tokenize(). Because the stateless tokenizer restarts its
  // counters every call, turn 2's [EMAIL_PLACEHOLDER_1] overwrote turn 1's,
  // and turn 1 then restored to the wrong person's address (defect D1).
  //
  // The real values live only in this closure. They are never attached to
  // `parsed` before JSON.stringify, and never relayed across the bridge —
  // this script shares a JS realm with the page, so anything posted is
  // readable by the page itself.
  const tokenSession = createTokenSession();

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
  // Compared against the parsed URL's PATHNAME, never as a substring of the
  // whole URL. Substring matching was the unfixed half of this bug: narrowing
  // "conversation" to "/backend-api/f/conversation" stopped matching
  // /backend-api/conversations (plural), but every sub-path still contains
  // the prefix, so these were all still being intercepted:
  //
  //   /backend-api/f/conversation/prepare                      (handshake, no text)
  //   /backend-api/f/conversation/experimental/generate_autocompletions
  //   /backend-api/f/conversation/<id>/stream_status
  //   /backend-api/f/conversation/init
  //
  // None carry the user's message, so each one cost a wasted parse ending in
  // no-text-parts-found — which is the log noise that got misread as a broken
  // parser in the first place. Once the response transform lands, wrapping
  // those responses would be actively wrong.
  const ENDPOINT_PATHS = new Set([
    "/backend-api/f/conversation",
  ]);

  // Flip to false to leave requests untouched and only observe (useful if
  // you want to isolate "can we see it" from "can we survive mutating it").
  const MUTATE_BODY = true;

  function relay(kind, payload) {
    // targetOrigin is scoped to this origin rather than "*". This does NOT
    // hide the message from same-origin page scripts (nothing can, from the
    // MAIN world) — it only stops the payload leaking to a cross-origin
    // opener/embedder. The real defence is not putting PII in `payload`.
    window.postMessage(
      { source: "pii-redact-phase0", kind, payload, ts: Date.now() },
      window.location.origin
    );
  }

  function isTargetEndpoint(url) {
    try {
      const raw = typeof url === "string" ? url : url && url.url;
      if (typeof raw !== "string" || raw.length === 0) return false;

      // fetch() accepts relative URLs and `new URL()` throws on a bare path,
      // so resolve against the page origin before reading the pathname.
      // Using pathname also drops the query string and hash for free.
      const { pathname } = new URL(raw, window.location.origin);

      // Tolerate one trailing slash, nothing else.
      const normalized =
        pathname.length > 1 && pathname.endsWith("/")
          ? pathname.slice(0, -1)
          : pathname;

      return ENDPOINT_PATHS.has(normalized);
    } catch (e) {
      // Unparseable URL: leave the request alone rather than guessing.
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
        // Only the user's own message is ours to rewrite. Regenerate/edit
        // payloads can carry assistant or system turns in the same array;
        // tokenizing those would corrupt conversation history.
        if (m?.author?.role !== "user") continue;
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

    // TEST 1 (can we see the plaintext body pre-send?) was answered in
    // Stage 0. Relaying the answer is what leaked it: `parsed` is the whole
    // untokenized request. Relay only its SHAPE — enough to diagnose payload
    // drift, zero PII.
    relay("body-shape-captured", {
      keys: Object.keys(parsed || {}),
      messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : 0,
      roles: (parsed?.messages || []).map((m) => m?.author?.role ?? null),
      partLengths: (parsed?.messages || []).flatMap((m) =>
        Array.isArray(m?.content?.parts)
          ? m.content.parts.map((p) => (typeof p === "string" ? p.length : -1))
          : []
      ),
    });
    if (DEBUG_DUMP_RAW) relay("raw-body-captured-DEBUG", { parsed });

    const hits = findTextParts(parsed);
    if (hits.length === 0) {
      relay("no-text-parts-found", {
        note: "Payload shape didn't match a user message at messages[].content.parts[]. Inspect 'body-shape-captured', or set DEBUG_DUMP_RAW=true locally, then update findTextParts().",
      });
      return { mutated: false, bodyText: rawBodyText };
    }

    // --- REAL DETECTION + TOKENIZATION ------------------------------------
    // For each text part found in the payload, run it through the real
    // detector/tokenizer. `parsed` only ever receives `tokenizedText` — the
    // original values are kept solely in `sessionMap`, which is never
    // merged back into `parsed` and never touches JSON.stringify below.
    let replacedAny = false;
    let totalReplacements = 0;
    const typesFound = {};

    for (const hit of hits) {
      const original = hit.arr[hit.key];
      // The session owns the map — no Object.assign merge, which is what
      // made turns overwrite each other. `map` here is only the tokens
      // newly minted by this call; a value seen in an earlier turn reuses
      // its existing token and contributes nothing new.
      const { tokenizedText, spans } = tokenSession.tokenize(original);

      if (spans.length > 0) {
        replacedAny = true;
        totalReplacements += spans.length;
        for (const s of spans) typesFound[s.type] = (typesFound[s.type] || 0) + 1;
      }

      hit.arr[hit.key] = tokenizedText; // only the tokenized text goes into parsed
    }

    if (!replacedAny) {
      relay("no-pii-matched", { note: "No PII detected in this prompt by detector.js — try including an email, phone, SSN, card number, IP, DOB, or street address to test mutation." });
      return { mutated: false, bodyText: rawBodyText };
    }

    const newBodyText = JSON.stringify(parsed);
    // TEST 2 proof, without the leak: `before` was the raw prompt and `after`
    // often still contained untokenized context. Counts and types only. The
    // authoritative proof that mutation worked is the Network tab payload,
    // not this log line.
    relay("body-mutated", {
      replacements: totalReplacements,
      typesFound,
      bytesBefore: rawBodyText.length,
      bytesAfter: newBodyText.length,
    });
    if (DEBUG_DUMP_RAW) {
      relay("body-mutated-DEBUG", {
        before: rawBodyText.slice(0, 300),
        after: newBodyText.slice(0, 300),
      });
    }
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
            // Every field here must be carried over explicitly — anything
            // omitted silently reverts to a default on the rebuilt Request.
            // `signal` is the one that matters most: drop it and ChatGPT's
            // "stop generating" button becomes a no-op on any request we
            // tampered with, because the AbortSignal is attached to the
            // Request rather than to init.
            finalInput = new Request(input.url, {
              method: input.method,
              headers: input.headers,
              body: bodyText,
              credentials: input.credentials,
              mode: input.mode,
              cache: input.cache,
              redirect: input.redirect,
              referrer: input.referrer,
              referrerPolicy: input.referrerPolicy,
              integrity: input.integrity,
              keepalive: input.keepalive,
              signal: input.signal,
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