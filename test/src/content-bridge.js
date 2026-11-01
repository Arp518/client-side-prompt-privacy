/**
 * PHASE 0 — ISOLATED WORLD BRIDGE
 * --------------------------------
 *
 * Responsibilities:
 *
 * A. Receive events from inject.js through window.postMessage.
 * B. Persist Phase-0 events into chrome.storage.local.
 * C. Independently observe the ChatGPT DOM.
 * D. Detect message roles using:
 *
 *      data-message-author-role="user"
 *      data-message-author-role="assistant"
 *
 * IMPORTANT:
 * We do NOT assume that the MutationObserver's target itself
 * is the message element.
 *
 * ChatGPT often inserts a wrapper containing the actual
 * [data-message-author-role] element several levels below it.
 */

const LOG_PREFIX = "[PII-REDACT PHASE0][bridge]";

const STORAGE_KEY = "phase0_log";
const MAX_LOG_ENTRIES = 200;
const FLUSH_DEBOUNCE_MS = 500;

const ROLE_SELECTOR = "[data-message-author-role]";

// Set to true to log every MutationObserver batch. Off by default: the
// observer watches all of document.body, so during streaming this fires
// hundreds of times per reply, floods the console, and skews any latency
// measurement taken on the same page.
const DEBUG_OBSERVER = false;

let contextInvalidated = false;


/* ============================================================
 * STORAGE
 *
 * Writes are buffered in memory and flushed on a debounce.
 *
 * The previous implementation did get() -> mutate -> set() per event
 * with no serialization. Because the MutationObserver is a high-rate
 * writer, concurrent calls interleaved and silently dropped entries —
 * under exactly the burst conditions (a streaming reply) that the log
 * exists to record. Buffering also collapses a burst into one write.
 * ========================================================== */

let pendingEntries = [];
let flushTimer = null;

async function flushLog() {
  flushTimer = null;

  if (contextInvalidated) return;
  if (pendingEntries.length === 0) return;

  // Take the buffer before awaiting, so entries arriving mid-write are
  // not lost to the next flush.
  const batch = pendingEntries;
  pendingEntries = [];

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);

    const existing = Array.isArray(result[STORAGE_KEY])
      ? result[STORAGE_KEY]
      : [];

    existing.push(...batch);

    while (existing.length > MAX_LOG_ENTRIES) {
      existing.shift();
    }

    await chrome.storage.local.set({
      [STORAGE_KEY]: existing,
    });

  } catch (e) {

    if (String(e).includes("Extension context invalidated")) {

      contextInvalidated = true;

      console.warn(
        `${LOG_PREFIX} extension context invalidated. ` +
        `Reload the ChatGPT tab after reloading the extension.`
      );

      return;
    }

    console.warn(
      `${LOG_PREFIX} storage write failed`,
      e
    );
  }
}

function appendToLog(entry) {
  if (contextInvalidated) return;

  pendingEntries.push(entry);

  // Bound memory if flushes keep failing.
  if (pendingEntries.length > MAX_LOG_ENTRIES * 2) {
    pendingEntries = pendingEntries.slice(-MAX_LOG_ENTRIES);
  }

  if (flushTimer === null) {
    flushTimer = setTimeout(flushLog, FLUSH_DEBOUNCE_MS);
  }
}

// Don't lose a pending batch when the tab is hidden or torn down.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushLog();
});
window.addEventListener("pagehide", flushLog);


/* ============================================================
 * PRIVATE CHANNEL TO THE MAIN WORLD
 *
 * The window.postMessage bridge below is page-readable, so it only ever
 * carries counts, types and shapes. Real token->value pairs need a
 * channel the page cannot observe, so we create a MessageChannel and
 * transfer one port into the MAIN world in a single message that carries
 * no data of its own. Everything sensitive flows over the port.
 *
 * Handshake is two-way because content-script execution order between the
 * MAIN and ISOLATED worlds at document_start is not guaranteed: we offer
 * the port on load, and also re-offer when inject.js asks. Either ordering
 * converges, and inject.js accepts only the first port it receives.
 *
 * Note the port is offered exactly once. See the matching comment in
 * inject.js for the residual risk this does not eliminate.
 * ========================================================== */

let vaultChannelOpened = false;

/**
 * Our end of the private channel, kept so control messages can be pushed
 * INTO the MAIN world rather than only received from it.
 *
 * Pause travels this way and not over window.postMessage, because that
 * channel is readable and writable by any script sharing the page's JS
 * context. A forged "paused" there would switch masking off silently while
 * the popup and the toolbar badge went on reporting it active.
 */
let vaultPort = null;

function offerVaultPort() {
  if (vaultChannelOpened) return;

  const channel = new MessageChannel();
  vaultPort = channel.port1;

  channel.port1.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.kind !== "map-update") return;
    forwardToWorker({
      source: "pii-redact",
      kind: "map-update",
      delta: msg.delta,
    });
  };

  const targetOrigin =
    (!window.location.origin || window.location.origin === 'null')
      ? '*'
      : window.location.origin;

  try {
    window.postMessage(
      { source: "pii-redact-port-offer" },
      targetOrigin,
      [channel.port2]
    );
  } catch (e) {
    try {
      window.postMessage({ source: "pii-redact-port-offer" }, "*", [channel.port2]);
    } catch (err) { /* ignore */ }
  }
}

/**
 * Push the current pause state into the MAIN world.
 *
 * The interceptor runs in the page's own realm and has no chrome.* access,
 * so it cannot read this setting — it has to be told, on every page load
 * and again whenever it changes. Without this the service worker stores a
 * pause that nothing acts on: the badge reads "off" while masking carries
 * on, which claims the protection is disabled when it is not.
 */
async function pushPauseState() {
  if (contextInvalidated || !vaultPort) return;
  try {
    const reply = await chrome.runtime.sendMessage({
      source: 'pii-redact', kind: 'get-pause',
    });
    if (reply && reply.ok) {
      vaultPort.postMessage({ kind: 'pause', paused: reply.paused === true });
    }
  } catch (e) {
    if (String(e).includes('Extension context invalidated')) contextInvalidated = true;
  }
}

// The worker pushes this the moment the user toggles the control, so the
// next request is masked (or not) without waiting for a reload.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== 'pii-redact') return;
  if (msg.kind !== 'pause-changed') return;
  if (vaultPort) {
    try {
      vaultPort.postMessage({ kind: 'pause', paused: msg.paused === true });
    } catch (e) {
      console.warn(`${LOG_PREFIX} could not deliver pause state`, e);
    }
  }
});

function forwardToWorker(message) {
  if (contextInvalidated) return;
  try {
    chrome.runtime.sendMessage(message).catch((e) => {
      if (String(e).includes("Extension context invalidated")) {
        contextInvalidated = true;
        return;
      }
      console.warn(`${LOG_PREFIX} worker message failed`, e);
    });
  } catch (e) {
    if (String(e).includes("Extension context invalidated")) {
      contextInvalidated = true;
      return;
    }
    console.warn(`${LOG_PREFIX} worker message threw`, e);
  }
}


/* ============================================================
 * MAIN-WORLD → ISOLATED-WORLD BRIDGE
 * ========================================================== */

// Validation logic lives in message-validator.js so it's testable under
// plain Node — this file itself runs top-level browser code (chrome.*,
// document) as soon as it loads, so it can't be required directly by a
// test. Bundled in via esbuild, same as inject.js.
const { isValidPhase0Message } = require('./message-validator');

window.addEventListener("message", (event) => {

  if (!isValidPhase0Message(event, window)) {
    return;
  }

  const msg = event.data;

  // inject.js loaded after us and missed the port offer -- re-offer.
  if (msg.kind === "vault-channel-open") {
    vaultChannelOpened = true;
    // The MAIN world is listening now, so this is the first moment the
    // pause state can actually be delivered.
    pushPauseState();
  }
  if (msg.kind === "injector-ready" && !vaultChannelOpened) {
    offerVaultPort();
  }

  // Forward the two counting events to the worker, which owns per-tab
  // state and the toolbar badge. These travel on the ordinary bridge
  // rather than the private port because they carry no values: a
  // replacement count and a type histogram, both of which already cross
  // this channel in body-mutated. The validator has already checked their
  // shape by this point.
  if (msg.kind === "body-mutated") {
    forwardToWorker({
      source: "pii-redact",
      kind: "turn-recorded",
      replacements: msg.payload.replacements,
      byType: msg.payload.matchTypeCounts || msg.payload.typesFound || {},
    });
  } else if (msg.kind === "restoration-complete") {
    forwardToWorker({
      source: "pii-redact",
      kind: "restoration-recorded",
      restored: msg.payload.restored,
      unreturned: msg.payload.unreturned,
      restoredTokens: msg.payload.restoredTokens || [],
    });
    // Invalidate vault map cache so the DOM fallback uses the latest map,
    // then trigger DOM restoration after a short delay to let the UI settle.
    vaultMapLastFetched = 0;
    cachedVaultMap = null;
    setTimeout(() => {
      const assistantMsgs = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      );
      for (const el of assistantMsgs) {
        tryDomRestoration(el);
      }
    }, 500);
  }

  console.log(
    `${LOG_PREFIX} [${msg.kind}]`,
    msg.payload
  );

  appendToLog({
    kind: msg.kind,
    payload: msg.payload,
    ts: msg.ts || Date.now(),
  });
});


/* ============================================================
 * ROLE DETECTION
 * ========================================================== */

/**
 * Return a valid ChatGPT message role.
 *
 * We intentionally check BOTH:
 *
 *   1. ancestors
 *   2. descendants
 *
 * because MutationObserver can give us a wrapper element
 * instead of the actual message element.
 */
function getRoleFromElement(el) {

  if (!(el instanceof Element)) {
    return null;
  }


  /* ----------------------------------------------------------
   * 1. The element itself
   * -------------------------------------------------------- */

  if (el.matches(ROLE_SELECTOR)) {

    const role = el.getAttribute(
      "data-message-author-role"
    );

    if (
      role === "user" ||
      role === "assistant"
    ) {
      return role;
    }
  }


  /* ----------------------------------------------------------
   * 2. Walk UP
   *
   * This handles:
   *
   * message text
   *    ↓
   * message content
   *    ↓
   * message container
   *    ↓
   * [data-message-author-role]
   * -------------------------------------------------------- */

  const ancestor = el.closest(ROLE_SELECTOR);

  if (ancestor) {

    const role = ancestor.getAttribute(
      "data-message-author-role"
    );

    if (
      role === "user" ||
      role === "assistant"
    ) {
      return role;
    }
  }


  /* ----------------------------------------------------------
   * 3. Search DOWN
   *
   * This handles:
   *
   * wrapper
   *    ↓
   * container
   *    ↓
   * [data-message-author-role]
   * -------------------------------------------------------- */

  const descendant = el.querySelector(
    ROLE_SELECTOR
  );

  if (descendant) {

    const role = descendant.getAttribute(
      "data-message-author-role"
    );

    if (
      role === "user" ||
      role === "assistant"
    ) {
      return role;
    }
  }


  return null;
}


/* ============================================================
 * FIND ACTUAL MESSAGE ELEMENT
 * ========================================================== */

function findMessageElement(el) {

  if (!(el instanceof Element)) {
    return null;
  }


  /* The element itself */

  if (el.matches(ROLE_SELECTOR)) {
    return el;
  }


  /* Ancestor */

  const ancestor = el.closest(ROLE_SELECTOR);

  if (ancestor) {
    return ancestor;
  }


  /* Descendant */

  const descendant = el.querySelector(
    ROLE_SELECTOR
  );

  if (descendant) {
    return descendant;
  }


  return null;
}


/* ============================================================
 * MESSAGE DESCRIPTION
 * ========================================================== */

function describeMessageElement(messageEl) {

  if (!(messageEl instanceof Element)) {
    return null;
  }


  const role =
    messageEl.getAttribute(
      "data-message-author-role"
    );


  if (
    role !== "user" &&
    role !== "assistant"
  ) {
    return null;
  }


  const text =
    (messageEl.textContent || "").trim();


  if (!text) {
    return null;
  }


  return {
    role: role,

    // In-memory only — used to build a dedup key when no message id is
    // present. Stripped before anything is persisted (see logMessage).
    textPreview: text.slice(0, 200),

    textLength: text.length,

    messageId:
      messageEl.getAttribute(
        "data-message-id"
      ) || null,

    tag: messageEl.tagName,

    className:
      typeof messageEl.className === "string"
        ? messageEl.className.slice(0, 160)
        : "",
  };
}


/* ============================================================
 * FIND MESSAGE(S) INSIDE A MUTATION TARGET
 * ========================================================== */

function findMessagesInElement(el) {

  if (!(el instanceof Element)) {
    return [];
  }


  const results = [];

  const seen = new Set();


  function addMessage(messageEl) {

    if (!(messageEl instanceof Element)) {
      return;
    }

    if (seen.has(messageEl)) {
      return;
    }

    seen.add(messageEl);


    const info =
      describeMessageElement(messageEl);

    if (info) {
      results.push(info);
    }
  }


  /* Check the element itself */

  if (el.matches(ROLE_SELECTOR)) {
    addMessage(el);
  }


  /* Check ancestor */

  const ancestor =
    el.closest(ROLE_SELECTOR);

  if (ancestor) {
    addMessage(ancestor);
  }


  /* Check descendants */

  const descendants =
    el.querySelectorAll(ROLE_SELECTOR);

  for (const messageEl of descendants) {
    addMessage(messageEl);
  }


  return results;
}


/* ============================================================
 * DOM FALLBACK OBSERVER
 *
 * DUAL PURPOSE:
 *   1. Logging: records message appearances for diagnostics.
 *   2. Restoration fallback: if the stream-level restoration fails
 *      to replace placeholders (e.g. due to model_dil_v2 split tokens
 *      or CSP fallback rendering), this observer walks assistant
 *      message text nodes and replaces any remaining placeholders
 *      with the original values from the vault.
 * ========================================================== */

/** Regex for canonical placeholder tokens in DOM text. */
const DOM_TOKEN_RE = /\[[A-Z][A-Z0-9_]*_PLACEHOLDER_\d+\]/g;

/**
 * Cached vault map for DOM-level restoration.  Refreshed periodically
 * and on every restoration-complete event.
 */
let cachedVaultMap = null;
let vaultMapLastFetched = 0;
const VAULT_MAP_TTL_MS = 2000;

async function refreshVaultMap() {
  if (contextInvalidated) return null;
  const now = Date.now();
  if (cachedVaultMap && (now - vaultMapLastFetched) < VAULT_MAP_TTL_MS) {
    return cachedVaultMap;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      source: 'pii-redact',
      kind: 'vault-read',
    });
    if (response && response.ok && response.map) {
      cachedVaultMap = response.map;
      vaultMapLastFetched = now;
    }
  } catch (e) {
    if (String(e).includes('Extension context invalidated')) {
      contextInvalidated = true;
    }
  }
  return cachedVaultMap;
}

/**
 * Walk all text nodes under `root` and replace placeholder tokens with
 * original values from the vault map.  Only touches text nodes to avoid
 * disrupting React's virtual DOM — text node mutations are the safest
 * DOM change because React does not track individual text node content
 * for its reconciliation.
 *
 * @param {Element} root  the assistant message element
 * @param {Record<string,string>} map  token → original value
 * @returns {number} number of replacements made
 */
function replaceTokensInDom(root, map) {
  if (!root || !map) return 0;

  let replacements = 0;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    null
  );

  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    if (!text || !DOM_TOKEN_RE.test(text)) continue;
    DOM_TOKEN_RE.lastIndex = 0; // reset after test()

    const replaced = text.replace(DOM_TOKEN_RE, (match) => {
      if (Object.prototype.hasOwnProperty.call(map, match)) {
        replacements++;
        return map[match];
      }
      return match;
    });

    if (replaced !== text) {
      node.nodeValue = replaced;
    }
  }
  return replacements;
}

/**
 * Scan an element (and its subtree) for assistant messages containing
 * placeholder tokens and replace them with vault values.
 */
async function tryDomRestoration(el) {
  if (!(el instanceof Element)) return;

  // Only restore in assistant messages
  const assistantEls = [];
  if (el.matches && el.matches('[data-message-author-role="assistant"]')) {
    assistantEls.push(el);
  }
  const closest = el.closest && el.closest('[data-message-author-role="assistant"]');
  if (closest) assistantEls.push(closest);
  const descendants = el.querySelectorAll
    ? el.querySelectorAll('[data-message-author-role="assistant"]')
    : [];
  for (const d of descendants) assistantEls.push(d);

  if (assistantEls.length === 0) return;

  // Check if any text contains a placeholder before fetching the map
  let hasPlaceholder = false;
  for (const ae of assistantEls) {
    const text = ae.textContent || '';
    if (DOM_TOKEN_RE.test(text)) {
      hasPlaceholder = true;
      DOM_TOKEN_RE.lastIndex = 0;
      break;
    }
  }
  if (!hasPlaceholder) return;

  const map = await refreshVaultMap();
  if (!map || Object.keys(map).length === 0) return;

  const seen = new Set();
  let totalReplacements = 0;
  for (const ae of assistantEls) {
    if (seen.has(ae)) continue;
    seen.add(ae);
    totalReplacements += replaceTokensInDom(ae, map);
  }

  if (totalReplacements > 0) {
    console.log(
      `${LOG_PREFIX} [dom-fallback-restored]`,
      { replacements: totalReplacements }
    );
    appendToLog({
      kind: 'dom-fallback-restored',
      payload: { replacements: totalReplacements },
      ts: Date.now(),
    });
  }
}

function startDomFallbackObserver() {

  if (!document.body) {

    console.warn(
      `${LOG_PREFIX} document.body does not exist yet`
    );

    return null;
  }


  console.log(
    `${LOG_PREFIX} starting DOM MutationObserver fallback`
  );


  let mutationCount = 0;
  let loggedTextCount = 0;
  let domRestorationTimer = null;


  /*
   * Store message IDs/text combinations so the same message
   * isn't logged hundreds of times.
   */

  const seen = new Set();


  function logMessage(info) {

    if (!info) {
      return;
    }


    /*
     * Prefer message ID when available.
     *
     * Otherwise use role + text.
     */

    const key = info.messageId
      ? `${info.messageId}::${info.role}`
      : `${info.role}::${info.textPreview}`;


    if (seen.has(key)) {
      return;
    }


    seen.add(key);


    /*
     * Prevent unlimited memory growth.
     */

    if (seen.size > 1000) {
      seen.clear();
    }


    loggedTextCount++;


    // Drop the rendered message text before it reaches the console or
    // chrome.storage.local. This is observed conversation content — it
    // contains exactly the PII the extension exists to protect, and the
    // research log is supposed to hold types/counts/events only.
    const { textPreview, ...redacted } = info;


    if (DEBUG_OBSERVER) {
      console.log(
        `${LOG_PREFIX} [dom-mutation-observed]`,
        redacted
      );
    }


    appendToLog({
      kind: "dom-mutation-observed",
      payload: redacted,
      ts: Date.now(),
    });
  }


  const observer =
    new MutationObserver((mutations) => {

      mutationCount += mutations.length;


      if (DEBUG_OBSERVER) {
        console.log(
          `${LOG_PREFIX} [dom-batch]`,
          {
            mutations: mutations.length,
            totalMutations: mutationCount,
          }
        );
      }


      for (const mutation of mutations) {


        /* ==================================================
         * CHARACTER DATA
         * ================================================= */

        if (
          mutation.type === "characterData"
        ) {

          let target =
            mutation.target;


          if (
            target.nodeType === Node.TEXT_NODE
          ) {
            target =
              target.parentElement;
          }


          if (target) {

            const messages =
              findMessagesInElement(target);


            for (const info of messages) {
              logMessage(info);
            }
          }


          continue;
        }


        /* ==================================================
         * CHILD LIST
         * ================================================= */

        if (
          mutation.type === "childList"
        ) {


          /*
           * First inspect the mutation target.
           *
           * This catches cases where text/content was changed
           * inside an already-existing message.
           */

          if (
            mutation.target instanceof Element
          ) {

            const messages =
              findMessagesInElement(
                mutation.target
              );


            for (const info of messages) {
              logMessage(info);
            }
          }


          /*
           * Then inspect every newly inserted subtree.
           */

          for (
            const node of mutation.addedNodes
          ) {

            if (
              node.nodeType !==
              Node.ELEMENT_NODE
            ) {
              continue;
            }


            const messages =
              findMessagesInElement(node);


            if (messages.length > 0) {

              for (const info of messages) {
                logMessage(info);
              }

            } else {

              /*
               * This is diagnostic only.
               *
               * We no longer dump the entire text of arbitrary
               * ChatGPT wrappers because that creates huge noisy
               * logs.
               */

              const text =
                (node.textContent || "")
                  .trim()
                  .slice(0, 120);


              if (DEBUG_OBSERVER) {
                console.log(
                  `${LOG_PREFIX} [added-node-no-role]`,
                  {
                    tag: node.tagName,
                    className:
                      typeof node.className === "string"
                        ? node.className.slice(0, 120)
                        : "",
                    textLength: text.length,
                  }
                );
              }
            }
          }
        }
      }


      if (DEBUG_OBSERVER) {
        console.log(
          `${LOG_PREFIX} [dom-batch-complete]`,
          {
            totalMutations: mutationCount,
            loggedTextEntries: loggedTextCount,
          }
        );
      }

      // Debounced DOM-level restoration fallback.  During streaming,
      // mutations fire hundreds of times.  We defer restoration until
      // the burst settles (300ms quiet), which typically means the end
      // of a streaming response or a large DOM update.
      if (domRestorationTimer !== null) clearTimeout(domRestorationTimer);
      domRestorationTimer = setTimeout(() => {
        domRestorationTimer = null;
        const assistantMsgs = document.querySelectorAll(
          '[data-message-author-role="assistant"]'
        );
        for (const el of assistantMsgs) {
          tryDomRestoration(el);
        }
      }, 300);
    });


  observer.observe(
    document.body,
    {
      childList: true,
      subtree: true,
      characterData: true,
    }
  );


  console.log(
    `${LOG_PREFIX} MutationObserver attached to document.body`
  );


  return observer;
}


/* ============================================================
 * START
 * ========================================================== */

// Offer the private port first, synchronously, before anything else runs.
// This is at document_start, ahead of any page script, which is what makes
// the handshake defensible.
offerVaultPort();

// This script now runs at document_start so it is listening before
// inject.js posts `injector-ready` (previously it loaded at document_idle
// and every event before that was dropped). At document_start there is no
// document.body yet, so the observer has to wait for it.
if (document.body) {
  startDomFallbackObserver();
} else {
  document.addEventListener(
    "DOMContentLoaded",
    () => startDomFallbackObserver(),
    { once: true }
  );
}


console.log(
  `${LOG_PREFIX} bridge active on ${location.href}`
);
