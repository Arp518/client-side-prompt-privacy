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
const statsKey = (tabId) => `stats:${tabId}`;
const pauseKey = (tabId) => `paused:${tabId}`;

/**
 * Pause is per tab and defaults to OFF, which means masking is on.
 *
 * The default matters more than it looks. The interceptor starts before
 * this value can reach it, so there is a brief window on every page load
 * where it acts on whatever it assumed. Assuming "paused" would send the
 * first prompt of that window in the clear; assuming "active" masks a
 * prompt the user may have wanted raw. The first is a disclosure, the
 * second is an annoyance the user can see and undo.
 */
async function readPaused(tabId) {
  const key = pauseKey(tabId);
  const got = await chrome.storage.session.get(key);
  return got[key] === true;
}

/** Bound per-tab growth; a runaway page should not fill session storage. */
const MAX_ENTRIES_PER_TAB = 1000;

/**
 * Per-tab counters for the interface. Deliberately separate from the vault:
 * the vault holds values and must be read sparingly, whereas the popup
 * polls these on every open. Counts and type names only -- nothing here is
 * derived from the content of a prompt or a reply.
 */
async function readStats(tabId) {
  const key = statsKey(tabId);
  const got = await chrome.storage.session.get(key);
  const v = got[key];
  return (v && typeof v === 'object')
    ? v
    : { substituted: 0, byType: {}, restored: 0, unreturned: 0, turns: 0 };
}

async function writeStats(tabId, stats) {
  await chrome.storage.session.set({ [statsKey(tabId)]: stats });
  await updateBadge(tabId, stats);
  return stats;
}

/**
 * Ambient signal on the toolbar icon. Amber when the model failed to return
 * a marker, because that is the state the user cannot otherwise see: the
 * reply looks complete but a value is missing from it.
 */
async function updateBadge(tabId, stats, pausedHint) {
  try {
    const paused = pausedHint === undefined ? await readPaused(tabId) : pausedHint;

    // Paused outranks the count. A tab that is not masking must say so on
    // the icon, because that is the only signal visible without opening
    // the popup, and a stale number there would imply protection that is
    // switched off.
    if (paused) {
      await chrome.action.setBadgeText({ tabId, text: 'off' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b45309' });
      return;
    }

    const n = stats.substituted || 0;
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
    if (n) {
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: stats.unreturned > 0 ? '#b45309' : '#3f3f46',
      });
    }
  } catch (e) {
    // A tab can close between the write and the badge update; not an error.
  }
}

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

  // Messages from the popup and options page have no sender.tab; they must
  // name the tab themselves.
  const tabId =
    sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : msg.tabId;

  // A few operations are deliberately tab-independent. Requiring a tab id
  // for those rejected them before the switch ever ran, so "clear
  // everything" returned an error the page ignored and the button appeared
  // to do nothing at all -- the worst outcome for a destructive control,
  // since the user believes their data is gone.
  const TAB_INDEPENDENT = new Set(['vault-clear-all']);

  if (!TAB_INDEPENDENT.has(msg.kind) && typeof tabId !== 'number') {
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

        // --- pause -------------------------------------------------------
        //
        // Stored per tab and pushed to the page, because the interceptor
        // runs in the page's own realm and has no chrome.* access of its
        // own. It cannot read this; it has to be told.

        case 'get-pause':
          sendResponse({ ok: true, paused: await readPaused(tabId) });
          break;

        case 'set-pause': {
          const paused = msg.paused === true;
          await chrome.storage.session.set({ [pauseKey(tabId)]: paused });
          // Tell the page immediately. If this fails -- no content script
          // yet, tab closing -- the bridge asks again at its next
          // handshake, so the state is not lost, only delayed.
          try {
            await chrome.tabs.sendMessage(tabId, {
              source: MSG_SOURCE, kind: 'pause-changed', paused,
            });
          } catch (e) { /* page not ready; it will ask on load */ }
          await updateBadge(tabId, await readStats(tabId), paused);
          sendResponse({ ok: true, paused });
          break;
        }

        case 'vault-tokens':
          // Placeholder names without the values behind them. The popup
          // needs to name which markers the model failed to return, and
          // that is the whole of what it needs; reading the full map there
          // would pull every stored secret into a surface that has no use
          // for one. Least privilege, and it keeps the popup's documented
          // invariant -- that no value is ever present in that document --
          // actually true.
          sendResponse({ ok: true, tokens: Object.keys(await readMap(tabId)) });
          break;

        // --- interface counters -------------------------------------------

        case 'turn-recorded': {
          // One send completed. msg.byType is the type histogram the
          // interceptor already relays; no content accompanies it.
          const stats = await readStats(tabId);
          stats.turns += 1;
          stats.substituted += Number(msg.replacements) || 0;
          for (const [type, n] of Object.entries(msg.byType || {})) {
            if (typeof type === 'string' && Number.isFinite(n)) {
              stats.byType[type] = (stats.byType[type] || 0) + n;
            }
          }
          sendResponse({ ok: true, ...(await writeStats(tabId, stats)) });
          break;
        }

        case 'restoration-recorded': {
          // Absolute figures for the session, not increments: the
          // transform reports against the whole map each time, so adding
          // them would double count across turns.
          const stats = await readStats(tabId);
          stats.restored = Number(msg.restored) || 0;
          stats.unreturned = Number(msg.unreturned) || 0;
          if (Array.isArray(msg.restoredTokens)) {
            stats.restoredTokens = msg.restoredTokens;

            // Name the markers that were in the vault when this reply
            // finished and did not come back in it.
            //
            // Recorded as a SET rather than left for the interface to
            // infer, because the inference it was making is wrong: given
            // only a count, "unreturned > 0" marks every unrestored token
            // as missing, including ones minted for a turn whose reply has
            // not streamed yet. Those are pending, not dropped, and
            // labelling them a failure invents a result.
            const live = Object.keys(await readMap(tabId));
            const back = new Set(msg.restoredTokens);
            stats.unreturnedTokens = live.filter((t) => !back.has(t));
          }
          sendResponse({ ok: true, ...(await writeStats(tabId, stats)) });
          break;
        }

        case 'ui-stats':
          sendResponse({ ok: true, stats: await readStats(tabId) });
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
          if (existed) {
            delete map[msg.token];
            await chrome.storage.session.set({ [mapKey(tabId)]: map });

            // Keep counters and badge in sync with the vault contents
            const stats = await readStats(tabId);
            if (stats.substituted > 0) stats.substituted -= 1;
            const m = /^\[([A-Z][A-Z0-9_]*)_PLACEHOLDER_\d+\]$/.exec(msg.token);
            if (m && stats.byType && stats.byType[m[1]]) {
              stats.byType[m[1]] -= 1;
              if (stats.byType[m[1]] <= 0) delete stats.byType[m[1]];
            }
            for (const field of ['restoredTokens', 'unreturnedTokens']) {
              if (Array.isArray(stats[field])) {
                stats[field] = stats[field].filter((t) => t !== msg.token);
              }
            }
            await writeStats(tabId, stats);
          }
          sendResponse({ ok: true, deleted: existed });
          break;
        }

        case 'vault-clear':
          // Counters go with the values. Leaving "7 protected" on screen
          // after the vault is empty would misstate what the extension
          // still holds.
          await chrome.storage.session.remove([mapKey(tabId), statsKey(tabId)]);
          await updateBadge(tabId, { substituted: 0, unreturned: 0 });
          sendResponse({ ok: true });
          break;

        case 'vault-clear-all':
          await chrome.storage.session.clear();
          try {
            const tabs = await chrome.tabs.query({
              url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
            });
            for (const t of tabs) {
              await chrome.action.setBadgeText({ tabId: t.id, text: '' });
            }
          } catch (e) { /* ignore tab query errors */ }
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
  // The pause flag goes with them. Chrome does reuse tab ids within a
  // session, and a pause that outlived its tab would silently switch
  // masking off for whatever opened next -- a stale setting that disables
  // the protection is the one kind of leftover state that must not happen.
  chrome.storage.session
    .remove([mapKey(tabId), statsKey(tabId), pauseKey(tabId)])
    .catch(() => { });
});
