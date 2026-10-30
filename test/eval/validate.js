/**
 * validate.js — structural checks on the labelled dataset.
 *
 * The scorer treats these labels as ground truth, so a bad label does not
 * throw — it silently reports a correct detection as a miss. Everything
 * here is a guard against a wrong number rather than a crash.
 *
 * Also writes eval/dataset.json as a plain artifact, so the dataset can be
 * read, diffed and shared without running the authoring DSL.
 *
 * Run: node eval/validate.js   (or npm run eval:validate)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { prompts } = require('./dataset');
const { detectPII } = require('../src/detector');

/** Types detector.js can actually emit today. */
const IMPLEMENTED = new Set([
  'SECRET',
  'EMAIL',
  'PHONE',
  'SSN',
  'CREDIT_CARD',
  'IPV4',
  'IPV6',
  'DOB',
  'STREET_ADDRESS',
]);

/** Labelled deliberately ahead of the code. Zero recall is expected. */
const PLANNED = new Set(['PERSON', 'ORG', 'LOCATION']);

const errors = [];
const warnings = [];
const seenIds = new Set();

for (const item of prompts) {
  const where = `${item.id}`;

  if (seenIds.has(item.id)) errors.push(`${where}: duplicate id`);
  seenIds.add(item.id);

  if (!item.text || typeof item.text !== 'string') {
    errors.push(`${where}: missing text`);
    continue;
  }
  if (item.bucket !== 'short_factual' && item.bucket !== 'open_ended') {
    errors.push(`${where}: bad bucket ${JSON.stringify(item.bucket)}`);
  }
  if (item.text.includes('{{') || item.text.includes('}}')) {
    errors.push(`${where}: unexpanded marker left in text`);
  }

  let lastEnd = -1;
  for (const span of item.spans) {
    // The check that matters: does the offset actually point at the value?
    const sliced = item.text.slice(span.start, span.end);
    if (sliced !== span.value) {
      errors.push(
        `${where}: offset mismatch — text.slice(${span.start},${span.end}) is ` +
        `${JSON.stringify(sliced)} but value is ${JSON.stringify(span.value)}`
      );
    }
    if (!IMPLEMENTED.has(span.type) && !PLANNED.has(span.type)) {
      errors.push(`${where}: unknown type ${span.type}`);
    }
    if (span.start < lastEnd) {
      errors.push(`${where}: spans overlap or are out of order at ${span.start}`);
    }
    lastEnd = span.end;
  }

  // A decoy that is not actually in the text is a typo, and it would
  // quietly stop testing the thing it was written to test.
  for (const neg of item.negatives) {
    if (!item.text.includes(neg)) {
      errors.push(`${where}: negative ${JSON.stringify(neg)} does not appear in the text`);
    }
    const overlapsGold = item.spans.some((s) => s.value.includes(neg) || neg.includes(s.value));
    if (overlapsGold) {
      errors.push(`${where}: negative ${JSON.stringify(neg)} overlaps a labelled span`);
    }
  }
}

// --- coverage -------------------------------------------------------------

const byType = {};
const byBucket = { short_factual: 0, open_ended: 0 };
let withNegatives = 0;
let cleanPrompts = 0;

for (const item of prompts) {
  byBucket[item.bucket] = (byBucket[item.bucket] || 0) + 1;
  if (item.negatives.length) withNegatives++;
  if (item.spans.length === 0) cleanPrompts++;
  for (const s of item.spans) byType[s.type] = (byType[s.type] || 0) + 1;
}

const negativeShare = prompts.length ? withNegatives / prompts.length : 0;
if (negativeShare < 0.25) {
  warnings.push(
    `only ${(negativeShare * 100).toFixed(0)}% of prompts carry a decoy — ` +
    'precision will read higher than it deserves (target ~40%)'
  );
}
for (const t of IMPLEMENTED) {
  if (!byType[t]) warnings.push(`no labelled spans for implemented type ${t}`);
}
if (cleanPrompts === 0) {
  warnings.push('no clean prompts — nothing measures false positives on ordinary text');
}

// --- report ---------------------------------------------------------------

console.log('\n=== dataset validation ===\n');
console.log(`  prompts        ${prompts.length}`);
console.log(`  buckets        short_factual ${byBucket.short_factual} · open_ended ${byBucket.open_ended}`);
console.log(`  clean prompts  ${cleanPrompts}`);
console.log(`  with decoys    ${withNegatives} (${(negativeShare * 100).toFixed(0)}%)`);
console.log(`  spans          ${Object.values(byType).reduce((a, b) => a + b, 0)}`);
console.log('');
console.log('  labelled spans by type');
for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  const tag = IMPLEMENTED.has(type) ? '' : '   (not implemented yet)';
  console.log(`    ${type.padEnd(16)} ${String(n).padStart(3)}${tag}`);
}

// A decoy the detector currently fires on is a real false positive. Surfacing
// it here — not just in the scorer — makes the dataset self-documenting about
// which weaknesses are known.
const trippedDecoys = [];
for (const item of prompts) {
  if (!item.negatives.length) continue;
  const found = detectPII(item.text);
  for (const neg of item.negatives) {
    const hit = found.find((s) => s.value === neg || neg.includes(s.value) || s.value.includes(neg));
    if (hit) trippedDecoys.push(`${item.id}: ${hit.type} fired on ${JSON.stringify(neg)}`);
  }
}
if (trippedDecoys.length) {
  console.log(`\n  decoys the detector currently trips on (${trippedDecoys.length}):`);
  for (const line of trippedDecoys) console.log(`    ${line}`);
}

if (warnings.length) {
  console.log(`\n  warnings (${warnings.length}):`);
  for (const w of warnings) console.log(`    ! ${w}`);
}

if (errors.length) {
  console.log(`\n  ERRORS (${errors.length}):`);
  for (const e of errors) console.log(`    x ${e}`);
  console.log('\n--- dataset INVALID ---\n');
  process.exit(1);
}

const outPath = path.join(__dirname, 'dataset.json');
fs.writeFileSync(
  outPath,
  JSON.stringify({ version: 1, generated: new Date().toISOString().slice(0, 10), prompts }, null, 2) + '\n'
);
console.log(`\n--- dataset valid · wrote ${path.relative(process.cwd(), outPath)} ---\n`);

module.exports = { IMPLEMENTED, PLANNED };
