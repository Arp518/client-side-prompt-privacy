/**
 * payload-adapters.js — isolates "where is the user's text inside this
 * request body" from everything else in inject.js.
 *
 * Why this exists:
 * inject.js used to have a single hard-coded walk
 * (messages[].content.parts[]) baked directly into a function called
 * findTextParts(). That was fine for validating the pipeline in Phase 0,
 * but it means the whole extension silently stops working the moment
 * ChatGPT's frontend changes its request shape, with no way to add a
 * second shape without editing fetch-interception logic directly.
 *
 * This module turns "find the text" into a small ordered list of
 * adapters, each of which knows about exactly one payload shape. Adding
 * support for a new shape (or a new target app entirely) means adding a
 * new adapter here — inject.js never needs to change.
 *
 * Contract:
 *   findTextLocations(parsedBody) -> Array<TextLocation>
 *   TextLocation = { get(): string, set(value: string): void, path: string }
 *
 * A "location" is a live reference into the already-parsed object graph —
 * calling .set() mutates parsedBody in place (same behavior as the old
 * hit.arr[hit.key] = tokenizedText pattern), so callers don't need to know
 * *how* a given adapter found the string, only that get()/set() work.
 */

'use strict';

/**
 * Adapter for ChatGPT's current /backend-api/f/conversation shape:
 *   messages[].content.parts[]  (array of strings)
 *
 * Confirmed live against chatgpt.com (see context-further.md, section 4.3).
 */
function chatgptMessagesPartsAdapter(parsedBody) {
  const locations = [];

  const messages = parsedBody?.messages;
  if (!Array.isArray(messages)) return locations;

  messages.forEach((m, mIndex) => {
    const parts = m?.content?.parts;
    if (!Array.isArray(parts)) return;

    parts.forEach((p, pIndex) => {
      if (typeof p !== 'string') return;
      locations.push({
        path: `messages[${mIndex}].content.parts[${pIndex}]`,
        get() {
          return parts[pIndex];
        },
        set(value) {
          parts[pIndex] = value;
        },
      });
    });
  });

  return locations;
}

/**
 * Fallback adapter for a flatter shape some ChatGPT-like APIs use:
 *   messages[].content  (content itself is a plain string, no .parts)
 *
 * Not yet confirmed live — included defensively so a future frontend
 * change that flattens content doesn't silently produce zero locations.
 * Safe to keep alongside the parts[] adapter: a message can only match
 * one of the two shapes (content is either a string or an object), so
 * there's no double-processing risk.
 */
function chatgptFlatContentAdapter(parsedBody) {
  const locations = [];

  const messages = parsedBody?.messages;
  if (!Array.isArray(messages)) return locations;

  messages.forEach((m, mIndex) => {
    if (typeof m?.content !== 'string') return;
    locations.push({
      path: `messages[${mIndex}].content`,
      get() {
        return m.content;
      },
      set(value) {
        m.content = value;
      },
    });
  });

  return locations;
}

// Ordered list of known adapters. Each runs independently and results are
// concatenated — add new shapes here, don't touch inject.js.
const ADAPTERS = [
  chatgptMessagesPartsAdapter,
  chatgptFlatContentAdapter,
];

/**
 * Run every known adapter against parsedBody and return the combined list
 * of text locations found. Never throws — a single bad adapter (e.g. one
 * that assumes a field exists and it doesn't) is isolated so it can't take
 * down the others or the caller.
 *
 * @param {*} parsedBody - already JSON.parse()'d request body
 * @param {(where: string, message: string) => void} [onError] - optional
 *   hook so callers (inject.js) can relay adapter failures through their
 *   own logging channel without this module needing to know about
 *   postMessage/relay() at all.
 * @returns {Array<{path: string, get(): string, set(value: string): void}>}
 */
function findTextLocations(parsedBody, onError) {
  const all = [];
  for (const adapter of ADAPTERS) {
    try {
      const found = adapter(parsedBody);
      if (Array.isArray(found) && found.length > 0) {
        all.push(...found);
      }
    } catch (e) {
      if (typeof onError === 'function') {
        onError(adapter.name || 'anonymous-adapter', String(e));
      }
    }
  }
  return all;
}

module.exports = { findTextLocations, ADAPTERS };
