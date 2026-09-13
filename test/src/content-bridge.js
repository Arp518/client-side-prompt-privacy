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

let vaultPortOffered = false;

function offerVaultPort() {
  if (vaultPortOffered) return;
  vaultPortOffered = true;

  const channel = new MessageChannel();

  channel.port1.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.kind !== "map-update") return;
    forwardToWorker({
      source: "pii-redact",
      kind: "map-update",
      delta: msg.delta,
    });
  };

  window.postMessage(
    { source: "pii-redact-port-offer" },
    window.location.origin,
    [channel.port2]
  );
}

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

window.addEventListener("message", (event) => {

  // Only accept messages this window posted to itself. Without this an
  // iframe (or any other frame with a handle to this window) can forge
  // {source:"pii-redact-phase0"} events straight into the research log.
  if (event.source !== window) return;

  const msg = event.data;

  if (
    !msg ||
    msg.source !== "pii-redact-phase0"
  ) {
    return;
  }

  // inject.js loaded after us and missed the port offer -- re-offer.
  if (msg.kind === "injector-ready" && !vaultPortOffered) {
    offerVaultPort();
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
 * ========================================================== */

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
