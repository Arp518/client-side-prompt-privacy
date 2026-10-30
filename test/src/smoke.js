'use strict';

const { detectPII } = require('./detector');
const { tokenize, detokenize } = require('./tokenizer');

const cases = [
  {
    label: 'email',
    text: 'Reach me at ayush.dev+test@gmail.com for the docs.',
  },
  {
    label: 'phone (dashed)',
    text: 'Call me at 555-123-4567 tomorrow.',
  },
  {
    label: 'phone (paren)',
    text: 'Office line is (415) 867-5309.',
  },
  {
    label: 'ssn',
    text: 'My SSN is 123-45-6789, keep it safe.',
  },
  {
    label: 'credit card (valid luhn, spaced)',
    text: 'Card number: 4111 1111 1111 1111 expires next year.',
  },
  {
    label: 'credit card (invalid luhn, should NOT match)',
    text: 'Random long number: 1234 5678 9012 3456 not a real card.',
  },
  {
    label: 'ipv4',
    text: 'The server lives at 192.168.1.100 behind the firewall.',
  },
  {
    label: 'ipv6',
    text: 'Full address: 2001:0db8:85a3:0000:0000:8a2e:0370:7334 for the host.',
  },
  {
    label: 'dob (with context)',
    text: 'I was born 04/12/1998 in Mumbai.',
  },
  {
    label: 'date without birth context (should NOT match as DOB)',
    text: 'The meeting is scheduled for 04/12/2026.',
  },
  {
    label: 'street address',
    text: 'Ship it to 221 Baker Street, apt 4.',
  },
  {
    label: 'mixed, multiple of same type',
    text: 'Email me at a@x.com or backup b@y.com, both work.',
  },
  {
    label: 'clean text, nothing to detect',
    text: 'What is the capital of France?',
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const spans = detectPII(c.text);
  const { tokenizedText, map } = tokenize(c.text);
  const restored = detokenize(tokenizedText, map);
  const roundTripOk = restored === c.text;

  console.log(`\n[${c.label}]`);
  console.log('  input:      ', c.text);
  console.log('  spans:      ', spans.map((s) => `${s.type}:"${s.value}"`).join(', ') || '(none)');
  console.log('  tokenized:  ', tokenizedText);
  console.log('  round-trip: ', roundTripOk ? 'OK' : `FAILED (got: "${restored}")`);

  if (roundTripOk) pass++;
  else fail++;
}

console.log(`\n--- ${pass} passed, ${fail} failed (round-trip only — no precision/recall, no ground truth) ---`);
process.exit(fail > 0 ? 1 : 0);