/**
 * tokenizer-test.js — regression assertions for Stage 3.
 *
 * smoke.js is a readable round-trip demo; this file is the guard rail.
 * Every case here corresponds to a defect that was live in the codebase,
 * so a failure means a real bug came back, not that a style changed.
 *
 * Covers:
 *   D1  cross-message placeholder collision (silent data corruption)
 *   D11 credit-card recall loss + the precision cost of fixing it
 *   D12 detokenize() missing common model formatting variants
 *
 * Run: node src/tokenizer-test.js   (or npm run test:tokenizer)
 *
 * All values here are synthetic.
 */

'use strict';

const { detectPII } = require('./detector');
const {
  tokenize,
  detokenize,
  createTokenSession,
  classifyEcho,
} = require('./tokenizer');

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
}

function assert(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${e}`);
    console.log(`        actual:   ${a}`);
  }
}

function assertTrue(label, condition, detail) {
  assert(label, condition === true, true);
  if (condition !== true && detail) console.log(`        ${detail}`);
}

// ===========================================================================
group('D1 — cross-message collision (the bug that corrupted turn 1)');
// ===========================================================================
{
  // Reproduces the exact failure: two turns, same PII type, different values.
  // Before the session tokenizer, both turns minted EMAIL_PLACEHOLDER_1 and
  // the merged map kept only the last one, so turn 1 restored to bob.
  const s = createTokenSession();
  const t1 = s.tokenize('mail alice@x.com');
  const t2 = s.tokenize('mail bob@y.com');

  assert('turn 1 gets _1', t1.tokenizedText, 'mail [EMAIL_PLACEHOLDER_1]');
  assert('turn 2 gets _2, not a second _1', t2.tokenizedText, 'mail [EMAIL_PLACEHOLDER_2]');
  assert('turn 1 restores to alice', s.detokenize(t1.tokenizedText), 'mail alice@x.com');
  assert('turn 2 restores to bob', s.detokenize(t2.tokenizedText), 'mail bob@y.com');

  const map = s.getMap();
  const values = Object.values(map);
  assertTrue(
    'no token maps to two different values',
    new Set(Object.keys(map)).size === Object.keys(map).length &&
    new Set(values).size === values.length
  );
}

{
  // A repeated value must reuse its token. Without this you cannot tell
  // "the model paraphrased" from "the model reused an earlier token",
  // which is the measurement the project exists to make.
  const s = createTokenSession();
  s.tokenize('first alice@x.com');
  const again = s.tokenize('later alice@x.com again');

  assert('repeat value reuses token', again.tokenizedText, 'later [EMAIL_PLACEHOLDER_1] again');
  assert('repeat mints no new mapping', again.map, {});
  assert('session holds one entry', s.stats().tokenCount, 1);
}

{
  // Counters are per type and monotonic across turns.
  const s = createTokenSession();
  s.tokenize('a@x.com and 555-123-4567');
  const t2 = s.tokenize('b@y.com and 555-987-6543');
  assert('per-type counters advance independently', t2.tokenizedText,
    '[EMAIL_PLACEHOLDER_2] and [PHONE_PLACEHOLDER_2]');
}

{
  // Guards the _1 / _11 prefix hazard: [X_1] is not a prefix of [X_11]
  // because of the closing bracket, but assert it rather than assume it.
  const s = createTokenSession();
  let text = '';
  for (let i = 1; i <= 12; i++) text += `user${i}@x.com `;
  const out = s.tokenize(text.trim());
  assert('12 distinct emails get 12 tokens', Object.keys(out.map).length, 12);
  assert('round-trip survives double-digit tokens',
    s.detokenize(out.tokenizedText), text.trim());
}

{
  // reset() must clear counters too, not just the map.
  const s = createTokenSession();
  s.tokenize('a@x.com');
  s.reset();
  const after = s.tokenize('b@y.com');
  assert('reset restarts numbering', after.tokenizedText, '[EMAIL_PLACEHOLDER_1]');
}

// ===========================================================================
group('D1 — stateless tokenize() still behaves as before');
// ===========================================================================
{
  const r = tokenize('mail alice@x.com');
  assert('stateless still starts at _1', r.tokenizedText, 'mail [EMAIL_PLACEHOLDER_1]');
  assert('stateless round-trips', detokenize(r.tokenizedText, r.map), 'mail alice@x.com');
}

// ===========================================================================
group('D11 — credit-card recall and precision');
// ===========================================================================
{
  const card = (t) => detectPII(t).filter((s) => s.type === 'CREDIT_CARD').map((s) => s.value);

  // Recall: these were silently dropped. The greedy match swallowed the
  // neighbouring digits, Luhn failed on the combined run, and a real card
  // left the browser unmasked.
  assert('card glued to leading digits', card('id 99 4111111111111111 done'), ['4111111111111111']);
  assert('card after another long number', card('ref 1234567890123 4111111111111111'), ['4111111111111111']);

  // Still detects the straightforward cases.
  assert('plain Visa', card('my card is 4111111111111111'), ['4111111111111111']);
  assert('spaced Visa', card('card 4111 1111 1111 1111 expires'), ['4111 1111 1111 1111']);
  assert('Amex 15-digit', card('amex 378282246310005 ok'), ['378282246310005']);
  assert('Mastercard', card('mc 5555555555554444 ok'), ['5555555555554444']);

  // Precision: the windowed retry must not carve fake cards out of any
  // long digit run that happens to contain a Luhn-valid substring.
  assert('generic 16-digit number', card('invalid 1234567890123456 here'), []);
  assert('USPS tracking number', card('tracking 9400111899223817612089'), []);
  assert('10-digit phone', card('order 5551234567 only'), []);
}

{
  // Every span must slice back to its own value, or downstream offset
  // arithmetic in tokenize() corrupts the text.
  const samples = [
    'id 99 4111111111111111 done',
    'card 4111 1111 1111 1111 expires',
    'amex 378282246310005 and mail a@x.com',
  ];
  let allOk = true;
  for (const text of samples) {
    for (const span of detectPII(text)) {
      if (text.slice(span.start, span.end) !== span.value) allOk = false;
    }
  }
  assertTrue('all span offsets slice back to their value', allOk);
}

// ===========================================================================
group('D12 — detokenize() against real model formatting variants');
// ===========================================================================
{
  const map = { '[EMAIL_PLACEHOLDER_1]': 'alice@x.com' };
  const restored = (s, opts) => detokenize(s, map, opts).includes('alice@x.com');

  // Strict mode: only a canonical token counts as a verbatim echo.
  assertTrue('strict: exact token', restored('[EMAIL_PLACEHOLDER_1]'));
  assertTrue('strict: bold-wrapped', restored('**[EMAIL_PLACEHOLDER_1]**'));
  assertTrue('strict: code-fenced', restored('`[EMAIL_PLACEHOLDER_1]`'));
  assertTrue('strict: rejects spaced', !restored('[ EMAIL_PLACEHOLDER_1 ]'));
  assertTrue('strict: rejects bracket-stripped', !restored('EMAIL_PLACEHOLDER_1'));
  assertTrue('strict: rejects markdown-escaped', !restored('[EMAIL\\_PLACEHOLDER\\_1]'));

  // Tolerant mode recovers the formatting variants.
  const t = { tolerant: true };
  assertTrue('tolerant: spaced', restored('[ EMAIL_PLACEHOLDER_1 ]', t));
  assertTrue('tolerant: bracket-stripped', restored('EMAIL_PLACEHOLDER_1', t));
  assertTrue('tolerant: markdown-escaped', restored('[EMAIL\\_PLACEHOLDER\\_1]', t));
  assertTrue('tolerant: still handles exact', restored('[EMAIL_PLACEHOLDER_1]', t));
  assertTrue('tolerant: inside a sentence', restored('Write to EMAIL_PLACEHOLDER_1 today.', t));

  // Safety: tolerant mode must never invent a substitution for a token
  // that is not in the map.
  assert('tolerant: unknown token left alone',
    detokenize('[EMAIL_PLACEHOLDER_9]', map, t), '[EMAIL_PLACEHOLDER_9]');
  assert('tolerant: unrelated prose untouched',
    detokenize('the PLACEHOLDER pattern', map, t), 'the PLACEHOLDER pattern');
  assert('empty map is a no-op', detokenize('[EMAIL_PLACEHOLDER_1]', {}), '[EMAIL_PLACEHOLDER_1]');
}

{
  // Types containing underscores must survive the regex backtracking.
  const map = {
    '[CREDIT_CARD_PLACEHOLDER_1]': '4111 1111 1111 1111',
    '[STREET_ADDRESS_PLACEHOLDER_2]': '742 Evergreen Terrace',
  };
  assert('multi-underscore type, strict',
    detokenize('pay with [CREDIT_CARD_PLACEHOLDER_1]', map),
    'pay with 4111 1111 1111 1111');
  assert('multi-underscore type, tolerant',
    detokenize('ship to [ STREET_ADDRESS_PLACEHOLDER_2 ]', map, { tolerant: true }),
    'ship to 742 Evergreen Terrace');
  assert('two different types in one string',
    detokenize('[CREDIT_CARD_PLACEHOLDER_1] at [STREET_ADDRESS_PLACEHOLDER_2]', map),
    '4111 1111 1111 1111 at 742 Evergreen Terrace');
}

// ===========================================================================
group('Phase 6 — detector fixes found by the eval harness');
// ===========================================================================
{
  const of = (type) => (t) => detectPII(t).filter((s) => s.type === type).map((s) => s.value);
  const addr = of('STREET_ADDRESS');
  const card = of('CREDIT_CARD');
  const phone = of('PHONE');
  const ip = of('IPV4');
  const secret = of('SECRET');

  // The trailing \.? meant for "Baker St." also swallowed the period ending
  // the sentence, so tokenizing left the model a sentence with no terminator.
  assert('address stops before the sentence period', addr('I live at 742 Evergreen Terrace.'),
    ['742 Evergreen Terrace']);
  assert('address still found mid-sentence', addr('Ship it to 221 Baker Street, apt 4.'),
    ['221 Baker Street']);

  // The windowed retry carved a Luhn-valid 13-digit Visa out of a 15-digit
  // IMEI. A real card shares a digit run as a WHOLE group, never as a cut
  // through the middle of one.
  assert('no card carved out of an IMEI', card('The IMEI is 490154203237518 here'), []);
  assert('card still found beside junk digits', card('id 99 4111111111111111 done'),
    ['4111111111111111']);
  assert('card still found in spaced groups', card('card 4111 1111 1111 1111 expires'),
    ['4111 1111 1111 1111']);

  // Ten bare digits are shape-identical to an order or case id. Punctuated
  // forms are taken on sight; bare runs need nearby wording that says phone.
  assert('punctuated phone', phone('Call me on 555-123-4567.'), ['555-123-4567']);
  assert('parenthesised phone', phone('My number is (555) 987-6543 after six.'), ['(555) 987-6543']);
  // Bare ten-digit runs are matched unconditionally. Context gating was
  // tried and reverted: a false negative is a leak, a false positive is an
  // annoyance, and an Indian mobile is normally written bare with no cue.
  assert('bare digits, no context needed', phone('no.9876543210'), ['9876543210']);
  assert('bare digits mid-sentence', phone('my number is 9876543210'), ['9876543210']);
  // The accepted cost of that choice — order numbers get masked too.
  assert('order number also matches, by design',
    phone('Order number 5551234567 has not shipped.'), ['5551234567']);

  // A dotted quad is the same shape as a version string; only surrounding
  // wording separates them.
  assert('real IP detected', ip('The server is at 192.168.1.100.'), ['192.168.1.100']);
  assert('version string ignored', ip('We are on version 1.2.3.4 of the client.'), []);
  assert('upgrade context ignored', ip('Upgrade from 10.15.7.1 to the latest build.'), []);

  // Credentials: prefix-anchored, no generic entropy rule.
  const K = (...parts) => parts.join('');
  assert('AWS key', secret(`key ${K('AKIA', 'IOSFODNN7', 'EXAMPLE')} here`),
    [K('AKIA', 'IOSFODNN7', 'EXAMPLE')]);
  assert('GitHub token', secret(`token ${K('ghp_', '1234567890abcdefghij', 'klmnopqrstuvwx')} here`),
    [K('ghp_', '1234567890abcdefghij', 'klmnopqrstuvwx')]);
  assertTrue('JWT detected',
    secret(`${K('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.dQw4w9WgXcQabcdefghij')}`).length === 1);

  // A commit hash and a UUID are high-entropy but are not credentials.
  // Flagging them would mask half of every technical conversation.
  assert('git SHA is not a secret', secret('commit 4f9a2b1c8d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a broke it'), []);
  assert('UUID is not a secret', secret('id 550e8400-e29b-41d4-a716-446655440000 here'), []);
  assert('env var name is not a secret', secret('Set GITHUB_TOKEN before running.'), []);

  // A credential contains digit runs that PHONE would otherwise claim.
  // Masking half a token protects nothing and corrupts it, so SECRET wins.
  {
    const t = `token ${K('ghp_', '1234567890abcdefghij', 'klmnopqrstuvwx')} failed`;
    assert('SECRET outranks PHONE inside a token',
      detectPII(t).map((s) => s.type), ['SECRET']);
  }
}

// ===========================================================================
group('classifyEcho — separates verbatim from variant from absent');
// ===========================================================================
{
  const T = '[EMAIL_PLACEHOLDER_1]';
  assert('verbatim', classifyEcho(`Dear ${T}, hello`, T), 'verbatim');
  assert('verbatim when bolded', classifyEcho(`**${T}**`, T), 'verbatim');
  assert('variant when spaced', classifyEcho('[ EMAIL_PLACEHOLDER_1 ]', T), 'variant');
  assert('variant when brackets dropped', classifyEcho('mail EMAIL_PLACEHOLDER_1', T), 'variant');
  assert('absent when paraphrased', classifyEcho('I sent it to your address.', T), 'absent');
  assert('absent on a different token', classifyEcho('[EMAIL_PLACEHOLDER_2]', T), 'absent');
}

// ===========================================================================
console.log(
  `\n--- ${passed} passed, ${failed} failed ---\n`
);
process.exit(failed > 0 ? 1 : 0);
