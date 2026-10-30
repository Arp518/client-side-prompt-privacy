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
  // / 5551234567 — including the bare ten-digit form, unconditionally.
  //
  // An earlier version required a bare run to sit near a word like "call" or
  // "phone", which lifted precision to 100% by dropping every order number
  // and case id. It was reverted on purpose. Two reasons:
  //
  //   1. For a privacy tool a false negative is a leak and a false positive
  //      is an annoyance. Those costs are not symmetric, so the default has
  //      to be to detect.
  //   2. It penalised the most likely input format. Indian mobile numbers
  //      are normally written as a bare ten-digit run with no cue at all,
  //      so the gating failed hardest on exactly the users least served by
  //      a US-shaped pattern.
  //
  // The cost is real and accepted: order numbers, case ids and CI runner ids
  // will be masked. Over-masking degrades a reply; under-masking leaks.
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

// Digit counts real payment cards actually use, in rough order of how
// common they are: Visa/MC/Discover 16, Amex 15, UnionPay 19, Diners 14,
// legacy Visa 13. Deliberately excludes 17 and 18 — no major scheme issues
// those, and allowing them roughly doubles the chance of a spurious Luhn
// hit when carving a card out of a longer digit run.
const CARD_LENGTHS = [16, 15, 19, 14, 13];

/**
 * Issuer prefix (IIN/BIN) paired with the lengths that issuer actually uses.
 *
 * Luhn alone is a weak filter — it passes roughly one in ten random digit
 * strings — and the windowed retry below multiplies that risk by trying
 * several substrings per run. Requiring the window to look like a real
 * card from an actual scheme cuts that noise sharply for one cheap test:
 * "1234567890123456" contains the Luhn-valid window "34567890123456",
 * which starts 34 (Amex) but is 14 digits, and Amex is always 15.
 */
const CARD_SCHEMES = [
  { re: /^4/, lengths: [13, 16, 19] },                        // Visa
  { re: /^5[1-5]/, lengths: [16] },                           // Mastercard
  { re: /^2(2[2-9]\d|[3-6]\d\d|7[01]\d|720)/, lengths: [16] },// Mastercard 2-series
  { re: /^3[47]/, lengths: [15] },                            // Amex
  { re: /^(6011|65|64[4-9])/, lengths: [16, 19] },            // Discover
  { re: /^35(2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },    // JCB
  { re: /^3(0[0-5]|095|6|8|9)/, lengths: [14, 16, 19] },      // Diners
  { re: /^62/, lengths: [16, 17, 18, 19] },                   // UnionPay
];

function isPlausibleCard(digits) {
  return CARD_SCHEMES.some(
    (s) => s.re.test(digits) && s.lengths.includes(digits.length)
  );
}

/**
 * Pull a Luhn-valid card out of a digit run, tolerating junk digits glued
 * to either end.
 *
 * The greedy match is deliberately wide, so a card adjacent to unrelated
 * digits comes back with those digits attached ("id 99 4111111111111111"
 * matches all 18 digits). Luhn then fails on the combined run. Filtering
 * the match away at that point — which is what this used to do — silently
 * dropped a real, valid card and let it leave the browser unmasked
 * (defect D11). So on failure, retry over plausible card-length windows
 * instead of giving up.
 *
 * @returns {{start:number,end:number,type:string,value:string}|null}
 */
function extractLuhnCard(raw, baseOffset) {
  const digitPos = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] >= '0' && raw[i] <= '9') digitPos.push(i);
  }
  const digits = digitPos.map((i) => raw[i]).join('');

  // Fast path: the whole run is the card. Overwhelmingly the common case.
  if (luhnCheck(digits) && isPlausibleCard(digits)) {
    return {
      start: baseOffset,
      end: baseOffset + raw.length,
      type: 'CREDIT_CARD',
      value: raw,
    };
  }

  // Otherwise look for a card sharing the run with unrelated digits, as in
  // "id 99 4111111111111111". The candidate must consist of WHOLE
  // separator-delimited groups: a window may not begin or end part-way
  // through a group of digits.
  //
  // That constraint is what separates a real find from an invented one. In
  // "99 4111111111111111" the card is exactly the second group, so it
  // aligns. In a 15-digit IMEI like 490154203237518 the only Luhn-valid
  // window is its first 13 digits — a cut straight through the middle of a
  // single group, which is never how a card appears next to other digits.
  // Without this the retry happily reports a fake Visa for every IMEI.
  const groups = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < '0' || raw[i] > '9') continue;
    const start = i;
    while (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '9') i++;
    groups.push({ start, end: i + 1, digits: raw.slice(start, i + 1) });
  }

  // A single group means there is nothing to align to — the fast path
  // above already tested it in full, so any sub-window would be a cut.
  if (groups.length < 2) return null;

  const byPreference = (a, b) => {
    const ai = CARD_LENGTHS.indexOf(a.digits.length);
    const bi = CARD_LENGTHS.indexOf(b.digits.length);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  };

  const candidates = [];
  for (let i = 0; i < groups.length; i++) {
    let joined = '';
    for (let j = i; j < groups.length; j++) {
      joined += groups[j].digits;
      if (joined.length > 19) break;
      candidates.push({ digits: joined, from: groups[i].start, to: groups[j].end });
    }
  }

  for (const cand of candidates.sort(byPreference)) {
    if (!luhnCheck(cand.digits) || !isPlausibleCard(cand.digits)) continue;
    return {
      start: baseOffset + cand.from,
      end: baseOffset + cand.to,
      type: 'CREDIT_CARD',
      value: raw.slice(cand.from, cand.to),
    };
  }

  return null;
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
  const spans = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const card = extractLuhnCard(m[0], m.index);
    if (card) spans.push(card);
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  return spans;
}

/**
 * Credentials and API keys.
 *
 * The highest-value type here and, unusually, the easiest to get right.
 * Every pattern below is anchored on an issuer prefix that exists precisely
 * so tooling can recognise it — the opposite situation from PHONE, which
 * has to guess whether ten digits are a number or an order id.
 *
 * Deliberately NO generic high-entropy rule. Flagging any long random-looking
 * string would catch git SHAs, base64 payloads, UUIDs and hashes — all
 * common in ordinary technical prose, none of them credentials. A missed
 * exotic key is better than masking every commit hash the user pastes.
 */
function detectSecrets(text) {
  const patterns = [
    // AWS access key ids. The prefix encodes the key class.
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b/g,
    // GitHub tokens: personal, OAuth, user-to-server, server, refresh.
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
    // OpenAI. Matches sk- and sk-proj- alike.
    /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g,
    // Slack bot/user/app/refresh tokens, and incoming webhooks.
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]{20,}/g,
    // Stripe live and test keys, secret/publishable/restricted.
    /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    // Google API keys.
    /\bAIza[A-Za-z0-9_-]{35}\b/g,
    // npm and PyPI publish tokens.
    /\bnpm_[A-Za-z0-9]{30,}\b/g,
    /\bpypi-[A-Za-z0-9_-]{30,}\b/g,
    // JSON Web Tokens — three base64url segments, first two starting "eyJ".
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    // PEM private key blocks. Match the whole block, not just the header,
    // so the key material itself is what gets replaced.
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ];

  const spans = [];
  for (const re of patterns) spans.push(...matchAll(text, re, 'SECRET'));
  return spans;
}

/**
 * Wording that means a dotted quad is a version number, not an address.
 *
 * A four-part version string and an IPv4 address are the same shape — no
 * pattern can separate 3.11.4.2 from 10.15.7.1 without looking at what is
 * around them. Suppressing on version wording is the cheap direction: a
 * missed IP in a sentence about upgrading is a small loss, while masking
 * every dependency version the user pastes makes the tool unusable for
 * anyone technical.
 */
const VERSION_CONTEXT =
  /\b(?:version|versions|v\d|bump|bumped|upgrade|upgraded|upgrading|downgrade|release|released|build|patch|patched|semver|dependency|dependencies|installed|running)\b/i;

function detectIPv4(text) {
  const re =
    /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)/g;
  return matchAll(text, re, 'IPV4').filter((span) => {
    const before = text.slice(Math.max(0, span.start - 30), span.start);
    return !VERSION_CONTEXT.test(before);
  });
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
  // No trailing \.? — it was intended to absorb the period in "Baker St."
  // but a regex cannot tell that period from the one ending the sentence,
  // so "742 Evergreen Terrace." was captured with the full stop attached.
  // Tokenizing that replaces the terminator too, and the model receives a
  // sentence with no end. The period is punctuation either way, not part
  // of the address, so leaving it out is both simpler and correct.
  const re =
    /\b\d{1,6}\s+[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Terrace|Circle|Cir)\b/g;
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
  'SECRET',
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
  detectSecrets,
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

module.exports = { detectPII, luhnCheck, DETECTORS, TYPE_PRIORITY };