/**
 * detector.js — Phase 2 regex-based PII detection engine.
 *
 * Standalone JS/Node module. No browser APIs, no chrome.*, no fetch.
 * Designed to be required directly by a scoring harness (Phase 1, if you
 * add one later) and, once it's earning its keep, dropped into inject.js
 * to replace the disposable EMAIL_RE.
 *
 * Contract:
 *   detectPII(text) -> Array<Span>
 *   Span = { start, end, type, value }
 *   - start/end are character offsets into `text` (end is exclusive)
 *   - spans are returned sorted by start, with overlaps resolved
 *     (longer/more-specific match wins — see resolveOverlaps)
 */

'use strict';

// ---------------------------------------------------------------------------
// Individual detectors. Each returns raw (possibly overlapping) spans.
// Kept as separate functions rather than one giant regex so each type
// can be tuned/disabled/scored independently.
// ---------------------------------------------------------------------------

function detectEmails(text) {
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  return matchAll(text, re, 'EMAIL');
}

function detectPhones(text) {
  // Covers: (555) 123-4567 / 555-123-4567 / 555.123.4567 / +1 555 123 4567
  // / 5551234567 (only when not obviously part of a longer digit run, e.g. a
  // credit card — the negative lookaheads below guard against that).
  const re =
    /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g;
  return matchAll(text, re, 'PHONE');
}

function detectSSN(text) {
  // US SSN format only: 123-45-6789. Deliberately requires the dashes —
  // 9 bare digits is too ambiguous to flag without dashes (false positives
  // on order numbers, zip+4, etc.) and NER can pick up the rest later.
  const re = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;
  return matchAll(text, re, 'SSN');
}

function detectCreditCard(text) {
  // 13-19 digits, optionally grouped by spaces or dashes into 4s (covers
  // Visa/MC/Amex/Discover layouts). Validated with a Luhn check to cut
  // false positives on random long numbers.
  // The digit-then-optional-separator pattern can otherwise swallow a
  // trailing space/dash that isn't actually part of the number (e.g.
  // "4111 1111 1111 1111 expires" would match through the space before
  // "expires") — require the match to end on a digit to prevent that.
  const re = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
  const raw = matchAll(text, re, 'CREDIT_CARD');
  return raw.filter((span) => luhnCheck(span.value.replace(/[ -]/g, '')));
}

function detectIPv4(text) {
  const re =
    /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)/g;
  return matchAll(text, re, 'IPV4');
}

function detectIPv6(text) {
  // Deliberately conservative: full 8-group form only. Abbreviated
  // "::" forms are common false positives against e.g. time ranges
  // ("10::30") in short factual prompts — leave those to NER later.
  const re = /(?<![:\da-fA-F])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![:\da-fA-F])/g;
  return matchAll(text, re, 'IPV6');
}

function detectDateOfBirth(text) {
  // MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD — only flagged when immediately
  // preceded by a birth-context keyword within a few words, since bare
  // dates are extremely common and not inherently PII on their own.
  const dateRe = /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}/g;
  const contextRe = /\b(born|birth(?:day)?|dob|d\.o\.b\.?)\b/i;
  const spans = [];
  let m;
  while ((m = dateRe.exec(text)) !== null) {
    const windowStart = Math.max(0, m.index - 30);
    const before = text.slice(windowStart, m.index);
    if (contextRe.test(before)) {
      spans.push({ start: m.index, end: m.index + m[0].length, type: 'DOB', value: m[0] });
    }
  }
  return spans;
}

function detectStreetAddress(text) {
  // Number + street-name words + a street-type suffix. Intentionally
  // narrow (misses non-US formats, apartment-only mentions, PO boxes) —
  // widening this without NER produces too many false positives on things
  // like "drove 5 miles down Main" or version strings.
  const re =
    /\b\d{1,6}\s+[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Terrace|Circle|Cir)\b\.?/g;
  return matchAll(text, re, 'STREET_ADDRESS');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchAll(text, re, type) {
  const spans = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, type, value: m[0] });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  return spans;
}

function luhnCheck(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * When detectors disagree on overlapping ranges (e.g. a phone-shaped
 * substring inside a longer credit-card match), keep the longer span;
 * on a tie, keep whichever was found by a higher-priority detector.
 */
const TYPE_PRIORITY = [
  'EMAIL',
  'SSN',
  'CREDIT_CARD',
  'IPV6',
  'IPV4',
  'PHONE',
  'DOB',
  'STREET_ADDRESS',
];

function resolveOverlaps(spans) {
  const sorted = [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = (b.end - b.start) - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type);
  });

  const result = [];
  let lastEnd = -1;
  for (const span of sorted) {
    if (span.start >= lastEnd) {
      result.push(span);
      lastEnd = span.end;
    }
    // else: fully or partially swallowed by a previously-accepted span, drop it
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DETECTORS = [
  detectEmails,
  detectSSN,
  detectCreditCard,
  detectIPv6,
  detectIPv4,
  detectPhones,
  detectDateOfBirth,
  detectStreetAddress,
];

function detectPII(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const all = DETECTORS.flatMap((fn) => fn(text));
  return resolveOverlaps(all).sort((a, b) => a.start - b.start);
}

module.exports = { detectPII, luhnCheck, DETECTORS };