/**
 * popup.js — the glance surface.
 *
 * Reads counters the service worker keeps per tab and renders them. It
 * never reads the vault, so no stored value is ever present in this
 * document: everything here is a count or a type name.
 *
 * Every number on screen comes from storage. Nothing is estimated, and
 * when a figure is unavailable the panel says so rather than showing a
 * zero that reads like a measurement.
 */

'use strict';

const SUPPORTED = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(reply);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function renderTypes(byType) {
  const entries = Object.entries(byType || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) return false;

  const max = entries[0][1];
  const host = $('types');
  host.textContent = '';

  for (const [type, n] of entries) {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('span');
    label.className = 'row-type';
    label.textContent = type;

    const track = document.createElement('div');
    track.className = 'row-track';
    const fill = document.createElement('div');
    fill.className = 'row-fill';
    fill.style.width = `${Math.round((n / max) * 100)}%`;
    track.appendChild(fill);

    const count = document.createElement('span');
    count.className = 'row-count';
    count.textContent = String(n);

    row.append(label, track, count);
    host.appendChild(row);
  }
  return true;
}

async function renderRestoration(stats, tabId) {
  const { restored = 0, unreturned = 0, restoredTokens = [] } = stats;
  const total = restored + unreturned;

  $('restored').textContent = String(restored);
  $('restoredOf').textContent = total ? ` / ${total}` : '';

  if (!total) {
    $('bar').hidden = true;
    $('legend').hidden = true;
    $('unreturnedPane').hidden = true;
    return;
  }

  $('bar').hidden = false;
  $('legend').hidden = false;
  $('barRestored').style.width = `${(restored / total) * 100}%`;
  $('barUnreturned').style.width = `${(unreturned / total) * 100}%`;
  $('legendRestored').textContent = `${restored} restored`;
  $('legendUnreturned').textContent = `${unreturned} not returned`;

  if (unreturned > 0) {
    $('unreturnedPane').hidden = false;
    $('noteTitle').textContent =
      unreturned === 1
        ? '1 placeholder was not returned'
        : `${unreturned} placeholders were not returned`;

    const list = $('unreturnedList');
    list.textContent = '';
    if (tabId) {
      // Names only. This popup has no use for a stored value, so it does
      // not ask for one -- see the note at the top of this file.
      const v = await send({ source: 'pii-redact', kind: 'vault-tokens', tabId });
      if (v && v.ok && Array.isArray(v.tokens)) {
        const restoredSet = new Set(restoredTokens);
        const dropped = v.tokens.filter((t) => !restoredSet.has(t));
        for (const token of dropped) {
          const tag = document.createElement('span');
          tag.className = 'unreturned-tag';
          tag.textContent = token;
          list.appendChild(tag);
        }
      }
    }
  } else {
    $('unreturnedPane').hidden = true;
  }
}

async function applyStats(stats, tabId) {
  $('dot').classList.add('on');
  $('statusText').textContent = 'Active';
  $('substituted').textContent = String(stats.substituted || 0);
  await renderRestoration(stats, tabId);
  if (renderTypes(stats.byType)) {
    $('typesPane').hidden = false;
  } else {
    $('typesPane').hidden = true;
  }
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Not a page we act on. Say so plainly rather than showing zeros, which
  // would read as "nothing sensitive was found" instead of "not watching".
  if (!tab || !SUPPORTED.test(tab.url || '')) {
    $('scope').textContent = 'not a supported page';
    $('statusText').textContent = 'Inactive';
    $('inactivePane').hidden = false;
    $('vaultBtn').disabled = true;
    $('clearBtn').disabled = true;
    return;
  }

  let host = tab.url;
  try { host = new URL(tab.url).host; } catch (e) { /* keep the raw url */ }
  $('scope').textContent = `${host} · tab ${tab.id}`;
  $('activePanes').hidden = false;

  const reply = await send({ source: 'pii-redact', kind: 'ui-stats', tabId: tab.id });

  if (!reply || !reply.ok) {
    // The worker did not answer. Do not render zeros: an unanswered query
    // and "nothing detected yet" look identical on screen and mean
    // opposite things.
    $('statusText').textContent = 'Unknown';
    $('substituted').textContent = '—';
    $('restored').textContent = '—';
    return;
  }

  await applyStats(reply.stats || {}, tab.id);

  // Live updates while the popup stays open
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.onChanged.addListener((changes) => {
      const key = `stats:${tab.id}`;
      if (changes[key] && changes[key].newValue) {
        applyStats(changes[key].newValue, tab.id).catch(() => {});
      }
    });
  }

  $('clearBtn').addEventListener('click', async () => {
    const done = await send({ source: 'pii-redact', kind: 'vault-clear', tabId: tab.id });
    if (done && done.ok) window.close();
  });

  $('vaultBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

main().catch(() => {
  $('statusText').textContent = 'Error';
});
