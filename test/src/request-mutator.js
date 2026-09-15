/**
 * request-mutator.js — turns a raw JSON request body into a tokenized one.
 *
 * Split out of inject.js so that "how do we find and replace PII in a
 * body" is testable and readable independently of "how do we intercept
 * fetch calls in the first place" (that part is request-interceptor.js).
 *
 * Owns the in-memory sessionMap. Nothing outside this module writes to it.
 * (Phase 1.5 — persisting this to chrome.storage.session — would extend
 * this module's internals, not change its public shape below.)
 */

'use strict';

const { tokenize } = require('./tokenizer');
const { findTextLocations } = require('./payload-adapters');

/**
 * @param {object} deps
 * @param {(kind: string, payload: object) => void} deps.relay
 * @returns {{ mutateBodyText: (rawBodyText: string) => {mutated: boolean, bodyText: string}, sessionMap: object }}
 */
function createRequestMutator({ relay }) {
  // In-memory map for this page session only. NEVER attach this object to
  // `parsed` before JSON.stringify — that would leak originals into the
  // outgoing request. It only ever gets read locally, or (Phase 1.5) relayed
  // to content-bridge.js via postMessage for chrome.storage.session.
  const sessionMap = {};

  // Text-location discovery is delegated to payload-adapters.js. This
  // module doesn't know or care that the current shape is
  // messages[].content.parts[] — that knowledge lives in exactly one place
  // (payload-adapters.js), so a future ChatGPT frontend change means adding
  // an adapter there, not touching mutation logic here.
  function findTextParts(parsedBody) {
    return findTextLocations(parsedBody, (where, message) => {
      relay('error', { where: `payload-adapter:${where}`, message });
    });
  }

  function mutateBodyText(rawBodyText) {
    let parsed;
    try {
      parsed = JSON.parse(rawBodyText);
    } catch (e) {
      // Not JSON, or not the shape we expect — bail out and send unmodified.
      // Length only, never a text preview — a non-JSON body could still be
      // plaintext containing PII (e.g. a form-encoded body).
      relay('body-not-json', { rawBodyLength: rawBodyText.length });
      return { mutated: false, bodyText: rawBodyText };
    }

    // Privacy-safe by design: we relay metadata about the body, never the
    // body itself. See relay.js's header note for why this matters even
    // though the channel isn't otherwise isolated.
    const locations = findTextParts(parsed);
    relay('body-received', {
      endpointMatched: true,
      textLocationsFound: locations.length,
    });

    if (locations.length === 0) {
      relay('no-text-parts-found', {
        note: 'No known payload adapter (see payload-adapters.js) matched this body\'s shape. If ChatGPT changed its request format, add a new adapter there rather than editing this file.',
      });
      return { mutated: false, bodyText: rawBodyText };
    }

    // --- REAL DETECTION + TOKENIZATION ------------------------------------
    // For each text location found by the payload adapters, run it through
    // the real detector/tokenizer. `parsed` only ever receives
    // `tokenizedText` via loc.set() — the original values are kept solely
    // in `sessionMap`, which is never merged back into `parsed` and never
    // touches JSON.stringify below.
    let replacedAny = false;
    let totalReplacements = 0;
    const matchTypeCounts = {};

    for (const loc of locations) {
      const original = loc.get();
      const { tokenizedText, map } = tokenize(original);

      const mapEntries = Object.keys(map);
      if (mapEntries.length > 0) {
        replacedAny = true;
        totalReplacements += mapEntries.length;
        Object.assign(sessionMap, map); // keep originals locally only
        for (const token of mapEntries) {
          // token looks like "[EMAIL_PLACEHOLDER_1]" — bucket by type only,
          // never log the token's mapped value.
          const type = token.replace(/^\[|_PLACEHOLDER_\d+\]$/g, '');
          matchTypeCounts[type] = (matchTypeCounts[type] || 0) + 1;
        }
      }

      loc.set(tokenizedText); // only the tokenized text goes into parsed
    }

    if (!replacedAny) {
      relay('no-pii-matched', { note: 'No PII detected in this prompt by detector.js.' });
      return { mutated: false, bodyText: rawBodyText };
    }

    const newBodyText = JSON.stringify(parsed);
    // Metadata only: counts and types, never the actual before/after text.
    relay('body-mutated', {
      replacements: totalReplacements,
      matchTypeCounts,
      locationsMutated: locations.length,
    });
    return { mutated: true, bodyText: newBodyText };
  }

  return { mutateBodyText, sessionMap };
}

module.exports = { createRequestMutator };
