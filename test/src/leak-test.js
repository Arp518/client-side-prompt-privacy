/**
 * leak-test.js — guards the single most important invariant in this project:
 *
 *   NOTHING relayed across the postMessage bridge may contain raw PII.
 *
 * inject.js runs in the page's own JS realm, so every relay() payload is
 * readable by any script on the page (ChatGPT's own included), and
 * content-bridge.js persists all of them to chrome.storage.local. A single
 * careless `relay("...", { parsed })` turns the privacy tool into a
 * privacy leak — which is exactly what Stage 2 fixed (defect D8).
 *
 * This test loads the REAL BUILT BUNDLE (dist/inject.bundle.js, not the
 * source) inside a sandboxed fake browser, pushes a request full of
 * synthetic PII through the patched fetch, and asserts:
 *
 *   1. No PII value appears in any relayed payload.
 *   2. No PII value appears in the outgoing request body.
 *   3. The outgoing body DOES contain the expected placeholders.
 *
 * Run: node src/leak-test.js   (or npm run test:leak)
 *
 * Test data is synthetic. Never put real values in this file.
 */

'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE = path.join(__dirname, '..', 'dist', 'inject.bundle.js');

// --- synthetic PII, one of each type the detector supports -----------------
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

const REQUEST_BODY = JSON.stringify({
  action: 'next',
  conversation_id: 'abc-123',
  messages: [
    {
      id: 'msg-1',
      author: { role: 'user' },
      content: { content_type: 'text', parts: [PROMPT] },
    },
  ],
});

// --- fake browser ----------------------------------------------------------

function buildSandbox() {
  const relayed = [];
  const sentBodies = [];
  let sentBody = null;

  // Stands in for ChatGPT's backend. Records what actually left the
  // "browser", and returns a minimal SSE-ish streamed response so the
  // tee()/stream path is exercised rather than skipped.
  async function originalFetch(input, init) {
    const isRequest = typeof input === 'object' && input !== null && 'url' in input;
    sentBody = isRequest ? await input.clone().text() : init?.body ?? null;
    sentBodies.push(sentBody);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"v":"hello"}\n\n data: [DONE]\n\n')
        );
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  const win = {
    fetch: originalFetch,
    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },
    postMessage(msg /*, targetOrigin */) {
      relayed.push(msg);
    },
    addEventListener() {},
  };

  const sandbox = {
    window: win,
    self: win,
    location: win.location,
    console: { log() {}, warn() {}, error() {} },
    Request,
    Response,
    Headers,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;

  return {
    sandbox,
    win,
    relayed,
    getSentBody: () => sentBody,
    getSentBodies: () => sentBodies,
  };
}

/** Build a ChatGPT-shaped request body around one user prompt. */
function bodyFor(prompt) {
  return JSON.stringify({
    action: 'next',
    conversation_id: 'abc-123',
    messages: [
      {
        id: 'msg-x',
        author: { role: 'user' },
        content: { content_type: 'text', parts: [prompt] },
      },
    ],
  });
}

// --- assertions ------------------------------------------------------------

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
  }
}

/** Every form a value might appear in: literal, and JSON-escaped. */
function appearsIn(haystack, value) {
  if (haystack.includes(value)) return true;
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped !== value && haystack.includes(escaped);
}

async function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(
      `\nBundle not found at ${BUNDLE}\nRun \`npm run build\` first.\n`
    );
    process.exit(1);
  }

  console.log('\n=== leak-test: no raw PII may cross the postMessage bridge ===\n');

  const { sandbox, win, relayed, getSentBody, getSentBodies } = buildSandbox();
  const context = vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, {
    filename: 'dist/inject.bundle.js',
  });

  check(
    'bundle patched window.fetch',
    typeof win.fetch === 'function' && win.fetch.name === 'patchedFetch',
    `got: ${win.fetch && win.fetch.name}`
  );

  const response = await win.fetch('https://chatgpt.com/backend-api/f/conversation', {
    method: 'POST',
    body: REQUEST_BODY,
    headers: { 'content-type': 'application/json' },
  });

  // Drain so the tee()'d spy branch completes and relays stream events.
  await response.text();
  await new Promise((r) => setTimeout(r, 20));

  const sentBody = getSentBody();
  const relayedJson = JSON.stringify(relayed);

  // 1. The outgoing request must be tokenized.
  check(
    'outgoing body was mutated',
    sentBody !== null && sentBody !== REQUEST_BODY,
    'body went out unchanged — detection or mutation did not run'
  );

  check(
    'outgoing body contains placeholders',
    /\[[A-Z_]+_PLACEHOLDER_\d+\]/.test(sentBody || ''),
    'no placeholder tokens found in the outgoing body'
  );

  // 2. No PII may leave in the request body.
  for (const [type, value] of Object.entries(PII)) {
    check(
      `outgoing body redacted: ${type}`,
      !appearsIn(sentBody || '', value),
      `found ${JSON.stringify(value)} in the request that left the browser`
    );
  }

  // 3. No PII may cross the bridge. This is the D8 regression guard.
  for (const [type, value] of Object.entries(PII)) {
    check(
      `bridge payloads redacted: ${type}`,
      !appearsIn(relayedJson, value),
      `found ${JSON.stringify(value)} in a relayed payload — ` +
        'this would be persisted to chrome.storage.local and is readable by the page'
    );
  }

  // The prompt itself must never be relayed wholesale, tokenized or not.
  check(
    'bridge payloads contain no prompt text',
    !relayedJson.includes('Email me at'),
    'raw prompt text found in a relayed payload'
  );

  const kinds = relayed.map((m) => m.kind);
  check(
    'shape event relayed instead of raw body',
    kinds.includes('body-shape-captured') && !kinds.includes('raw-body-captured'),
    `kinds seen: ${kinds.join(', ')}`
  );

  check(
    'DEBUG_DUMP_RAW is off in the committed build',
    !kinds.some((k) => k.endsWith('-DEBUG')),
    `debug events present: ${kinds.filter((k) => k.endsWith('-DEBUG')).join(', ')}`
  );

  const mutated = relayed.find((m) => m.kind === 'body-mutated');
  check(
    'body-mutated reports 7 replacements',
    mutated?.payload?.replacements === 7,
    `got: ${mutated?.payload?.replacements} (types: ${JSON.stringify(
      mutated?.payload?.typesFound
    )})`
  );

  // --- D1 integration: the session must span turns ------------------------
  // The unit tests cover createTokenSession() directly; this proves
  // inject.js actually holds one session across fetch calls rather than
  // tokenizing each request from scratch.
  console.log('\n  -- multi-turn (defect D1, through the real bundle) --');

  const r2 = await win.fetch('https://chatgpt.com/backend-api/f/conversation', {
    method: 'POST',
    body: bodyFor('now email bob@other-example.com instead'),
    headers: { 'content-type': 'application/json' },
  });
  await r2.text();

  const r3 = await win.fetch('https://chatgpt.com/backend-api/f/conversation', {
    method: 'POST',
    body: bodyFor(`remind me, my email is ${PII.EMAIL}`),
    headers: { 'content-type': 'application/json' },
  });
  await r3.text();
  await new Promise((r) => setTimeout(r, 20));

  const bodies = getSentBodies();

  check(
    'turn 2 mints EMAIL_PLACEHOLDER_2, not a colliding _1',
    bodies[1].includes('[EMAIL_PLACEHOLDER_2]') &&
      !bodies[1].includes('[EMAIL_PLACEHOLDER_1]'),
    `turn 2 body: ${bodies[1]}`
  );

  check(
    'turn 3 reuses _1 for the value first seen in turn 1',
    bodies[2].includes('[EMAIL_PLACEHOLDER_1]'),
    `turn 3 body: ${bodies[2]}`
  );

  check(
    'turn 2 second email never sent in plaintext',
    !bodies[1].includes('bob@other-example.com'),
    `turn 2 body: ${bodies[1]}`
  );

  check(
    'no PII leaked across the bridge on any turn',
    !Object.values(PII).some((v) => appearsIn(JSON.stringify(relayed), v)) &&
      !JSON.stringify(relayed).includes('bob@other-example.com'),
    'a later turn relayed a raw value'
  );

  console.log(
    `\n--- ${failures === 0 ? 'all checks passed' : `${failures} FAILED`} ` +
      `(relayed kinds: ${kinds.join(', ')}) ---\n`
  );
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\nleak-test crashed:', e);
  process.exit(1);
});
