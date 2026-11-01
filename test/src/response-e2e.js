/**
 * response-e2e.js — drives the BUILT BUNDLE through a recorded ChatGPT
 * stream and checks what the page would end up rendering.
 *
 * This is the check that was missing, and its absence is why two of the
 * three restoration paths shipped broken. The unit tests all passed: the
 * reply still arrived, still streamed, still looked like a reply. One field
 * simply kept its raw placeholder and another gained a stray fragment, and
 * nothing anywhere compared the output against the text a user should see.
 *
 * Two properties, in this order of importance:
 *
 *   1. Nothing leaks. The real email and phone number must not appear in
 *      the bytes that left the browser, nor anywhere on the page-readable
 *      postMessage channel. This matters more than restoration working.
 *   2. Every render path is restored. The page may display any of the three
 *      fields that carry the reply, so a check on one of them proves
 *      nothing about what the user sees.
 *
 * Runs against dist/inject.bundle.js on purpose, not src/. A stale bundle
 * is a real failure mode -- it is what made the first live Chrome test show
 * raw placeholders while the source was already fixed -- and only a test
 * that loads the shipped artifact can catch it.
 */

'use strict';

const {
  buildSandbox, loadBundle, userMessageBody, settle, createReporter, appearsIn,
} = require('./test-harness');
const { buildCapturedStream, renderPaths } = require('./response-capture');

const EMAIL = 'alice.renner@example.com';
const PHONE = '555-123-4567';
const ENDPOINT = 'https://chatgpt.com/backend-api/f/conversation';

// The markers the tokenizer is expected to mint for one email and one phone
// in a fresh session. Asserted rather than assumed: if the naming scheme
// changes, this test fails loudly instead of quietly checking nothing.
const EMAIL_TOKEN = '[EMAIL_PLACEHOLDER_1]';
const PHONE_TOKEN = '[PHONE_PLACEHOLDER_1]';

async function main() {
  const r = createReporter('response restoration against a recorded stream');

  const { sse, expected } = buildCapturedStream({
    email: EMAIL_TOKEN, phone: PHONE_TOKEN,
  });

  const harness = buildSandbox({ sseBody: sse });
  loadBundle(harness);

  const prompt = `Reply with exactly this sentence, word for word:\n`
    + `"I will email ${EMAIL} and call ${PHONE}."`;

  const response = await harness.win.fetch(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: userMessageBody(prompt),
    })
  );

  const received = await response.text();
  await settle();

  const sent = harness.sentBodies.join('\n');
  const relayedJson = harness.relayedJson();

  r.group('nothing leaked');
  r.check('real email did not leave the browser', !appearsIn(sent, EMAIL),
    'found in the outgoing body');
  r.check('real phone did not leave the browser', !appearsIn(sent, PHONE),
    'found in the outgoing body');
  r.check('markers were substituted in its place',
    sent.includes(EMAIL_TOKEN) && sent.includes(PHONE_TOKEN),
    `token naming changed? outgoing body had neither marker`);
  r.check('no real value on the page-readable channel',
    !appearsIn(relayedJson, EMAIL) && !appearsIn(relayedJson, PHONE),
    'postMessage payload carried a stored value');
  r.check('no reply text on the page-readable channel',
    !appearsIn(relayedJson, 'I will email'),
    'postMessage payload carried reply content');

  r.group('what the page would render');
  const paths = renderPaths(received);
  const restored = expected
    .replace(EMAIL_TOKEN, EMAIL)
    .replace(PHONE_TOKEN, PHONE);

  r.check('stream is still well-formed SSE', paths.stray.length === 0,
    `${paths.stray.length} chunk(s) outside any data: frame`);
  r.check('/message/content/parts restored', paths.parts === restored,
    JSON.stringify(paths.parts));
  r.check('model_dil_v2.constants restored', paths.constants === restored,
    JSON.stringify(paths.constants));
  r.check('model_dil_v2.fallbackMarkdown restored',
    paths.fallbackMarkdown === restored, JSON.stringify(paths.fallbackMarkdown));
  r.check('no marker survives anywhere in the reply',
    !received.includes('PLACEHOLDER'),
    'a raw marker reached the page');

  r.group('what the interface is told');
  const done = harness.relayed.filter((m) => m && m.kind === 'restoration-complete');
  r.check('restoration-complete relayed exactly once', done.length === 1,
    `relayed ${done.length} time(s)`);
  const p = done.length ? done[0].payload : {};
  r.check('reports both markers returned by the model', p.restored === 2,
    JSON.stringify(p));
  r.check('reports nothing unreturned', p.unreturned === 0, JSON.stringify(p));
  r.check('names only tokens, never values',
    Array.isArray(p.restoredTokens)
      && p.restoredTokens.every((t) => /^\[[A-Z0-9_]+\]$/.test(t)),
    JSON.stringify(p.restoredTokens));

  r.done('bundle, not source');
}

main().catch((e) => {
  console.error('\n  response e2e threw:', e && e.stack ? e.stack : e, '\n');
  process.exit(1);
});
