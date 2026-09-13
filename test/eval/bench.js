/**
 * bench.js — how much time detection adds to sending a message.
 *
 * This runs on the real send path: every keystroke-free moment between the
 * user hitting enter and the request leaving the browser. If detection
 * costs tens of milliseconds on a long prompt, that is a perceptible delay
 * the user will blame on ChatGPT.
 *
 * Measured in Node rather than the browser on purpose — same JS engine,
 * no page noise, reproducible run to run. It gives the shape of the cost;
 * the absolute number on the live path is instrumented separately in
 * inject.js.
 *
 * Run: node eval/bench.js   (or npm run eval:bench)
 */

'use strict';

const { prompts } = require('./dataset');
const { detectPII } = require('../src/detector');
const { createTokenSession } = require('../src/tokenizer');

const WARMUP = 20;
const ITERATIONS = 200;

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

function measure(label, fn, inputs) {
  for (let i = 0; i < WARMUP; i++) for (const t of inputs) fn(t);

  const samples = [];
  for (let i = 0; i < ITERATIONS; i++) {
    for (const t of inputs) {
      const t0 = performance.now();
      fn(t);
      samples.push(performance.now() - t0);
    }
  }
  samples.sort((a, b) => a - b);

  const total = samples.reduce((a, b) => a + b, 0);
  const chars = inputs.reduce((a, t) => a + t.length, 0) * ITERATIONS;

  return {
    label,
    runs: samples.length,
    mean: total / samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: samples[samples.length - 1],
    perKB: (total / (chars / 1024)),
  };
}

const ms = (v) => `${v.toFixed(3)} ms`.padStart(11);

function report(rows) {
  console.log('    case                     runs      p50         p95         p99         max        per KB');
  console.log('    ' + '-'.repeat(94));
  for (const r of rows) {
    console.log(
      `    ${r.label.padEnd(22)} ${String(r.runs).padStart(6)} ` +
        `${ms(r.p50)} ${ms(r.p95)} ${ms(r.p99)} ${ms(r.max)} ${ms(r.perKB)}`
    );
  }
}

const all = prompts.map((p) => p.text);
const short = prompts.filter((p) => p.bucket === 'short_factual').map((p) => p.text);
const long = prompts.filter((p) => p.bucket === 'open_ended').map((p) => p.text);

// A prompt far longer than anything in the dataset — someone pasting a log
// file or a document into the chat box is the realistic worst case, and the
// detectors are regex scans whose cost grows with length.
const pasted = [all.join('\n\n')];

console.log('\n=== detection latency ===\n');
console.log(`  ${prompts.length} prompts · ${ITERATIONS} iterations · ${WARMUP} warmup passes`);
console.log(`  longest single input: ${Math.max(...all.map((t) => t.length))} chars`);
console.log(`  pasted-document case: ${pasted[0].length} chars\n`);

console.log('  detectPII()');
report([
  measure('all prompts', detectPII, all),
  measure('short_factual', detectPII, short),
  measure('open_ended', detectPII, long),
]);

console.log('\n  detectPII() on a pasted document');
report([measure('~concatenated', detectPII, pasted)]);

// The full path the send actually takes: detect, then splice placeholders
// and update the session map.
const session = createTokenSession();
console.log('\n  tokenize() — detection plus substitution and map update');
report([
  measure('all prompts', (t) => session.tokenize(t), all),
  measure('pasted document', (t) => session.tokenize(t), pasted),
]);

const worst = measure('all prompts', (t) => session.tokenize(t), all);
const doc = measure('pasted document', (t) => session.tokenize(t), pasted);

console.log('\n  verdict');
console.log(
  `    A typical prompt costs ${worst.p95.toFixed(2)} ms at p95 — imperceptible ` +
    'against a network round trip.'
);
console.log(
  `    A pasted ${(pasted[0].length / 1024).toFixed(0)} KB document costs ` +
    `${doc.p95.toFixed(1)} ms at p95` +
    (doc.p95 > 50 ? ' — worth watching as detector types are added.' : '.')
);
console.log('');
