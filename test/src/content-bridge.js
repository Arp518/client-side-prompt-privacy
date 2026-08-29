/**
 * PHASE 0 — ISOLATED WORLD BRIDGE
 * --------------------------------
 * Two jobs:
 *   A. Listen for postMessage events from inject.js (MAIN world) and
 *      persist them to chrome.storage.local so you have a record beyond
 *      the console scrollback, plus log them clearly.
 *   B. Run a standalone MutationObserver against the chat DOM as the
 *      fallback capture method (Phase 0, step 5) — this works completely
 *      independently of the fetch-patching above, which is the point:
 *      if tee() turns out fragile in real use, this is what Phase 4 falls
 *      back to.
 */

const LOG_PREFIX = "[PII-REDACT PHASE0][bridge]";
const STORAGE_KEY = "phase0_log";
const MAX_LOG_ENTRIES = 200;

async function appendToLog(entry) {
  try {
    const existing = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
    existing.push(entry);
    while (existing.length > MAX_LOG_ENTRIES) existing.shift();
    await chrome.storage.local.set({ [STORAGE_KEY]: existing });
  } catch (e) {
    console.warn(`${LOG_PREFIX} storage write failed`, e);
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.source !== "pii-redact-phase0") return;

  console.log(`${LOG_PREFIX} [${msg.kind}]`, msg.payload);
  appendToLog({ kind: msg.kind, payload: msg.payload, ts: msg.ts });
});

// --- TEST 4 / FALLBACK: MutationObserver on the chat container -----------
//
// Selector note: ChatGPT's DOM structure changes without notice. As of
// recent versions, assistant/user turns have carried a
// `data-message-author-role` attribute — that's the anchor used below.
// If nothing logs when a response streams in, open DevTools > Elements,
// find a message bubble, and update TURN_SELECTOR to whatever attribute
// or class is actually present.
const TURN_SELECTOR = "[data-message-author-role]";
const POLL_FOR_CONTAINER_MS = 1000;
const MAX_CONTAINER_WAIT_MS = 30000;

function startObserving(root) {
  console.log(`${LOG_PREFIX} MutationObserver attached`, root);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList" && mutation.type !== "characterData") continue;

      const target = mutation.target;
      const el =
        target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
      const turn = el?.closest?.(TURN_SELECTOR);
      if (!turn) continue;

      const role = turn.getAttribute("data-message-author-role");
      const textPreview = (turn.textContent || "").slice(0, 120);

      appendToLog({
        kind: "dom-mutation-observed",
        payload: { role, textPreview },
        ts: Date.now(),
      });
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return observer;
}

function waitForChatContainerAndObserve() {
  const startedAt = Date.now();
  const interval = setInterval(() => {
    // We don't know the exact stable container yet, so start from the
    // first message turn we find and observe its parent tree — cheap and
    // resilient to minor layout changes.
    const firstTurn = document.querySelector(TURN_SELECTOR);
    if (firstTurn) {
      clearInterval(interval);
      const container = firstTurn.closest("main") || document.body;
      startObserving(container);
      return;
    }
    if (Date.now() - startedAt > MAX_CONTAINER_WAIT_MS) {
      clearInterval(interval);
      console.warn(
        `${LOG_PREFIX} gave up waiting for ${TURN_SELECTOR} after ${MAX_CONTAINER_WAIT_MS}ms — ` +
        `update TURN_SELECTOR in content-bridge.js to match current ChatGPT DOM.`
      );
    }
  }, POLL_FOR_CONTAINER_MS);
}

waitForChatContainerAndObserve();

console.log(`${LOG_PREFIX} bridge active on ${location.href}`);