/**
 * pause-e2e.js — checks the pause control end to end, against the bundle.
 *
 * Pause is the one setting that switches the protection OFF, so it gets the
 * strictest treatment of anything in the interface. Three things have to
 * hold, and the third is the reason this file exists:
 *
 *   1. Masking really stops. A pause that only changed the badge would tell
 *      the user their prompts were going out raw while they were still
 *      being rewritten -- and, worse, the reverse.
 *   2. Masking really resumes.
 *   3. A pause cannot be FORGED. The setting travels over the private
 *      MessageChannel, never window.postMessage, because that channel is
 *      readable and writable by any script sharing the page's JS context.
 *      A forged "paused" there would silently disable masking while the
 *      popup and the toolbar badge went on reporting it active. That is the
 *      one failure mode where the extension actively misleads the user
 *      about whether their data is protected.
 *
 * Also asserts that restoration keeps working while paused: markers minted
 * before the pause must still be put back into replies, or pausing would
 * leave the user reading raw placeholders from earlier turns, which reads
 * as a fault rather than a setting.
 */

'use strict';

const {
  buildSandbox, loadBundle, userMessageBody, settle, createReporter, appearsIn,
  makePortPair,
} = require('./test-harness');

const EMAIL = 'dana.okafor@example.com';
/** A value the session has never tokenized, so it forces a fresh delta. */
const FRESH_EMAIL = 'ingrid.halvorsen@example.com';
const ENDPOINT = 'https://chatgpt.com/backend-api/f/conversation';
const ORIGIN = 'https://chatgpt.com';

function send(harness, prompt) {
  return harness.win.fetch(new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: userMessageBody(prompt),
  }));
}

const lastBody = (h) => h.sentBodies[h.sentBodies.length - 1] || '';
const kindsSince = (h, n) => h.relayed.slice(n).map((m) => m && m.kind);

async function main() {
  const r = createReporter('pause, end to end through the bundle');

  const harness = buildSandbox({
    sseBody: 'data: {"v":"ack [EMAIL_PLACEHOLDER_1]"}\n\ndata: [DONE]\n\n',
  });
  loadBundle(harness);

  // Hand the MAIN world its private port, the way content-bridge does.
  const [bridgeEnd, pageEnd] = makePortPair();
  harness.win.postMessage({ source: 'pii-redact-port-offer' }, ORIGIN, [pageEnd]);
  await settle();

  r.group('baseline: masking on by default');
  {
    const before = harness.relayed.length;
    await send(harness, `write to ${EMAIL} please`);
    await settle();
    r.check('starts masking without being told to',
      !appearsIn(lastBody(harness), EMAIL), 'real value left the browser on load');
    r.check('reports the substitution',
      kindsSince(harness, before).includes('body-mutated'), 'no body-mutated');
  }

  r.group('a forged pause on the page-readable channel is ignored');
  {
    // Exactly what a hostile page script can do: it can post anything it
    // likes on this channel, and it can read everything on it.
    harness.win.postMessage({ kind: 'pause', paused: true }, ORIGIN);
    harness.win.postMessage(
      { source: 'pii-redact-phase0', kind: 'pause', paused: true }, ORIGIN);
    harness.win.postMessage(
      { source: 'pii-redact-port-offer', kind: 'pause', paused: true }, ORIGIN);
    await settle();

    await send(harness, `also cc ${EMAIL}`);
    await settle();
    r.check('masking still ON after a forged pause',
      !appearsIn(lastBody(harness), EMAIL),
      'a page script switched masking off via postMessage');
  }

  r.group('a second port offer is refused');
  {
    // First offer wins. Otherwise a page script that posts its own offer
    // takes over the private channel and receives every token/value pair.
    const [attackerEnd, victimEnd] = makePortPair();
    const seen = [];
    attackerEnd.onmessage = (e) => seen.push(e.data);
    harness.win.postMessage({ source: 'pii-redact-port-offer' }, ORIGIN, [victimEnd]);
    await settle();

    // Must be a value the session has NOT seen before. A repeat reuses its
    // existing token and mints no delta, so a hijacked port would receive
    // nothing either way and the check would pass without testing anything.
    await send(harness, `and copy ${FRESH_EMAIL} too`);
    await settle();
    r.check('the turn really did mint a new token',
      !appearsIn(lastBody(harness), FRESH_EMAIL)
        && lastBody(harness).includes('PLACEHOLDER'),
      'no fresh delta was produced, so the next check would prove nothing');
    r.check('a later port offer receives no token deltas', seen.length === 0,
      `a hijacked port received ${seen.length} message(s): ${JSON.stringify(seen)}`);
  }

  r.group('pause over the private port stops masking');
  {
    const before = harness.relayed.length;
    bridgeEnd.postMessage({ kind: 'pause', paused: true });
    await settle();

    await send(harness, `urgent: ${EMAIL}`);
    await settle();

    const body = lastBody(harness);
    r.check('prompt went out exactly as typed', appearsIn(body, EMAIL),
      'masking did not actually stop');
    r.check('no marker substituted', !body.includes('PLACEHOLDER'),
      'a marker was still substituted while paused');

    const kinds = kindsSince(harness, before);
    r.check('reports that this request was not masked',
      kinds.includes('send-paused'), JSON.stringify(kinds));
    // A turn that was not masked must not be counted as one that was.
    r.check('does NOT report a substitution',
      !kinds.includes('body-mutated'),
      'counted a masked turn for a request it sent in the clear');
  }

  r.group('restoration keeps working while paused');
  {
    const response = await send(harness, 'what did I say?');
    const text = await response.text();
    await settle();
    r.check('markers from earlier turns are still restored',
      text.includes(EMAIL),
      'paused also stopped putting values back into replies');
  }

  r.group('resuming restores masking');
  {
    const before = harness.relayed.length;
    bridgeEnd.postMessage({ kind: 'pause', paused: false });
    await settle();

    await send(harness, `back on: ${EMAIL}`);
    await settle();

    r.check('masking resumed', !appearsIn(lastBody(harness), EMAIL),
      'still sending in the clear after resume');
    r.check('reports the substitution again',
      kindsSince(harness, before).includes('body-mutated'), 'no body-mutated');
  }

  r.group('malformed control messages are survivable');
  {
    for (const junk of [null, 'pause', 42, {}, { kind: 42 },
      { kind: 'pause' }, { kind: 'pause', paused: 'yes' }]) {
      bridgeEnd.postMessage(junk);
    }
    await settle();
    await send(harness, `still masking ${EMAIL}?`);
    await settle();
    r.check('junk on the port does not change the setting',
      !appearsIn(lastBody(harness), EMAIL),
      'a malformed control message switched masking off');
  }

  r.group('no value ever crossed the page-readable channel');
  r.check('postMessage log is clean', !appearsIn(harness.relayedJson(), EMAIL),
    'a real value was relayed over window.postMessage');

  r.done('pause travels only over the private port');
}

main().catch((e) => {
  console.error('\n  pause e2e threw:', e && e.stack ? e.stack : e, '\n');
  process.exit(1);
});
