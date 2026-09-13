/**
 * vault-test.js — the private MAIN->ISOLATED channel and the worker that
 * persists what crosses it. Stage 5, defects D3 and D10.
 *
 * This is the one path in the system that deliberately carries real values,
 * so it gets the closest scrutiny:
 *
 *   1. Real values travel over the transferred MessagePort, never over
 *      window.postMessage (which every page script can read).
 *   2. Exactly one port is ever handed out.
 *   3. Deltas queued before the port arrives are flushed, not dropped,
 *      and never fall back to the page-readable channel.
 *   4. The worker stores per tab, so tab A's placeholder cannot resolve to
 *      tab B's value.
 *   5. Closing a tab drops its values.
 *
 * Run: node src/vault-test.js   (or npm run test:vault)
 */

'use strict';

const {
  buildSandbox,
  loadBundle,
  userMessageBody,
  settle,
  createReporter,
  appearsIn,
  makePortPair,
  fakeChrome,
  loadServiceWorker,
} = require('./test-harness');

const SEND_URL = 'https://chatgpt.com/backend-api/f/conversation';
const EMAIL = 'alice@example.com';
const PHONE = '555-123-4567';

const r = createReporter('vault-test: private channel + session storage');

/** Stand in for content-bridge.js offering its port to the MAIN world. */
function offerPort(h) {
  const [bridgeSide, mainSide] = makePortPair();
  const received = [];
  bridgeSide.onmessage = (e) => received.push(e.data);
  h.win.postMessage({ source: 'pii-redact-port-offer' }, h.win.location.origin, [
    mainSide,
  ]);
  return { bridgeSide, received };
}

async function send(h, prompt) {
  const res = await h.win.fetch(SEND_URL, {
    method: 'POST',
    body: userMessageBody(prompt),
    headers: { 'content-type': 'application/json' },
  });
  await res.text();
}

async function main() {
  r.group('handshake and delta delivery');

  const h = buildSandbox();
  loadBundle(h);

  const { received } = offerPort(h);

  r.check(
    'injector acknowledges the port',
    h.kinds().includes('vault-channel-open'),
    `kinds: ${h.kinds().join(', ')}`
  );

  await send(h, `mail ${EMAIL} or call ${PHONE}`);
  await settle();

  r.check('a delta arrived on the port', received.length === 1, `got ${received.length}`);

  const delta = received[0] && received[0].delta;
  r.check(
    'delta carries the real values',
    !!delta &&
      Object.values(delta).includes(EMAIL) &&
      Object.values(delta).includes(PHONE),
    JSON.stringify(delta)
  );
  r.check(
    'delta is keyed by placeholder token',
    !!delta &&
      Object.keys(delta).every((k) => /^\[[A-Z_]+_PLACEHOLDER_\d+\]$/.test(k)),
    JSON.stringify(delta && Object.keys(delta))
  );

  // The whole point: values went over the port, NOT over postMessage.
  r.check(
    'no real value on the page-readable channel',
    !appearsIn(h.relayedJson(), EMAIL) && !appearsIn(h.relayedJson(), PHONE),
    'a real value was found in a window.postMessage payload'
  );

  await send(h, `remind me: ${EMAIL}`);
  await settle();
  r.check(
    'known value sends no second delta',
    received.length === 1,
    `expected 1 delta total, got ${received.length}`
  );

  r.group('the port is handed out exactly once');

  const second = offerPort(h);
  await send(h, 'new address bob@example.com');
  await settle();

  r.check(
    'a later port offer is ignored',
    second.received.length === 0,
    `second port received ${second.received.length} messages — a page script ` +
      'offering a port after ours could have hijacked the channel'
  );
  r.check(
    'deltas keep flowing to the original port',
    received.length === 2,
    `original port has ${received.length} deltas`
  );

  r.group('deltas produced before the port arrives');

  const early = buildSandbox();
  loadBundle(early);

  await send(early, `early ${EMAIL}`);
  await settle();

  r.check(
    'nothing leaked while waiting for the port',
    !appearsIn(early.relayedJson(), EMAIL),
    'value fell back to the page-readable channel'
  );

  const late = offerPort(early);
  await settle();

  r.check(
    'queued delta flushes once the port arrives',
    late.received.length === 1 &&
      Object.values(late.received[0].delta).includes(EMAIL),
    `got ${late.received.length} deltas: ${JSON.stringify(late.received)}`
  );

  r.group('service worker storage');

  const fake = fakeChrome();
  loadServiceWorker(fake);

  const tabA = { tab: { id: 11 } };
  const tabB = { tab: { id: 22 } };

  const wrote = await fake.chrome.runtime.sendMessage(
    {
      source: 'pii-redact',
      kind: 'map-update',
      delta: { '[EMAIL_PLACEHOLDER_1]': EMAIL },
    },
    tabA
  );
  r.check('worker accepts a delta', !!wrote && wrote.ok === true, JSON.stringify(wrote));
  r.check(
    'stored under the tab key',
    'map:11' in fake.session,
    Object.keys(fake.session).join(', ')
  );

  await fake.chrome.runtime.sendMessage(
    {
      source: 'pii-redact',
      kind: 'map-update',
      delta: { '[EMAIL_PLACEHOLDER_1]': 'bob@example.com' },
    },
    tabB
  );

  r.check(
    'tabs are isolated',
    fake.session['map:11']['[EMAIL_PLACEHOLDER_1]'] === EMAIL &&
      fake.session['map:22']['[EMAIL_PLACEHOLDER_1]'] === 'bob@example.com',
    JSON.stringify(fake.session)
  );

  // Merging must not clobber earlier turns — the D1 failure mode, one
  // layer down in the storage path.
  await fake.chrome.runtime.sendMessage(
    {
      source: 'pii-redact',
      kind: 'map-update',
      delta: { '[PHONE_PLACEHOLDER_1]': PHONE },
    },
    tabA
  );
  r.check(
    'delta merges rather than replaces',
    Object.keys(fake.session['map:11']).length === 2,
    JSON.stringify(fake.session['map:11'])
  );

  const stats = await fake.chrome.runtime.sendMessage(
    { source: 'pii-redact', kind: 'vault-stats' },
    tabA
  );
  r.check(
    'vault-stats returns counts and types only',
    stats.ok &&
      stats.total === 2 &&
      stats.byType.EMAIL === 1 &&
      stats.byType.PHONE === 1 &&
      !JSON.stringify(stats).includes(EMAIL),
    JSON.stringify(stats)
  );

  const del = await fake.chrome.runtime.sendMessage(
    { source: 'pii-redact', kind: 'vault-delete', token: '[PHONE_PLACEHOLDER_1]' },
    tabA
  );
  r.check(
    'single entry can be deleted',
    del.ok && del.deleted && !('[PHONE_PLACEHOLDER_1]' in fake.session['map:11']),
    JSON.stringify(fake.session['map:11'])
  );

  await fake.chrome.runtime.sendMessage(
    { source: 'pii-redact', kind: 'vault-clear' },
    tabA
  );
  r.check(
    'vault can be cleared',
    !('map:11' in fake.session),
    Object.keys(fake.session).join(', ')
  );

  fake.closeTab(22);
  await settle(5);
  r.check(
    'closing a tab drops its values',
    !('map:22' in fake.session),
    Object.keys(fake.session).join(', ')
  );

  r.group('worker rejects junk');

  const bad = await fake.chrome.runtime.sendMessage(
    { source: 'pii-redact', kind: 'nonsense' },
    tabA
  );
  r.check('unknown kind is refused', !!bad && bad.ok === false, JSON.stringify(bad));

  const noTab = await fake.chrome.runtime.sendMessage(
    { source: 'pii-redact', kind: 'vault-read' },
    { tab: undefined }
  );
  r.check('missing tab id is refused', !!noTab && noTab.ok === false, JSON.stringify(noTab));

  r.done();
}

main().catch((e) => {
  console.error('\nvault-test crashed:', e);
  process.exit(1);
});
