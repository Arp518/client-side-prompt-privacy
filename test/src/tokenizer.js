/**
 * tokenizer.js — turns detector spans into reversible placeholder tokens.
 *
 * This is the piece that eventually replaces the disposable EMAIL_RE swap
 * in inject.js. Kept separate from detector.js so the detection logic and
 * the tokenization/mapping logic can be scored and tested independently.
 */

'use strict';

const { detectPII } = require('./detector');

/**
 * Replace every detected PII span in `text` with a placeholder token of the
 * form [TYPE_PLACEHOLDER_N] (N scoped per type, 1-indexed, in order of
 * appearance) and return both the tokenized text and a map to reverse it.
 *
 * @param {string} text
 * @returns {{ tokenizedText: string, map: Record<string,string>, spans: Array }}
 *   map is { "[EMAIL_PLACEHOLDER_1]": "real@value.com", ... }
 */
function tokenize(text) {
  const spans = detectPII(text);
  const map = {};
  const counters = {};

  // Build replacements right-to-left so earlier offsets stay valid as we splice.
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    counters[span.type] = (counters[span.type] || 0); // placeholder assigned below, left-to-right
  }

  // Assign placeholder numbers left-to-right (so PLACEHOLDER_1 is always the
  // first occurrence in reading order), then splice right-to-left.
  const numbered = [];
  const seenCount = {};
  for (const span of spans) {
    seenCount[span.type] = (seenCount[span.type] || 0) + 1;
    const token = `[${span.type}_PLACEHOLDER_${seenCount[span.type]}]`;
    numbered.push({ ...span, token });
  }

  for (let i = numbered.length - 1; i >= 0; i--) {
    const span = numbered[i];
    map[span.token] = span.value;
    out = out.slice(0, span.start) + span.token + out.slice(span.end);
  }

  return { tokenizedText: out, map, spans: numbered };
}

/**
 * Reverse tokenize(): given text containing placeholder tokens and the map
 * produced for it, restore the original values. Safe to call on text the
 * model echoed back, reworded around, or partially repeated.
 *
 * @param {string} text
 * @param {Record<string,string>} map
 * @returns {string}
 */
function detokenize(text, map) {
  let out = text;
  for (const [token, value] of Object.entries(map)) {
    out = out.split(token).join(value);
  }
  return out;
}

module.exports = { tokenize, detokenize };