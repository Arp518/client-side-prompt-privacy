/**
 * leak-test.js — guards the single most important invariant in this project:
 *
 *   NOTHING relayed across the postMessage bridge may contain raw PII.
 *
 * inject.js runs in the page's own JS realm, so every relay() payload is
 * readable by any script on the page (ChatGPT's own included), and
 * content-bridge.js persists all of them to chrome.storage.local. A single
 * careless `relay("...", { parsed })` turns the privacy tool into a privacy
 * leak — which is exactly what defect D8 was.
 *
 * Runs the REAL BUILT BUNDLE, pushes synthetic PII through the patched
 * fetch, and asserts:
 *
 *   1. No PII value appears in the outgoing request body.
 *   2. No PII value appears in any relayed payload.
 *   3. The outgoing body DOES contain the expected placeholders.
 *   4. The token session spans turns (defect D1), end to end.
 *
 * Run: node src/leak-test.js   (or npm run test:leak)
 *
 * Test data is synthetic. Never put real values in this file.
 */

'use strict';

const {
  buildSandbox,
  loadBundle,
  userMessageBody,
  settle,
  createReporter,
  appearsIn,
} = require('./test-harness');

const SEND_URL = 'https://chatgpt.com/backend-api/f/conversation';

// One synthetic value per type the detector supports.
const PII = {
  EMAIL: 'test@example.com',
  PHONE: '555-123-4567',
  SSN: '123-45-6789',
  CREDIT_CARD: '4111 1111 1111 1111',
  IPV4: '192.168.1.100',
  DOB: '03/14/1990',
  STREET_ADDRESS: '742 Evergreen Terrace',
};

const PROMPT =
  `Email me at ${PII.EMAIL}, call ${PII.PHONE}, my SSN is ${PII.SSN}, ` +
  `card ${PII.CREDIT_CARD}, server ${PII.IPV4}. ` +
  `I was born on ${PII.DOB} and live at ${PII.STREET_ADDRESS}.`;

const SECOND_EMAIL = 'bob@other-example.com';

const r = createReporter('leak-test: no raw PII may cross the postMessage bridge');

async function send(h, prompt) {
  const res = await h.win.fetch(SEND_URL, {
    method: 'POST',
    body: userMessageBody(prompt),
    headers: { 'content-type': 'application/json' },
  });
  await res.text(); // drain so the tee()'d spy branch completes
  return res;
}

async function main() {
  const h = buildSandbox();
  loadBundle(h);

  r.check(
    'bundle patched window.fetch',
    typeof h.win.fetch === 'function' && h.win.fetch.name === 'patchedFetch',
    `got: ${h.win.fetch && h.win.fetch.name}`
  );

  await send(h, PROMPT);
  await settle();

  const sentBody = h.sentBodies[0];
  const relayedJson = h.relayedJson();

  r.group('outgoing request');

  r.check(
    'body was mutated',
    sentBody && sentBody !== userMessageBody(PROMPT),
    'body went out unchanged — detection or mutation did not run'
  );
  r.check(
    'body contains placeholders',
    /\[[A-Z_]+_PLACEHOLDER_\d+\]/.test(sentBody || ''),
    'no placeholder tokens in the outgoing body'
  );
  for (const [type, value] of Object.entries(PII)) {
    r.check(
      `redacted: ${type}`,
      !appearsIn(sentBody || '', value),
      `found ${JSON.stringify(value)} in the request that left the browser`
    );
  }

  r.group('bridge payloads (defect D8)');

  for (const [type, value] of Object.entries(PII)) {
    r.check(
      `not relayed: ${type}`,
      !appearsIn(relayedJson, value),
      `found ${JSON.stringify(value)} in a relayed payload — this would be ` +
      'persisted to chrome.storage.local and is readable by the page'
    );
  }
  r.check(
    'no prompt text relayed',
    !relayedJson.includes('Email me at'),
    'raw prompt text found in a relayed payload'
  );

  const kinds = h.kinds();
  r.check(
    'shape event relayed instead of raw body',
    kinds.includes('body-shape-captured') && !kinds.includes('raw-body-captured'),
    `kinds seen: ${kinds.join(', ')}`
  );
  r.check(
    'DEBUG_DUMP_RAW is off in the committed build',
    !kinds.some((k) => k.endsWith('-DEBUG')),
    `debug events present: ${kinds.filter((k) => k.endsWith('-DEBUG')).join(', ')}`
  );

  const mutated = h.relayed.find((m) => m.kind === 'body-mutated');
  r.check(
    'body-mutated reports 7 replacements',
    mutated && mutated.payload && mutated.payload.replacements === 7,
    `got: ${mutated && mutated.payload && mutated.payload.replacements} ` +
    `(types: ${JSON.stringify(mutated && mutated.payload && mutated.payload.typesFound)})`
  );

  r.group('multi-turn session (defect D1), through the real bundle');

  await send(h, `now email ${SECOND_EMAIL} instead`);
  await send(h, `remind me, my email is ${PII.EMAIL}`);
  await settle();

  const [, turn2, turn3] = h.sentBodies;

  r.check(
    'turn 2 mints EMAIL_PLACEHOLDER_2, not a colliding _1',
    turn2.includes('[EMAIL_PLACEHOLDER_2]') && !turn2.includes('[EMAIL_PLACEHOLDER_1]'),
    `turn 2 body: ${turn2}`
  );
  r.check(
    'turn 3 reuses _1 for the value first seen in turn 1',
    turn3.includes('[EMAIL_PLACEHOLDER_1]'),
    `turn 3 body: ${turn3}`
  );
  r.check(
    "turn 2's email never sent in plaintext",
    !turn2.includes(SECOND_EMAIL),
    `turn 2 body: ${turn2}`
  );
  r.check(
    'no PII relayed on any turn',
    !Object.values(PII).some((v) => appearsIn(h.relayedJson(), v)) &&
    !h.relayedJson().includes(SECOND_EMAIL),
    'a later turn relayed a raw value'
  );

  r.done(`kinds: ${[...new Set(h.kinds())].join(', ')}`);
}

main().catch((e) => {
  console.error('\nleak-test crashed:', e);
  process.exit(1);
});
