/**
 * options.js — vault inspector, settings, and an honest about page.
 *
 * Design rules this file enforces, each for a reason:
 *
 *   - A stored value is masked until explicitly revealed, one row at a
 *     time, and never on hover. A pointer crossing a table during a
 *     screen-share should not expose anything.
 *   - Copy copies the PLACEHOLDER, not the value. Putting a value on the
 *     system clipboard hands it to every other application on the machine
 *     and outlives the tab.
 *   - No figure is written into the page. The accuracy table is read from
 *     the evaluation baseline that ships with the extension, so it cannot
 *     drift from what was actually measured.
 */

'use strict';

const $ = (id) => document.getElementById(id);
const PRESENTATION_KEY = 'ui:presentationMode';

let presentationMode = false;
let currentTabId = null;

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

const typeOf = (token) => {
  const m = /^\[([A-Z][A-Z0-9_]*)_PLACEHOLDER_\d+\]$/.exec(token);
  return m ? m[1] : 'UNKNOWN';
};

/* ---------------------------------------------------------------- tabs -- */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
    for (const v of document.querySelectorAll('.view')) v.hidden = true;
    tab.classList.add('active');
    $(`view-${tab.dataset.view}`).hidden = false;
  });
}

/* --------------------------------------------------------------- vault -- */

function renderRow(token, value, status = 'pending') {
  const tr = document.createElement('tr');

  const tdToken = document.createElement('td');
  tdToken.className = 'token';
  tdToken.textContent = token;

  const tdType = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'type';
  badge.textContent = typeOf(token);
  tdType.appendChild(badge);

  const tdValue = document.createElement('td');
  const shown = document.createElement('span');
  shown.className = 'value hidden';
  // Fixed-width mask: the length of a value is itself a small disclosure,
  // and a mask that tracked it would leak the shape of every secret.
  shown.textContent = '••••••••••••';
  tdValue.appendChild(shown);

  const tdStatus = document.createElement('td');
  const statusPill = document.createElement('span');
  if (status === 'restored') {
    statusPill.className = 'tag-ok';
    statusPill.textContent = 'Restored';
  } else if (status === 'unreturned') {
    statusPill.className = 'tag-warn';
    statusPill.textContent = 'Not returned';
  } else {
    statusPill.className = 'tag-dim';
    statusPill.textContent = 'Pending';
  }
  tdStatus.appendChild(statusPill);

  const tdActions = document.createElement('td');
  tdActions.className = 'right';

  const revealBtn = document.createElement('button');
  revealBtn.className = 'btn tiny';
  revealBtn.textContent = 'Reveal';
  revealBtn.disabled = presentationMode;
  let revealed = false;
  let timerId = null;
  let remaining = 8;

  revealBtn.addEventListener('click', () => {
    if (presentationMode) return;
    revealed = !revealed;
    if (revealed) {
      shown.textContent = value;
      shown.classList.remove('hidden');
      remaining = 8;
      revealBtn.textContent = `Hide (${remaining}s)`;
      timerId = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timerId);
          timerId = null;
          revealed = false;
          shown.textContent = '••••••••••••';
          shown.classList.add('hidden');
          revealBtn.textContent = 'Reveal';
        } else {
          revealBtn.textContent = `Hide (${remaining}s)`;
        }
      }, 1000);
    } else {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      shown.textContent = '••••••••••••';
      shown.classList.add('hidden');
      revealBtn.textContent = 'Reveal';
    }
  });

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn tiny';
  copyBtn.textContent = 'Copy token';
  copyBtn.title = 'Copies the placeholder, not the stored value';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(token);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy token'; }, 1200);
    } catch (e) { /* clipboard may be blocked; not worth an alert */ }
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'btn tiny danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    if (timerId) clearInterval(timerId);
    const done = await send({
      source: 'pii-redact', kind: 'vault-delete', tabId: currentTabId, token,
    });
    if (done && done.ok) loadVault();
  });

  tdActions.append(revealBtn, copyBtn, delBtn);
  tr.append(tdToken, tdType, tdValue, tdStatus, tdActions);
  return tr;
}

/**
 * Guards against overlapping renders.
 *
 * loadVault() is triggered from several places at once -- init, the tab
 * picker, the presentation-mode switch, and a storage listener that fires
 * on every counter write during a streaming reply. Each call used to clear
 * the table and then append rows AFTER awaiting the worker, so two calls
 * in flight together both cleared, both waited, and then both appended:
 * three stored values rendered as six rows, and during a reply it kept
 * growing. Only the most recent render is allowed to touch the DOM.
 */
let vaultRender = 0;

async function loadVault() {
  const mine = ++vaultRender;
  const body = $('vaultBody');

  if (currentTabId === null) {
    body.textContent = '';
    $('vaultTable').hidden = true;
    $('vaultEmpty').hidden = false;
    $('vaultEmpty').textContent = 'No supported tab is open.';
    $('vaultCount').textContent = '';
    return;
  }

  const [reply, statsReply] = await Promise.all([
    send({ source: 'pii-redact', kind: 'vault-read', tabId: currentTabId }),
    send({ source: 'pii-redact', kind: 'ui-stats', tabId: currentTabId }),
  ]);

  // A newer render started while this one was waiting; leave the DOM to it.
  if (mine !== vaultRender) return;
  body.textContent = '';

  if (!reply || !reply.ok) {
    $('vaultTable').hidden = true;
    $('vaultEmpty').hidden = false;
    // An unanswered query is not an empty vault, and must not look like one.
    $('vaultEmpty').textContent =
      'Could not read the vault. The background worker did not respond.';
    $('vaultCount').textContent = '';
    return;
  }

  const entries = Object.entries(reply.map || {});
  $('vaultCount').textContent =
    entries.length === 1 ? '1 value stored' : `${entries.length} values stored`;

  if (!entries.length) {
    $('vaultTable').hidden = true;
    $('vaultEmpty').hidden = false;
    return;
  }

  const stats = statsReply?.stats || {};
  const restoredSet = new Set(stats.restoredTokens || []);
  // Named by the worker at the moment a reply finished. Only a token in
  // this set is known to have been dropped; anything in neither set is
  // simply waiting for its turn to stream, and reporting that as a failure
  // would state a result nothing measured.
  const missingSet = new Set(stats.unreturnedTokens || []);

  for (const [token, value] of entries) {
    let status = 'pending';
    if (restoredSet.has(token)) status = 'restored';
    else if (missingSet.has(token)) status = 'unreturned';
    body.appendChild(renderRow(token, value, status));
  }
  $('vaultTable').hidden = false;
  $('vaultEmpty').hidden = true;
}

let pickerListenerAdded = false;

async function populateTabs() {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  });
  const picker = $('tabPicker');
  picker.textContent = '';

  if (!tabs.length) {
    const opt = document.createElement('option');
    opt.textContent = 'no supported tab open';
    picker.appendChild(opt);
    picker.disabled = true;
    currentTabId = null;
    loadVault();
    return;
  }

  // Preserve user-selected tab if still open, otherwise pick active tab, else first tab
  const stillValid = tabs.some((t) => t.id === currentTabId);
  if (!stillValid) {
    const activeTab = tabs.find((t) => t.active);
    currentTabId = activeTab ? activeTab.id : tabs[0].id;
  }

  for (const t of tabs) {
    const opt = document.createElement('option');
    opt.value = String(t.id);
    let host = t.url;
    try { host = new URL(t.url).host; } catch (e) { /* keep raw */ }
    opt.textContent = `${host} · tab ${t.id}${t.active ? ' (active)' : ''}`;
    if (t.id === currentTabId) opt.selected = true;
    picker.appendChild(opt);
  }
  picker.disabled = false;
  picker.value = String(currentTabId);

  if (!pickerListenerAdded) {
    pickerListenerAdded = true;
    picker.addEventListener('change', () => {
      currentTabId = Number(picker.value);
      loadVault();
    });
  }

  loadVault();
}

/* ------------------------------------------------------------ settings -- */

function applyPresentationMode(on) {
  presentationMode = on;
  $('presentationBanner').hidden = !on;
  $('presentationMode').checked = on;
  loadVault();
}

$('presentationMode').addEventListener('change', async (e) => {
  const on = e.target.checked;
  await chrome.storage.local.set({ [PRESENTATION_KEY]: on });
  applyPresentationMode(on);
});

$('clearVault').addEventListener('click', async () => {
  if (currentTabId === null) return;
  const done = await send({ source: 'pii-redact', kind: 'vault-clear', tabId: currentTabId });
  if (done && done.ok) loadVault();
});

$('clearAll').addEventListener('click', async () => {
  // Clearing is irreversible and breaks restoration for conversations
  // already in flight, so it asks first.
  if (!window.confirm(
    'Remove every stored value for every tab?\n\n' +
    'Placeholders already sent in a conversation cannot be restored afterwards.'
  )) return;
  const done = await send({ source: 'pii-redact', kind: 'vault-clear-all' });
  if (done && done.ok) {
    loadVault();
  } else {
    // Never let a destructive control fail quietly. A user who clicks
    // "clear everything", sees nothing happen and gets no error will
    // reasonably assume their data is gone when it is not.
    window.alert(
      'Could not clear stored values: the background worker did not confirm ' +
      'the operation. Nothing has been removed.'
    );
  }
});

/* --------------------------------------------------------------- audit -- */

async function loadAuditLog() {
  const body = $('auditBody');
  body.textContent = '';

  const stored = await chrome.storage.local.get('phase0_log');
  const log = stored.phase0_log;

  if (!Array.isArray(log) || !log.length) {
    $('auditTable').hidden = true;
    $('auditEmpty').hidden = false;
    $('auditCount').textContent = '0 events';
    return;
  }

  $('auditCount').textContent = `${log.length} events logged`;
  $('auditTable').hidden = false;
  $('auditEmpty').hidden = true;

  // Render newest events first
  const reversed = [...log].reverse();
  for (const item of reversed) {
    const tr = document.createElement('tr');

    const tdTime = document.createElement('td');
    tdTime.className = 'audit-time';
    try {
      const d = item.ts ? new Date(item.ts) : null;
      tdTime.textContent = d ? d.toTimeString().split(' ')[0] : '—';
    } catch (e) {
      tdTime.textContent = '—';
    }

    const tdKind = document.createElement('td');
    tdKind.className = 'audit-kind';
    tdKind.textContent = item.kind || 'unknown';

    const tdMeta = document.createElement('td');
    tdMeta.className = 'audit-meta';
    const payload = item.payload || {};
    tdMeta.textContent = JSON.stringify(payload);

    tr.append(tdTime, tdKind, tdMeta);
    body.appendChild(tr);
  }
}

$('refreshAudit').addEventListener('click', loadAuditLog);
$('clearAudit').addEventListener('click', async () => {
  await chrome.storage.local.set({ phase0_log: [] });
  loadAuditLog();
});

/* --------------------------------------------------------------- about -- */

async function loadMetrics() {
  try {
    const res = await fetch(chrome.runtime.getURL('eval/baseline.json'));
    const data = await res.json();
    const exact = data.exact || {};
    const overall = exact.overall || {};
    const perType = exact.perType || {};

    const pct = (v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');

    const body = $('metricsBody');
    body.textContent = '';

    const rows = Object.entries(perType)
      .filter(([, s]) => s && s.f1 !== null)
      .sort((a, b) => (b[1].tp + b[1].fn) - (a[1].tp + a[1].fn));

    for (const [type, s] of rows) {
      const tr = document.createElement('tr');
      for (const [text, cls] of [
        [type, 'token'], [pct(s.precision), 'right'],
        [pct(s.recall), 'right'], [pct(s.f1), 'right'],
      ]) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }

    $('metricsNote').textContent =
      `Measured over ${data.prompts} labelled prompts on ${data.generated}: ` +
      `${pct(overall.precision)} precision, ${pct(overall.recall)} recall, ` +
      `${pct(overall.f1)} F1 across implemented types.`;
    $('metricsTable').hidden = false;

    // The caveat is not optional. That recall figure comes from a corpus
    // the detector was tuned against, and presenting it without saying so
    // would overstate what is known.
    $('metricsCaveat').textContent =
      'These figures come from the development corpus, which was written ' +
      'alongside the detector and used to tune it. They are not an ' +
      'estimate of accuracy on unseen text, and the recall figure in ' +
      'particular reflects that coupling.';
    $('metricsCaveat').hidden = false;
  } catch (e) {
    $('metricsNote').textContent =
      'Measured figures could not be loaded, so none are shown.';
  }
}

/* ---------------------------------------------------------------- init -- */

async function main() {
  try {
    const m = chrome.runtime.getManifest();
    $('version').textContent = `research prototype · v${m.version}`;
  } catch (e) { /* leave the default */ }

  const stored = await chrome.storage.local.get(PRESENTATION_KEY);
  presentationMode = stored[PRESENTATION_KEY] === true;

  $('refreshTabs').addEventListener('click', () => populateTabs());

  await populateTabs();
  applyPresentationMode(presentationMode);
  loadAuditLog();
  loadMetrics();

  // Keep tab list and vault synchronized with browser activity
  // Both of these fire in bursts -- tab events on every title and favicon
  // change, storage events on every counter write while a reply streams.
  // Coalesced so a burst produces one refresh instead of dozens.
  let refreshTimer = null;
  const refreshSoon = (fn) => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; fn(); }, 200);
  };

  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener(() => refreshSoon(populateTabs));
    chrome.tabs.onRemoved.addListener(() => refreshSoon(populateTabs));
  }
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.onChanged.addListener(() => refreshSoon(loadVault));
  }
}

main();
