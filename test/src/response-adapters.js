/**
 * response-adapters.js — isolates "where is the visible reply text inside
 * this stream frame" from everything else in the restoration path.
 *
 * Deliberately mirrors payload-adapters.js. That module answers the same
 * question for the outgoing request, and keeping the two shaped alike means
 * a frontend change is a new adapter in one file rather than surgery on the
 * transform.
 *
 * Contract, identical to the request side:
 *   findTextLocations(parsedFrame) -> Array<TextLocation>
 *   TextLocation = { get(): string, set(value: string): void, path: string }
 *
 * A location is a live reference into the parsed frame, so set() mutates it
 * in place and the caller re-serialises the whole object.
 *
 * WHY PARSE AT ALL, rather than string-replacing in the raw frame text:
 * a restored value can contain a quote, a backslash or a newline. Splicing
 * one into serialised JSON produces a frame the page cannot parse, which
 * breaks the reply outright. Mutating the parsed object and letting
 * JSON.stringify re-escape is correct for free.
 *
 * STATUS: the specific shapes below are informed guesses pending the live
 * capture (BROWSER-CHECK.md, Part C). The deep-walk fallback is what makes
 * that acceptable — it restores correctly even for a shape we have not
 * seen, so a wrong guess degrades to "slower but correct" rather than
 * "silently does nothing".
 */

'use strict';

/**
 * Delta shape: { v: "some text" }.
 * This is the form our own test harness emits and the one most commonly
 * reported for incremental SSE deltas.
 */
function deltaValueAdapter(frame) {
  const out = [];
  if (frame && typeof frame.v === 'string') {
    out.push({
      path: 'v',
      get: () => frame.v,
      set: (value) => { frame.v = value; },
    });
  }
  return out;
}

/**
 * Full-message shape: { message: { content: { parts: ["..."] } } }.
 * Mirrors the request payload shape, which several streaming APIs echo back
 * on the final frame.
 */
function messagePartsAdapter(frame) {
  const out = [];
  const parts = frame?.message?.content?.parts;
  if (Array.isArray(parts)) {
    parts.forEach((p, i) => {
      if (typeof p === 'string') {
        out.push({
          path: `message.content.parts[${i}]`,
          get: () => parts[i],
          set: (value) => { parts[i] = value; },
        });
      }
    });
  }
  return out;
}

/**
 * ChatGPT streaming delta shape: { choices: [{ delta: { content: "..." } }] }.
 *
 * This is the primary shape used by ChatGPT's /backend-api/f/conversation
 * endpoint for incremental reply tokens. Each SSE frame carries one or more
 * choices, each with a `delta` object whose `content` field holds the text
 * fragment for that frame.
 *
 * This adapter MUST be listed before deepStringAdapter (and before the
 * generic adapters) so the buffer never receives metadata strings like `id`
 * or `object`. If those reach the stateful detokenize buffer while a partial
 * token is held, the buffer splices the held prefix onto the first non-content
 * string it encounters, corrupting both that field and losing the token.
 */
function choicesDeltaContentAdapter(frame) {
  const out = [];
  if (!frame || !Array.isArray(frame.choices)) return out;
  frame.choices.forEach((choice, ci) => {
    if (choice && choice.delta && typeof choice.delta.content === 'string') {
      out.push({
        path: `choices[${ci}].delta.content`,
        get: () => choice.delta.content,
        set: (value) => { choice.delta.content = value; },
      });
    }
  });
  return out;
}

/**
 * Nested delta: { v: { message: { content: { parts: [...] } } } }.
 */
function nestedMessagePartsAdapter(frame) {
  const parts = frame?.v?.message?.content?.parts;
  const out = [];
  if (Array.isArray(parts)) {
    parts.forEach((p, i) => {
      if (typeof p === 'string') {
        out.push({
          path: `v.message.content.parts[${i}]`,
          get: () => parts[i],
          set: (value) => { parts[i] = value; },
        });
      }
    });
  }
  return out;
}

/**
 * Fallback: every string anywhere in the frame.
 *
 * Used only when no specific adapter matched. This is safe in a way it
 * would not be on the request side, because a placeholder is a string we
 * minted ourselves — it can only appear in a field that carries text we
 * sent. Restoring in a field that turns out to be an identifier is
 * therefore a no-op, since no identifier contains one of our markers.
 *
 * Bounded by depth so a cyclic or pathological frame cannot hang the
 * stream; frames are small and shallow in every shape we have seen.
 */
function deepStringAdapter(frame, maxDepth = 8) {
  const out = [];

  function walk(node, depth, path) {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        if (typeof child === 'string') {
          out.push({
            path: `${path}[${i}]`,
            get: () => node[i],
            set: (value) => { node[i] = value; },
          });
        } else {
          walk(child, depth + 1, `${path}[${i}]`);
        }
      });
      return;
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child === 'string') {
        out.push({
          path: path ? `${path}.${key}` : key,
          get: () => node[key],
          set: (value) => { node[key] = value; },
        });
      } else {
        walk(child, depth + 1, path ? `${path}.${key}` : key);
      }
    }
  }

  walk(frame, 0, '');
  return out;
}

/** Specific shapes first; the deep walk only if none matched. */
const ADAPTERS = [
  choicesDeltaContentAdapter, // ChatGPT streaming: choices[].delta.content — MUST be first
  deltaValueAdapter,
  nestedMessagePartsAdapter,
  messagePartsAdapter,
];

/**
 * @param {*} parsedFrame  already JSON.parse()'d frame payload
 * @param {(where: string, message: string) => void} [onError]
 * @returns {Array<{path: string, get(): string, set(value: string): void}>}
 */
function findTextLocations(parsedFrame, onError) {
  // Try specific adapters in priority order. Stop at the first one that
  // returns results — running multiple specific adapters on the same frame
  // would pass the same or overlapping text through the stateful detokenize
  // buffer more than once, which corrupts the held-prefix state.
  for (const adapter of ADAPTERS) {
    try {
      const found = adapter(parsedFrame);
      if (Array.isArray(found) && found.length) return found;
    } catch (e) {
      if (typeof onError === 'function') {
        onError(adapter.name || 'anonymous-adapter', String(e));
      }
    }
  }

  // No specific adapter matched — fall back to a full deep walk. Safe here
  // because a placeholder can only appear in a string field that carries
  // text we originally sent, so restoring inside an unrecognised field is a
  // no-op at worst, never a corruption.
  try {
    return deepStringAdapter(parsedFrame);
  } catch (e) {
    if (typeof onError === 'function') onError('deepStringAdapter', String(e));
    return [];
  }
}

module.exports = { findTextLocations, ADAPTERS, deepStringAdapter, choicesDeltaContentAdapter };
