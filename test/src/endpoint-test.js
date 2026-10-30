/**
 * endpoint-test.js — which requests does the interceptor actually touch?
 *
 * Defect D16. ENDPOINT_MATCHERS was "narrowed" from "conversation" to
 * "/backend-api/f/conversation", and the journals recorded that as fixed.
 * It was half-fixed: the comparison was still `url.includes(matcher)`, and
 * every sub-path contains the prefix, so /prepare, /stream_status,
 * /experimental/... and /init were all still being intercepted.
 *
 * That costs a wasted parse per send (ending in no-text-parts-found, the
 * log noise originally misread as a broken parser), and once the response
 * transform lands it would wrap responses that are not the reply stream.
 *
 * These assertions run against the BUILT BUNDLE, so they test the shipped
 * matching behaviour rather than a copy of the regex.
 *
 * Run: node src/endpoint-test.js   (or npm run test:endpoint)
 */

'use strict';

const {
  buildSandbox,
  loadBundle,
  userMessageBody,
  settle,
  createReporter,
} = require('./test-harness');

const r = createReporter('endpoint-test: only the send endpoint is intercepted');

// [url, shouldIntercept, why]
const CASES = [
  // --- must intercept ---
  ['https://chatgpt.com/backend-api/f/conversation', true, 'the send endpoint'],
  ['https://chatgpt.com/backend-api/f/conversation?x=1', true, 'query string ignored'],
  ['https://chatgpt.com/backend-api/f/conversation/', true, 'trailing slash tolerated'],
  ['/backend-api/f/conversation', true, 'relative URL resolves against origin'],

  // --- must NOT intercept: the D16 false positives ---
  ['https://chatgpt.com/backend-api/f/conversation/prepare', false, 'handshake, carries no message'],
  ['https://chatgpt.com/backend-api/f/conversation/init', false, 'sub-path'],
  ['https://chatgpt.com/backend-api/f/conversation/abc-123/stream_status', false, 'status poll'],
  ['https://chatgpt.com/backend-api/f/conversation/experimental/generate_autocompletions', false, 'autocomplete'],

  // --- must NOT intercept: neighbouring endpoints ---
  ['https://chatgpt.com/backend-api/conversations?offset=0', false, 'conversation list (plural)'],
  ['https://chatgpt.com/backend-api/conversation/abc/textdocs', false, 'no /f/ segment'],
  ['https://chatgpt.com/backend-api/models', false, 'unrelated API'],
  ['https://chatgpt.com/', false, 'page load'],

  // --- must NOT intercept: near-miss paths that must not sneak through ---
  ['https://chatgpt.com/backend-api/f/conversationXYZ', false, 'prefix but not the path'],
  ['https://evil.example.com/backend-api/f/conversation/prepare', false, 'other origin, sub-path'],
];

async function main() {
  const h = buildSandbox();
  loadBundle(h);

  r.check(
    'bundle patched window.fetch',
    typeof h.win.fetch === 'function' && h.win.fetch.name === 'patchedFetch'
  );

  r.group('routing');

  for (const [url, shouldIntercept, why] of CASES) {
    const before = h.relayed.length;

    const res = await h.win.fetch(url, {
      method: 'POST',
      body: userMessageBody('call me at 555-123-4567'),
      headers: { 'content-type': 'application/json' },
    });
    await res.text();

    // `request-seen` is relayed only for URLs the interceptor claims.
    const sawRequest = h.relayed
      .slice(before)
      .some((m) => m.kind === 'request-seen');

    r.check(
      `${shouldIntercept ? 'intercepts' : 'ignores  '} ${url.replace('https://chatgpt.com', '')}`,
      sawRequest === shouldIntercept,
      `${why} — expected ${shouldIntercept ? 'intercept' : 'pass-through'}, got ${
        sawRequest ? 'intercept' : 'pass-through'
      }`
    );
  }

  await settle();

  r.group('non-intercepted requests are passed through untouched');

  // Every URL was fetched exactly once and reached the stub backend, so
  // ignoring a request must not mean dropping it.
  r.check(
    'all requests reached the network',
    h.requestedUrls.length === CASES.length,
    `expected ${CASES.length} outbound requests, saw ${h.requestedUrls.length}`
  );

  const ignoredBodies = h.sentBodies.filter((b) =>
    b && b.includes('555-123-4567')
  );
  r.check(
    'ignored requests keep their original body',
    ignoredBodies.length === CASES.filter(([, hit]) => !hit).length,
    `${ignoredBodies.length} unmodified bodies, expected ${
      CASES.filter(([, hit]) => !hit).length
    }`
  );

  const mutatedCount = h.kinds().filter((k) => k === 'body-mutated').length;
  r.check(
    'only the send endpoint had its body rewritten',
    mutatedCount === CASES.filter(([, hit]) => hit).length,
    `body-mutated fired ${mutatedCount} times, expected ${
      CASES.filter(([, hit]) => hit).length
    }`
  );

  // === transport canary =================================================
  // Everything above assumes the send goes out via fetch(). If OpenAI ever
  // moves it to XHR, sendBeacon or a WebSocket, the extension would keep
  // loading, keep reporting itself active, and silently mask nothing. The
  // canary turns that silent failure into a loud one.
  r.group('transport canary (observe-only)');

  const CONV = 'https://chatgpt.com/backend-api/f/conversation';
  const OTHER = 'https://chatgpt.com/backend-api/models';

  const before = h.transportCalls.length;

  const xhrHit = new h.win.XMLHttpRequest();
  xhrHit.open('POST', CONV);
  const xhrMiss = new h.win.XMLHttpRequest();
  xhrMiss.open('GET', OTHER);

  h.navigator.sendBeacon(CONV, 'beacon-body-must-not-be-relayed');
  h.navigator.sendBeacon(OTHER, 'beacon-body-must-not-be-relayed');

  new h.win.WebSocket('wss://chatgpt.com/backend-api/f/conversation/stream');
  new h.win.WebSocket('wss://chatgpt.com/other');

  const warned = h.relayed
    .filter((m) => m.kind === 'unintercepted-transport')
    .map((m) => m.payload.transport);

  r.check(
    'warns on XMLHttpRequest to the conversation endpoint',
    warned.includes('XMLHttpRequest'),
    `warned: ${warned.join(', ')}`
  );
  r.check('warns on sendBeacon', warned.includes('sendBeacon'), `warned: ${warned.join(', ')}`);
  r.check('warns on WebSocket', warned.includes('WebSocket'), `warned: ${warned.join(', ')}`);
  r.check(
    'stays quiet for unrelated URLs',
    warned.length === 3,
    `expected 3 warnings, got ${warned.length}: ${warned.join(', ')}`
  );

  // The canary must never interfere. Every call has to reach the real
  // transport, unmodified — it is a smoke alarm, not a valve.
  r.check(
    'observe-only: every call still reached its transport',
    h.transportCalls.length - before === 6,
    `expected 6 pass-through calls, saw ${h.transportCalls.length - before}`
  );

  r.check(
    'warning payload carries no request content',
    !JSON.stringify(h.relayed.filter((m) => m.kind === 'unintercepted-transport')).includes(
      'beacon-body-must-not-be-relayed'
    ),
    'the beacon body leaked into the warning'
  );

  r.done(`${CASES.length} URLs exercised`);
}

main().catch((e) => {
  console.error('\nendpoint-test crashed:', e);
  process.exit(1);
});
