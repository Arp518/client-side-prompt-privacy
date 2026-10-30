'use strict';

const { findTextLocations } = require('./payload-adapters');

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

// --- 1. Real confirmed shape: messages[].content.parts[] -------------------
{
  const body = {
    messages: [
      { author: { role: 'user' }, content: { content_type: 'text', parts: ['hii'] } },
    ],
  };
  const locs = findTextLocations(body);
  check('parts[] shape: finds 1 location', locs.length === 1);
  check('parts[] shape: get() returns original text', locs[0]?.get() === 'hii');
  locs[0].set('[GREETING_PLACEHOLDER_1]');
  check(
    'parts[] shape: set() mutates the original object in place',
    body.messages[0].content.parts[0] === '[GREETING_PLACEHOLDER_1]'
  );
}

// --- 2. Defensive flat-content shape ---------------------------------------
{
  const body = {
    messages: [{ author: { role: 'user' }, content: 'call me at 555-123-4567' }],
  };
  const locs = findTextLocations(body);
  check('flat content shape: finds 1 location', locs.length === 1);
  locs[0].set('call me at [PHONE_PLACEHOLDER_1]');
  check(
    'flat content shape: set() mutates in place',
    body.messages[0].content === 'call me at [PHONE_PLACEHOLDER_1]'
  );
}

// --- 3. Unknown shape -> zero locations, no throw --------------------------
{
  const body = { conduit_token: 'abc123', status: 'ok' }; // /conversation/prepare shape
  let threw = false;
  let locs = [];
  try {
    locs = findTextLocations(body);
  } catch (e) {
    threw = true;
  }
  check('prepare-like shape: does not throw', !threw);
  check('prepare-like shape: finds 0 locations', locs.length === 0);
}

// --- 4. Multiple messages / multiple parts ----------------------------------
{
  const body = {
    messages: [
      { content: { parts: ['first'] } },
      { content: { parts: ['second', 'third'] } },
    ],
  };
  const locs = findTextLocations(body);
  check('multi-message: finds all 3 locations', locs.length === 3);
  check(
    'multi-message: values read in order',
    locs.map((l) => l.get()).join(',') === 'first,second,third'
  );
}

// --- 5. Null/garbage input doesn't throw ------------------------------------
{
  let threw = false;
  try {
    findTextLocations(null);
    findTextLocations(undefined);
    findTextLocations('not an object');
    findTextLocations(42);
  } catch (e) {
    threw = true;
  }
  check('garbage input: does not throw', !threw);
}

// --- 6. Exact-pathname endpoint matching -----------------------------------
// Importing the real function from request-interceptor.js rather than a
// duplicated copy, so this test actually exercises the shipped code.
{
  const { isTargetEndpoint } = require('./request-interceptor');

  // isTargetEndpoint() calls `new URL(s, location.origin)`, but this file
  // runs under Node, not a browser, so `location` doesn't exist yet. Stub
  // just enough of it for URL resolution to work.
  global.location = { origin: 'https://chatgpt.com' };

  check(
    'exact match: real endpoint matches',
    isTargetEndpoint('https://chatgpt.com/backend-api/f/conversation') === true
  );
  check(
    'exact match: /prepare no longer matches (this was the bug)',
    isTargetEndpoint('https://chatgpt.com/backend-api/f/conversation/prepare') === false
  );
  check(
    'exact match: autocompletions no longer matches',
    isTargetEndpoint(
      'https://chatgpt.com/backend-api/f/conversation/experimental/generate_autocompletions'
    ) === false
  );
  check(
    'exact match: conversations-list no longer matches',
    isTargetEndpoint('https://chatgpt.com/backend-api/conversations?offset=0') === false
  );
  check(
    'exact match: stream_status no longer matches',
    isTargetEndpoint('https://chatgpt.com/backend-api/f/conversation/abc123/stream_status') ===
      false
  );

  delete global.location;
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail > 0 ? 1 : 0);
