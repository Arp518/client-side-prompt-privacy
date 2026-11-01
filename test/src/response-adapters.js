/**
 * response-adapters.js — isolates "where is the visible reply text inside
 * this stream frame" from everything else in the restoration path.
 *
 * Deliberately mirrors payload-adapters.js. That module answers the same
 * question for the outgoing request, and keeping the two shaped alike means
 * a frontend change is a new adapter in one file rather than surgery on the
 * transform.
 *
 * Contract:
 *   findTextLocations(parsedFrame) -> Array<TextLocation>
 *
 *   TextLocation = {
 *     path,     // human-readable, diagnostics only
 *     pointer,  // JSON pointer this text belongs to, or null
 *     key,      // stable identity across frames, for append-mode buffering
 *     mode,     // 'append' | 'whole'  -- see below, this is the load-bearing bit
 *     counts,   // does restoring here measure round-trip fidelity
 *     get(): string,
 *     set(value: string): void,
 *   }
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
 * ---------------------------------------------------------------------------
 * MODE IS NOT DECORATION. It is the distinction that was missing, and its
 * absence corrupted replies.
 *
 * 'append' — the value is a delta. The full text is the concatenation of
 *   every delta for that pointer, so a marker routinely straddles two
 *   frames and the hold-back buffer must carry the tail forward.
 *
 * 'whole'  — the value is complete on arrival. Either cumulative (each
 *   frame restates the entire reply so far) or standalone (the echoed
 *   prompt). Carrying a tail forward into one of these prepends a stray
 *   fragment to the front of the whole string; the observed symptom was a
 *   reply rendering as "[PHONEI will email alice@...". Whole values are
 *   restored directly and never buffered.
 *
 * Getting this wrong is silent: parts/0 keeps working, so a smoke test
 * passes while the field the page actually renders from is mangled.
 * ---------------------------------------------------------------------------
 *
 * SHAPES BELOW ARE CONFIRMED, not guessed. They were transcribed from a
 * live /backend-api/f/conversation response on 2026-11-02 and are replayed
 * verbatim in the response-replay check. Three independent fields carry the
 * same reply text and the page may render from any of them:
 *
 *   /message/content/parts/<n>                     append, plain
 *   /message/metadata/model_dil_v2/constants       whole (cumulative), plain
 *   /message/metadata/model_dil_v2/fallbackMarkdown append, markdown-escaped
 *
 * On the first text delta all three arrive NESTED inside a single
 * `/message/metadata` append rather than at their own pointers, which is
 * why the scan below looks for them by field name at any depth instead of
 * matching the operation's pointer.
 */

'use strict';

/** Bound the nested scan; frames are small and shallow in every observed shape. */
const MAX_SCAN_DEPTH = 8;

/**
 * Undo the backslash escaping ChatGPT applies in `fallbackMarkdown`, where
 * `[EMAIL_PLACEHOLDER_1]` is transmitted as `\[EMAIL\_PLACEHOLDER\_1\]`.
 * Without this the detokenizer sees no marker at all and the field keeps
 * its raw placeholder.
 *
 * Applied ONLY to fallbackMarkdown. `constants` carries the same text
 * unescaped — an earlier revision escaped both, which is what put a literal
 * backslash into the rendered reply.
 */
function unescapeMarkdown(text) {
  return typeof text === 'string' ? text.replace(/\\([[\]_])/g, '$1') : text;
}

/** Re-apply that escaping after restoration, so the wire format stays consistent. */
function reescapeMarkdown(text) {
  return typeof text === 'string' ? text.replace(/[[\]_]/g, '\\$&') : text;
}

const PARTS_POINTER_RE = /^(.*)\/content\/parts\/(\d+)$/;

/**
 * Find the three known reply-text fields anywhere inside `node`.
 *
 * Keyed by FIELD NAME rather than by pointer on purpose: the same field
 * appears both at its own pointer (later deltas) and nested inside a
 * `/message/metadata` append (the first delta). Both must land in the same
 * buffer or the carry-forward breaks exactly once per reply — at the start,
 * which is where the first marker usually is.
 */
function scanKnownFields(node, out, basePointer, depth) {
  if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((child, i) => scanKnownFields(child, out, `${basePointer}/${i}`, depth + 1));
    return;
  }

  for (const key of Object.keys(node)) {
    const child = node[key];
    const pointer = `${basePointer}/${key}`;

    // model_dil_v2.fallbackMarkdown — streamed delta, markdown-escaped.
    if (key === 'fallbackMarkdown' && typeof child === 'string') {
      out.push({
        path: pointer,
        pointer,
        key: 'fallbackMarkdown',
        mode: 'append',
        counts: true,
        get: () => unescapeMarkdown(node[key]),
        set: (value) => { node[key] = reescapeMarkdown(value); },
      });
      continue;
    }

    // model_dil_v2.constants — cumulative map of slot -> full text so far.
    // Plain text, not markdown. Whole mode: never buffered.
    if (key === 'constants' && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const slot of Object.keys(child)) {
        if (typeof child[slot] !== 'string') continue;
        out.push({
          path: `${pointer}/${slot}`,
          pointer: `${pointer}/${slot}`,
          key: `constants:${slot}`,
          mode: 'whole',
          counts: true,
          get: () => child[slot],
          set: (value) => { child[slot] = value; },
        });
      }
      continue;
    }

    // content.parts — an array of complete strings when it arrives inside a
    // whole message object (as opposed to an /append delta on one index).
    if (key === 'parts' && Array.isArray(child)) {
      child.forEach((p, i) => {
        if (typeof p !== 'string') return;
        out.push({
          path: `${pointer}/${i}`,
          pointer: `${pointer}/${i}`,
          key: `parts:${i}`,
          mode: 'whole',
          counts: true,
          get: () => child[i],
          set: (value) => { child[i] = value; },
        });
      });
      continue;
    }

    scanKnownFields(child, out, pointer, depth + 1);
  }
}

/**
 * ChatGPT's live patch shapes, all three forms:
 *   { o: "patch", v: [ {p, o, v}, ... ] }
 *   { v: [ {p, o, v}, ... ] }
 *   { p, o, v }                           single operation
 *
 * Text deltas appear as `{ p: "/message/content/parts/0", o: "append", v: "..." }`.
 * Any operation whose value is an OBJECT is additionally scanned for the
 * known reply-text fields, because the first delta of a turn delivers
 * model_dil_v2 nested inside a `/message/metadata` append.
 */
function jsonPatchAdapter(frame) {
  const out = [];
  if (!frame || typeof frame !== 'object') return out;

  const ops = Array.isArray(frame.v)
    ? frame.v
    : (typeof frame.p === 'string' && typeof frame.o === 'string' ? [frame] : null);
  if (!ops) return out;

  ops.forEach((op, idx) => {
    if (!op || typeof op !== 'object') return;
    const { p, o } = op;

    if (typeof p === 'string' && typeof op.v === 'string') {
      const parts = PARTS_POINTER_RE.exec(p);

      // The streaming text delta. This is the one path that already worked,
      // and the only one that strictly requires carry-forward.
      if (parts && o === 'append') {
        out.push({
          path: `v[${idx}].v`,
          pointer: p,
          key: `parts:${parts[2]}`,
          mode: 'append',
          counts: true,
          get: () => op.v,
          set: (value) => { op.v = value; },
        });
        return;
      }

      // A replace on the same pointer restates the whole part.
      if (parts && o === 'replace') {
        out.push({
          path: `v[${idx}].v`,
          pointer: p,
          key: `parts:${parts[2]}`,
          mode: 'whole',
          counts: true,
          get: () => op.v,
          set: (value) => { op.v = value; },
        });
        return;
      }

      if (p.endsWith('/fallbackMarkdown')) {
        out.push({
          path: `v[${idx}].v`,
          pointer: p,
          key: 'fallbackMarkdown',
          // 'replace' restates the field; 'append' extends it.
          mode: o === 'replace' ? 'whole' : 'append',
          counts: true,
          get: () => unescapeMarkdown(op.v),
          set: (value) => { op.v = reescapeMarkdown(value); },
        });
        return;
      }
    }

    // The operation targets a known field DIRECTLY, so its value is that
    // field's contents rather than a structure containing it. The nested
    // scan cannot see these: handed the constants object itself it iterates
    // slot names ("0"), never the field name it matches on, so every
    // cumulative update after the first was passing through untouched.
    if (typeof p === 'string' && op.v && typeof op.v === 'object') {
      const field = p.slice(p.lastIndexOf('/') + 1);

      if (field === 'constants' && !Array.isArray(op.v)) {
        const slots = op.v;
        for (const slot of Object.keys(slots)) {
          if (typeof slots[slot] !== 'string') continue;
          out.push({
            path: `v[${idx}].v.${slot}`,
            pointer: `${p}/${slot}`,
            key: `constants:${slot}`,
            mode: 'whole',
            counts: true,
            get: () => slots[slot],
            set: (value) => { slots[slot] = value; },
          });
        }
        return;
      }

      if (field === 'parts' && Array.isArray(op.v)) {
        const parts = op.v;
        parts.forEach((text, i) => {
          if (typeof text !== 'string') return;
          out.push({
            path: `v[${idx}].v[${i}]`,
            pointer: `${p}/${i}`,
            key: `parts:${i}`,
            mode: 'whole',
            counts: true,
            get: () => parts[i],
            set: (value) => { parts[i] = value; },
          });
        });
        return;
      }
    }

    // Operation value is some other structure: look inside it for the
    // known fields. This is the path that catches the first text delta of
    // a turn, where model_dil_v2 arrives nested in a /message/metadata
    // append rather than at its own pointer.
    if (op.v && typeof op.v === 'object') {
      scanKnownFields(op.v, out, typeof p === 'string' ? p : '', 0);
    }
  });

  return out;
}

/**
 * The user's own prompt, echoed back so the client can render the turn:
 *   { type: "input_message", input_message: { content: { parts: ["..."] } } }
 *
 * Restored, because the page re-renders the user's bubble from this and
 * would otherwise flip it from the text the user typed to placeholders.
 *
 * counts:false, and that matters. `restored` is the round-trip fidelity
 * measurement — how many markers the MODEL gave back. Our own prompt
 * contains every marker by construction, so counting it would report
 * perfect fidelity on every turn no matter what the model did. An earlier
 * revision did exactly that: it reported "restored 2 of 2" for a reply in
 * which nothing had been restored at all.
 */
function inputMessageEchoAdapter(frame) {
  const out = [];
  if (!frame || frame.type !== 'input_message') return out;
  scanKnownFields(frame.input_message, out, '/input_message', 0);
  for (const loc of out) {
    loc.mode = 'whole';
    loc.counts = false;
  }
  return out;
}

/**
 * A whole message object, at the top level or under `v`:
 *   { message: { content: { parts: [...] } } }
 *   { v: { message: { content: { parts: [...] } } } }
 */
function fullMessageAdapter(frame) {
  const out = [];
  if (!frame || typeof frame !== 'object') return out;
  const host = frame.message ? frame : (frame.v && frame.v.message ? frame.v : null);
  if (!host) return out;
  scanKnownFields(host.message, out, '/message', 0);
  return out;
}

/**
 * OpenAI-style streaming delta: { choices: [{ delta: { content: "..." } }] }.
 * Not what chatgpt.com sends today, kept because it is the documented
 * public shape and costs nothing to support.
 */
function choicesDeltaContentAdapter(frame) {
  const out = [];
  if (!frame || !Array.isArray(frame.choices)) return out;
  frame.choices.forEach((choice, ci) => {
    if (choice && choice.delta && typeof choice.delta.content === 'string') {
      out.push({
        path: `choices[${ci}].delta.content`,
        pointer: null,
        key: `choices:${ci}`,
        mode: 'append',
        counts: true,
        get: () => choice.delta.content,
        set: (value) => { choice.delta.content = value; },
      });
    }
  });
  return out;
}

/**
 * Compact delta: { v: "some text" }.
 *
 * In ChatGPT's v1 delta encoding a bare value continues the pointer of the
 * preceding operation, which for reply text is always the active content
 * part. Bound to the parts:0 buffer so the compact and explicit forms share
 * carry-forward state rather than each holding half a marker.
 */
function deltaValueAdapter(frame) {
  const out = [];
  if (frame && typeof frame === 'object' && typeof frame.v === 'string') {
    out.push({
      path: 'v',
      pointer: '/message/content/parts/0',
      key: 'parts:0',
      mode: 'append',
      counts: true,
      get: () => frame.v,
      set: (value) => { frame.v = value; },
    });
  }
  return out;
}

/**
 * Fallback: every string anywhere in the frame.
 *
 * Safe in a way it would not be on the request side, because a placeholder
 * is a string we minted ourselves — it can only appear in a field carrying
 * text we sent. Restoring in a field that turns out to be an identifier is
 * a no-op, since no identifier contains one of our markers.
 *
 * mode 'whole' and counts:false are both deliberate. A deep walk returns
 * dozens of unrelated strings — ids, model slugs, channel names — in object
 * key order. Feeding those through a shared carry-forward buffer splices a
 * held marker prefix onto the first unrelated string that follows it,
 * corrupting that field AND losing the marker. And a restoration found in
 * a frame no specific adapter recognised is not evidence about the model's
 * echo fidelity, so it must not be counted as such.
 */
function deepStringAdapter(frame, maxDepth = MAX_SCAN_DEPTH) {
  const out = [];

  function walk(node, depth, path) {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        if (typeof child === 'string') {
          out.push({
            path: `${path}[${i}]`,
            pointer: null,
            key: null,
            mode: 'whole',
            counts: false,
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
      const next = path ? `${path}.${key}` : key;
      if (typeof child === 'string') {
        out.push({
          path: next,
          pointer: null,
          key: null,
          mode: 'whole',
          counts: false,
          get: () => node[key],
          set: (value) => { node[key] = value; },
        });
      } else {
        walk(child, depth + 1, next);
      }
    }
  }

  walk(frame, 0, '');
  return out;
}

/** Specific shapes first; the deep walk only if none matched. */
const ADAPTERS = [
  jsonPatchAdapter,
  inputMessageEchoAdapter,
  fullMessageAdapter,
  choicesDeltaContentAdapter,
  deltaValueAdapter,
];

/**
 * @param {*} parsedFrame  already JSON.parse()'d frame payload
 * @param {(where: string, message: string) => void} [onError]
 * @returns {Array<object>} text locations; see the contract at the top
 */
function findTextLocations(parsedFrame, onError) {
  // First adapter that returns anything wins. Running several over one frame
  // would hand the same text to the same buffer twice.
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

  try {
    return deepStringAdapter(parsedFrame);
  } catch (e) {
    if (typeof onError === 'function') onError('deepStringAdapter', String(e));
    return [];
  }
}

module.exports = {
  findTextLocations,
  ADAPTERS,
  deepStringAdapter,
  choicesDeltaContentAdapter,
  jsonPatchAdapter,
  inputMessageEchoAdapter,
  fullMessageAdapter,
  deltaValueAdapter,
  unescapeMarkdown,
  reescapeMarkdown,
};
