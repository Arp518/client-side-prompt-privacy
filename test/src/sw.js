/**
 * sw.js — background service worker.
 *
 * Exists for one structural reason: chrome.storage.session defaults to
 * TRUSTED_CONTEXTS in MV3, and a content script is not a trusted context.
 * content-bridge.js literally cannot write it (defect D10). Rather than
 * widen access with setAccessLevel() — which would open session storage to
 * every content script running on the page — the bridge forwards writes
 * here and the worker performs them.
 *
 * That indirection buys three things:
 *   1. session storage stays closed to other content scripts
 *   2. sender.tab.id arrives for free, which is what per-tab isolation needs
 *   3. one trusted choke point for the rule that raw values never reach
 *      chrome.storage.local
 *
 * Storage layout:
 *   chrome.storage.session["map:<tabId>"] = { "[EMAIL_PLACEHOLDER_1]": "..." }
 *
 * Keyed by tab because each tab has its own MAIN world and therefore its
 * own token session. Sharing one map across tabs would let tab A's
 * placeholder resolve to tab B's value — isolation is currently automatic
 * precisely because nothing is shared, and storage is what would break it.
 */

'use strict';

const MSG_SOURCE = 'pii-redact';
const mapKey = (tabId) => `map:${tabId}`;

/** Bound per-tab growth; a runaway page should not fill session storage. */
const MAX_ENTRIES_PER_TAB = 1000;

async function readMap(tabId) {
  const key = mapKey(tabId);
  const got = await chrome.storage.session.get(key);
  const value = got[key];
  return value && typeof value === 'object' ? value : {};
}

async function mergeDelta(tabId, delta) {
  if (!delta || typeof delta !== 'object') return { added: 0, total: 0 };

  const existing = await readMap(tabId);
  let added = 0;

  for (const [token, value] of Object.entries(delta)) {
    if (typeof token !== 'string' || typeof value !== 'string') continue;
    if (Object.prototype.hasOwnProperty.call(existing, token)) continue;
    if (Object.keys(existing).length >= MAX_ENTRIES_PER_TAB) break;
    existing[token] = value;
    added++;
  }

  await chrome.storage.session.set({ [mapKey(tabId)]: existing });
  return { added, total: Object.keys(existing).length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== MSG_SOURCE) return undefined;

  // Messages from the popup have no sender.tab; they must name the tab.
  const tabId =
    sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : msg.tabId;

  if (typeof tabId !== 'number') {
    sendResponse({ ok: false, error: 'no tab id' });
    return true;
  }

  (async () => {
    try {
      switch (msg.kind) {
        case 'map-update':
          sendResponse({ ok: true, ...(await mergeDelta(tabId, msg.delta)) });
          break;

        case 'vault-read':
          sendResponse({ ok: true, map: await readMap(tabId) });
          break;

        case 'vault-stats': {
          // Counts and types only — safe for any caller.
          const map = await readMap(tabId);
          const byType = {};
          for (const token of Object.keys(map)) {
            const m = /^\[([A-Z][A-Z0-9_]*)_PLACEHOLDER_\d+\]$/.exec(token);
            if (m) byType[m[1]] = (byType[m[1]] || 0) + 1;
          }
          sendResponse({ ok: true, total: Object.keys(map).length, byType });
          break;
        }

        case 'vault-delete': {
          const map = await readMap(tabId);
          const existed = Object.prototype.hasOwnProperty.call(map, msg.token);
          delete map[msg.token];
          await chrome.storage.session.set({ [mapKey(tabId)]: map });
          sendResponse({ ok: true, deleted: existed });
          break;
        }

        case 'vault-clear':
          await chrome.storage.session.remove(mapKey(tabId));
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: `unknown kind: ${msg.kind}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // keep the message channel open for the async response
});

// Drop a tab's values as soon as it closes, rather than waiting for the
// whole browser session to end. Works without the "tabs" permission.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(mapKey(tabId)).catch(() => { });
});
