/**
 * request-mutator.js — turns a raw JSON request body into a tokenized one.
 *
 * Split out of inject.js so that "how do we find and replace PII in a
 * body" is testable and readable independently of "how do we intercept
 * fetch calls in the first place" (that part is request-interceptor.js).
 *
 * Uses monotonic session tokenization (Stage 2/3) and delegates private
 * key delivery to vault-client (Stage 5).
 */

'use strict';

const { createTokenSession } = require('./tokenizer');
const { findTextLocations } = require('./payload-adapters');

/**
 * @param {object} deps
 * @param {(kind: string, payload: object) => void} deps.relay
 * @param {object} [deps.tokenSession]
 * @param {(delta: object) => void} [deps.sendVaultDelta]
 * @param {boolean} [deps.debugDumpRaw=false]
 * @returns {{
 *   mutateBodyText: (rawBodyText: string) => {mutated: boolean, bodyText: string},
 *   tokenSession: object,
 *   sessionMap: object
 * }}
 */
function createRequestMutator({ relay, tokenSession, sendVaultDelta, debugDumpRaw = false }) {
  const session = tokenSession || createTokenSession();

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
      relay('body-not-json', {
        rawBodyLength: rawBodyText.length,
        rawBodyPreview: rawBodyText.slice(0, 200),
      });
      return { mutated: false, bodyText: rawBodyText };
    }

    // Relay metadata about payload shape for debugging drift, zero PII
    relay('body-shape-captured', {
      keys: Object.keys(parsed || {}),
      messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : 0,
      roles: (parsed?.messages || []).map((m) => m?.author?.role ?? null),
      partLengths: (parsed?.messages || []).flatMap((m) =>
        Array.isArray(m?.content?.parts)
          ? m.content.parts.map((p) => (typeof p === 'string' ? p.length : -1))
          : []
      ),
    });
    if (debugDumpRaw) relay('raw-body-captured-DEBUG', { parsed });

    const locations = findTextParts(parsed);
    if (locations.length === 0) {
      relay('no-text-parts-found', {
        note: "Payload shape didn't match a user message at messages[].content.parts[]. Inspect 'body-shape-captured', or set DEBUG_DUMP_RAW=true locally, then update findTextParts().",
      });
      return { mutated: false, bodyText: rawBodyText };
    }

    let replacedAny = false;
    let totalReplacements = 0;
    const typesFound = {};

    for (const loc of locations) {
      const original = loc.get();
      const { tokenizedText, map, spans } = session.tokenize(original);

      if (spans && spans.length > 0) {
        replacedAny = true;
        totalReplacements += spans.length;
        for (const s of spans) {
          typesFound[s.type] = (typesFound[s.type] || 0) + 1;
        }
      }

      if (typeof sendVaultDelta === 'function' && map && Object.keys(map).length > 0) {
        sendVaultDelta(map);
      }

      loc.set(tokenizedText);
    }

    if (!replacedAny) {
      relay('no-pii-matched', {
        note: 'No PII detected in this prompt by detector.js — try including an email, phone, SSN, card number, IP, DOB, or street address to test mutation.',
      });
      return { mutated: false, bodyText: rawBodyText };
    }

    const newBodyText = JSON.stringify(parsed);
    relay('body-mutated', {
      replacements: totalReplacements,
      typesFound,
      matchTypeCounts: typesFound,
      locationsMutated: locations.length,
      bytesBefore: rawBodyText.length,
      bytesAfter: newBodyText.length,
    });
    if (debugDumpRaw) {
      relay('body-mutated-DEBUG', {
        before: rawBodyText.slice(0, 300),
        after: newBodyText.slice(0, 300),
      });
    }

    return { mutated: true, bodyText: newBodyText };
  }

  return {
    mutateBodyText,
    tokenSession: session,
    sessionMap: session?.map || {},
  };
}

module.exports = { createRequestMutator };
