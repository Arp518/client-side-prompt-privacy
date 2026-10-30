'use strict';

const { isValidPhase0Message } = require('./message-validator');

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) {
    pass++;
    console.log(`  OK   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

const FAKE_WINDOW = { fake: 'window-object' };
const OTHER_WINDOW = { other: 'window-object' };

function ev(data, source = FAKE_WINDOW) {
  return { source, data };
}

// --- Valid messages, one per kind actually used by inject.js ---------------
check(
  'valid injector-ready passes',
  isValidPhase0Message(
    ev({ source: 'pii-redact-phase0', kind: 'injector-ready', payload: { url: 'https://chatgpt.com/' } }),
    FAKE_WINDOW
  ) === true
);

check(
  'valid body-mutated passes',
  isValidPhase0Message(
    ev({
      source: 'pii-redact-phase0',
      kind: 'body-mutated',
      payload: { replacements: 2, matchTypeCounts: { EMAIL: 1, PHONE: 1 }, locationsMutated: 1 },
    }),
    FAKE_WINDOW
  ) === true
);

// --- Wrong event.source (not the same window) -------------------------------
check(
  'wrong event.source is rejected',
  isValidPhase0Message(
    ev({ source: 'pii-redact-phase0', kind: 'injector-ready', payload: { url: 'x' } }, OTHER_WINDOW),
    FAKE_WINDOW
  ) === false
);

// --- Wrong/missing source string --------------------------------------------
check(
  'spoofed source string is rejected',
  isValidPhase0Message(
    ev({ source: 'some-other-extension', kind: 'injector-ready', payload: { url: 'x' } }),
    FAKE_WINDOW
  ) === false
);

check(
  'missing source field is rejected',
  isValidPhase0Message(ev({ kind: 'injector-ready', payload: { url: 'x' } }), FAKE_WINDOW) === false
);

// --- Unknown kind ------------------------------------------------------------
check(
  'unknown kind is rejected',
  isValidPhase0Message(
    ev({ source: 'pii-redact-phase0', kind: 'inject-arbitrary-storage-write', payload: {} }),
    FAKE_WINDOW
  ) === false
);

// --- Malformed payload for a known kind -------------------------------------
check(
  'body-mutated with wrong field types is rejected',
  isValidPhase0Message(
    ev({
      source: 'pii-redact-phase0',
      kind: 'body-mutated',
      payload: { replacements: 'two', matchTypeCounts: 'not-an-object', locationsMutated: 1 },
    }),
    FAKE_WINDOW
  ) === false
);

check(
  'body-mutated with extra/malicious fields but valid required shape still passes',
  // Extra fields are allowed through (validators check required fields
  // exist with the right type, not that no other fields exist) — the
  // point is structural validity, not an allowlist of every key.
  isValidPhase0Message(
    ev({
      source: 'pii-redact-phase0',
      kind: 'body-mutated',
      payload: {
        replacements: 1,
        matchTypeCounts: { EMAIL: 1 },
        locationsMutated: 1,
        __proto__: { polluted: true }, // should not cause a throw
      },
    }),
    FAKE_WINDOW
  ) === true
);

// --- Missing payload entirely -------------------------------------------------
check(
  'missing payload is rejected',
  isValidPhase0Message(ev({ source: 'pii-redact-phase0', kind: 'injector-ready' }), FAKE_WINDOW) ===
    false
);

check(
  'null payload is rejected',
  isValidPhase0Message(
    ev({ source: 'pii-redact-phase0', kind: 'injector-ready', payload: null }),
    FAKE_WINDOW
  ) === false
);

// --- Garbage event.data --------------------------------------------------------
check('null event.data does not throw', isValidPhase0Message(ev(null), FAKE_WINDOW) === false);
check(
  'string event.data does not throw',
  isValidPhase0Message(ev('not an object'), FAKE_WINDOW) === false
);
check(
  'event.data with no kind field is rejected',
  isValidPhase0Message(ev({ source: 'pii-redact-phase0', payload: {} }), FAKE_WINDOW) === false
);

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail > 0 ? 1 : 0);
