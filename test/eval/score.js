/**
 * score.js — precision / recall / F1 for the detector against the labelled
 * dataset.
 *
 * Why this exists: until now every claim about detection quality rested on
 * hand-picked examples. The credit-card bug is the cautionary tale — it
 * looked fine while silently dropping valid cards. A privacy tool whose
 * recall has never been measured is a privacy tool nobody should trust.
 *
 * Two matching modes are reported, deliberately:
 *
 *   exact    span boundaries must line up character for character
 *   overlap  same type, any character overlap
 *
 * Neither alone is honest. Exact-only understates boundary-heavy types like
 * STREET_ADDRESS, where catching "742 Evergreen Terrace" but including a
 * trailing period reads as a total miss. Overlap-only hides real problems,
 * because matching one character of a credit card is not protecting it.
 *
 * Implemented and not-yet-implemented types are reported separately. The
 * dataset labels SECRET / PERSON / ORG / LOCATION ahead of the code, so
 * folding their guaranteed-zero recall into one headline number would make
 * the detector look broken rather than incomplete.
 *
 * Run:  node eval/score.js              print the report
 *       node eval/score.js --save       write eval/baseline.json
 *       node eval/score.js --check      fail if worse than the baseline
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { prompts } = require('./dataset');
const { detectPII } = require('../src/detector');

const IMPLEMENTED = [
  'EMAIL',
  'PHONE',
  'SSN',
  'CREDIT_CARD',
  'IPV4',
  'IPV6',
  'DOB',
  'STREET_ADDRESS',
];
const PLANNED = ['SECRET', 'PERSON', 'ORG', 'LOCATION'];

const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const FAILURES_PATH = path.join(__dirname, 'failures.json');

/** Allow a small regression so noise doesn't block work; catch real drops. */
const F1_TOLERANCE = 0.02;

const argv = process.argv.slice(2);
const SAVE = argv.includes('--save');
const CHECK = argv.includes('--check');

// --- matching -------------------------------------------------------------

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const exact = (a, b) => a.start === b.start && a.end === b.end;

/**
 * Greedy one-to-one pairing of gold spans to predictions of the same type.
 * Returns the unpaired remainder on each side.
 */
function match(gold, predicted, mode) {
  const usedPred = new Set();
  const tp = [];
  const fn = [];

  for (const g of gold) {
    let hit = -1;
    for (let i = 0; i < predicted.length; i++) {
      if (usedPred.has(i)) continue;
      const pr = predicted[i];
      if (pr.type !== g.type) continue;
      if (mode === 'exact' ? exact(g, pr) : overlaps(g, pr)) {
        hit = i;
        break;
      }
    }
    if (hit === -1) fn.push(g);
    else {
      usedPred.add(hit);
      tp.push({ gold: g, pred: predicted[hit] });
    }
  }

  const fp = predicted.filter((_, i) => !usedPred.has(i));
  return { tp, fp, fn };
}

function prf(tp, fp, fn) {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

const pct = (v) => (v === null ? '   —  ' : `${(v * 100).toFixed(1)}%`.padStart(6));

// --- run ------------------------------------------------------------------

function run(mode) {
  const perType = {};
  const perBucket = {};
  const failures = { falsePositives: [], falseNegatives: [] };

  const bump = (bag, key, field) => {
    if (!bag[key]) bag[key] = { tp: 0, fp: 0, fn: 0 };
    bag[key][field]++;
  };

  for (const item of prompts) {
    const predicted = detectPII(item.text);
    const { tp, fp, fn } = match(item.spans, predicted, mode);

    // Bucket rows count implemented types only, matching the OVERALL row.
    // Including the deliberately-unimplemented types here would mix "we
    // have not built this yet" into a number meant to show how the detector
    // performs on prose length, making the two rows incomparable.
    const counts = (type) => IMPLEMENTED.includes(type);

    for (const t of tp) {
      bump(perType, t.gold.type, 'tp');
      if (counts(t.gold.type)) bump(perBucket, item.bucket, 'tp');
    }
    for (const f of fp) {
      bump(perType, f.type, 'fp');
      if (counts(f.type)) bump(perBucket, item.bucket, 'fp');
      failures.falsePositives.push({
        id: item.id,
        type: f.type,
        value: f.value,
        wasDecoy: item.negatives.some((n) => n.includes(f.value) || f.value.includes(n)),
        context: item.text.slice(Math.max(0, f.start - 25), f.end + 25),
      });
    }
    for (const f of fn) {
      bump(perType, f.type, 'fn');
      if (counts(f.type)) bump(perBucket, item.bucket, 'fn');
      failures.falseNegatives.push({
        id: item.id,
        type: f.type,
        value: f.value,
        planned: PLANNED.includes(f.type),
        context: item.text.slice(Math.max(0, f.start - 25), f.end + 25),
      });
    }
  }

  const scored = {};
  for (const [type, c] of Object.entries(perType)) scored[type] = prf(c.tp, c.fp, c.fn);

  const buckets = {};
  for (const [b, c] of Object.entries(perBucket)) buckets[b] = prf(c.tp, c.fp, c.fn);

  // Micro over implemented types only — that is the real scoreboard.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const t of IMPLEMENTED) {
    const c = perType[t];
    if (!c) continue;
    tp += c.tp;
    fp += c.fp;
    fn += c.fn;
  }

  return { mode, perType: scored, buckets, overall: prf(tp, fp, fn), failures };
}

// --- report ---------------------------------------------------------------

function printTable(title, rows) {
  console.log(`\n  ${title}`);
  console.log('    type              TP  FP  FN   precision  recall     F1');
  console.log('    ' + '-'.repeat(58));
  for (const [type, s] of rows) {
    console.log(
      `    ${type.padEnd(16)}` +
        `${String(s.tp).padStart(3)} ${String(s.fp).padStart(3)} ${String(s.fn).padStart(3)}   ` +
        `${pct(s.precision)}    ${pct(s.recall)}   ${pct(s.f1)}`
    );
  }
}

const exactRun = run('exact');
const overlapRun = run('overlap');

console.log('\n=== detector evaluation ===');
console.log(`\n  ${prompts.length} prompts · ${prompts.reduce((n, p) => n + p.spans.length, 0)} labelled spans`);

for (const r of [exactRun, overlapRun]) {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  MATCH MODE: ${r.mode}`);

  const impl = IMPLEMENTED.filter((t) => r.perType[t]).map((t) => [t, r.perType[t]]);
  printTable('implemented types', impl);

  const planned = PLANNED.filter((t) => r.perType[t]).map((t) => [t, r.perType[t]]);
  if (planned.length) {
    printTable('not yet implemented (zero recall expected)', planned);
  }

  const o = r.overall;
  console.log(
    `\n    OVERALL (implemented)  TP ${o.tp}  FP ${o.fp}  FN ${o.fn}   ` +
      `P ${pct(o.precision)}  R ${pct(o.recall)}  F1 ${pct(o.f1)}`
  );

  console.log('\n  by prompt bucket');
  for (const [b, s] of Object.entries(r.buckets)) {
    console.log(`    ${b.padEnd(16)} P ${pct(s.precision)}  R ${pct(s.recall)}  F1 ${pct(s.f1)}`);
  }
}

// Failures from overlap mode: exact-mode FPs are mostly boundary noise,
// while an overlap-mode FP is something the detector genuinely invented.
const { falsePositives, falseNegatives } = overlapRun.failures;
const decoyFPs = falsePositives.filter((f) => f.wasDecoy);
const realFNs = falseNegatives.filter((f) => !f.planned);

console.log(`\n${'='.repeat(64)}`);
console.log(`\n  false positives: ${falsePositives.length} (${decoyFPs.length} on deliberate decoys)`);
for (const f of falsePositives.slice(0, 12)) {
  console.log(`    ${f.id.padEnd(9)} ${f.type.padEnd(15)} ${JSON.stringify(f.value)}${f.wasDecoy ? '  [decoy]' : ''}`);
}
if (falsePositives.length > 12) console.log(`    ... and ${falsePositives.length - 12} more`);

console.log(`\n  false negatives on implemented types: ${realFNs.length}`);
for (const f of realFNs.slice(0, 12)) {
  console.log(`    ${f.id.padEnd(9)} ${f.type.padEnd(15)} ${JSON.stringify(f.value)}`);
}
if (realFNs.length > 12) console.log(`    ... and ${realFNs.length - 12} more`);

fs.writeFileSync(FAILURES_PATH, JSON.stringify(overlapRun.failures, null, 2) + '\n');
console.log(`\n  full failure list -> ${path.relative(process.cwd(), FAILURES_PATH)}`);

// --- baseline -------------------------------------------------------------

const snapshot = {
  generated: new Date().toISOString().slice(0, 10),
  prompts: prompts.length,
  exact: { overall: exactRun.overall, perType: exactRun.perType },
  overlap: { overall: overlapRun.overall, perType: overlapRun.perType },
};

if (SAVE) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`\n--- baseline saved to ${path.relative(process.cwd(), BASELINE_PATH)} ---\n`);
  process.exit(0);
}

if (CHECK) {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.log('\n--- no baseline yet; run `npm run eval:save` to create one ---\n');
    process.exit(0);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const regressions = [];

  for (const mode of ['exact', 'overlap']) {
    for (const type of IMPLEMENTED) {
      const was = base[mode].perType[type];
      const now = snapshot[mode].perType[type];
      if (!was || !now || was.f1 === null || now.f1 === null) continue;
      if (now.f1 < was.f1 - F1_TOLERANCE) {
        regressions.push(
          `${mode}/${type}: F1 ${(was.f1 * 100).toFixed(1)}% -> ${(now.f1 * 100).toFixed(1)}%`
        );
      }
    }
    const wasAll = base[mode].overall;
    const nowAll = snapshot[mode].overall;
    if (wasAll.f1 !== null && nowAll.f1 !== null && nowAll.f1 < wasAll.f1 - F1_TOLERANCE) {
      regressions.push(
        `${mode}/OVERALL: F1 ${(wasAll.f1 * 100).toFixed(1)}% -> ${(nowAll.f1 * 100).toFixed(1)}%`
      );
    }
  }

  if (regressions.length) {
    console.log(`\n  REGRESSIONS vs baseline (${base.generated}):`);
    for (const r of regressions) console.log(`    x ${r}`);
    console.log('\n--- detection quality REGRESSED ---\n');
    process.exit(1);
  }
  console.log(`\n--- no regression vs baseline (${base.generated}) ---\n`);
  process.exit(0);
}

console.log('');
