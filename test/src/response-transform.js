/**
 * response-transform.js — restores placeholders in the streamed reply.
 *
 * Replaces the observe-only tee() with a chained transform. The reason is
 * not tidiness: the Streams Standard specifies that cancelling a duplicated
 * stream requires cancelling BOTH branches, so releasing only the branch
 * the extension reads leaves the source running. That is the unfixed half
 * of the stop-generating defect. A pipeThrough chain propagates cancel and
 * error backwards to the source for free.
 *
 *     response.body
 *       -> TextDecoderStream        bytes to text, across chunk boundaries
 *       -> frame assembly           text to complete frames
 *       -> restoration              placeholders to values
 *       -> TextEncoderStream        back to bytes
 *
 * THE AWKWARD PART, and why it is solved the way it is. A marker routinely
 * splits across two frames, so it lives in two different JSON objects. A
 * frame already emitted cannot be edited. So held text is carried FORWARD:
 * frame n emits its text minus the held tail, and frame n+1 emits that tail
 * prepended to its own. The rendered result is identical, because the page
 * appends deltas — a few characters arrive one frame later than they
 * otherwise would, which is imperceptible.
 *
 * That trick is valid ONLY for fields that accumulate by appending. The
 * same reply also travels in a cumulative field, where each frame restates
 * the whole text so far, and carrying a tail into one of those prepends a
 * stray fragment to the front of the entire string. Hence one buffer per
 * APPEND path, keyed by location.key, and no buffer at all for whole
 * values. See response-adapters.js for which is which.
 *
 * FAIL OPEN throughout. A frame that will not parse is passed through
 * untouched; an adapter that finds no text location leaves the frame alone;
 * a transform that throws during construction leaves the response as it
 * was. Degrading to today's behaviour — the user sees a raw placeholder —
 * is always preferable to breaking the reply.
 */

'use strict';

const { createDetokenizeBuffer, restoreAll } = require('./detokenize-buffer');
const { findTextLocations, reescapeMarkdown } = require('./response-adapters');

/** Frame delimiter. Server-sent events separate records with a blank line. */
const FRAME_DELIMITER = '\n\n';

/**
 * Guard against a response that never produces a delimiter — a non-SSE body
 * reaching this path would otherwise buffer without bound.
 */
const MAX_FRAME_BYTES = 1 << 20; // 1 MiB

/**
 * Split accumulated text into complete frames, keeping any partial tail.
 * Never emits a partial frame.
 */
function createFrameAssembler() {
  let pending = '';
  return {
    push(text) {
      pending += text;
      if (pending.length > MAX_FRAME_BYTES) {
        // Not the format we expect. Release everything and stop buffering;
        // the restoration stage will pass unparseable content through.
        const all = pending;
        pending = '';
        return [{ raw: all, terminated: false }];
      }
      const frames = [];
      let at;
      while ((at = pending.indexOf(FRAME_DELIMITER)) !== -1) {
        frames.push({ raw: pending.slice(0, at), terminated: true });
        pending = pending.slice(at + FRAME_DELIMITER.length);
      }
      return frames;
    },
    flush() {
      const rest = pending;
      pending = '';
      return rest ? [{ raw: rest, terminated: false }] : [];
    },
  };
}

/**
 * Does this frame end the assistant's text?
 *
 * Needed so withheld tails can be released INSIDE the stream rather than
 * after it. A hold-back buffer can still be holding a few characters when
 * the reply ends — the last thing the model wrote looked like the start of
 * a marker. Those characters have to go somewhere, and the two obvious
 * options are both wrong: dropping them silently truncates the reply, and
 * enqueuing them as bare text injects a line that belongs to no `data:`
 * frame, which is malformed SSE. Appending them as a further operation on
 * the frame that closes the turn is the only option that is both lossless
 * and well-formed.
 */
function isTurnTerminal(ops) {
  if (!Array.isArray(ops)) return false;
  return ops.some((op) => op && typeof op === 'object' && op.o === 'replace' && (
    (op.p === '/message/status' && op.v === 'finished_successfully') ||
    (op.p === '/message/end_turn' && op.v === true)
  ));
}

/** Tails are re-encoded for the field they belong to before being emitted. */
function encoderFor(key) {
  return key === 'fallbackMarkdown' ? reescapeMarkdown : (text) => text;
}

/**
 * Restore placeholders inside one frame.
 *
 * @param {string} raw      the raw SSE frame text
 * @param {Map<string, {buf: object, pointer: string, encode: function}>} buffers
 *        one hold-back buffer per append path, created lazily and persisting
 *        across frames so a marker split across deltas is reassembled.
 * @param {function} makeBuffer  factory for a new hold-back buffer
 * @param {function} restoreWhole  stateless restore for complete values
 * @param {function} relay
 * @returns {string} the frame, re-serialised if it changed, otherwise the
 *          original text byte for byte.
 */
function restoreFrame(raw, buffers, makeBuffer, restoreWhole, relay) {
  // An SSE record may carry `event:` or `id:` lines before `data:`; keep
  // them untouched and operate only on the payload line.
  const lines = raw.split(/\r?\n/);
  const dataIdx = lines.findIndex((l) => l.startsWith('data:'));
  if (dataIdx === -1) return raw;

  const body = lines[dataIdx].slice(5).trim();
  if (body === '' || body === '[DONE]') return raw;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return raw; // fail open: not JSON, leave it alone
  }

  let locations;
  try {
    locations = findTextLocations(parsed, (where, message) => {
      if (relay) relay('error', { where: `response-adapter:${where}`, message });
    });
  } catch (e) {
    return raw;
  }

  let changed = false;

  for (const loc of locations || []) {
    const original = loc.get();
    if (typeof original !== 'string') continue;

    let result;
    if (loc.mode === 'append' && loc.key) {
      if (!buffers.has(loc.key)) {
        buffers.set(loc.key, {
          buf: makeBuffer(loc.counts !== false),
          pointer: loc.pointer,
          encode: encoderFor(loc.key),
        });
      }
      const record = buffers.get(loc.key);
      // Keep the most recent pointer: the first delta of a turn arrives
      // nested under /message/metadata, later ones at the field's own path,
      // and a tail must be emitted against a path the page will apply.
      if (loc.pointer) record.pointer = loc.pointer;
      result = record.buf.push(original);
    } else {
      result = restoreWhole(original, loc.counts !== false);
    }

    if (result !== original) {
      loc.set(result);
      changed = true;
    }
  }

  // Release any withheld tail on the frame that closes the turn.
  if (Array.isArray(parsed.v) && isTurnTerminal(parsed.v)) {
    for (const [key, record] of buffers) {
      const tail = record.buf.flush();
      if (!tail || !record.pointer) continue;
      parsed.v.push({ p: record.pointer, o: 'append', v: record.encode(tail) });
      changed = true;
      if (relay) relay('restoration-tail', { key, length: tail.length, emitted: true });
    }
  }

  if (!changed) return raw;

  try {
    lines[dataIdx] = `data: ${JSON.stringify(parsed)}`;
    return lines.join('\n');
  } catch (e) {
    return raw; // fail open rather than emit a malformed frame
  }
}

/**
 * Build the TransformStream chain.
 *
 * @param {object} opts
 * @param {() => Record<string,string>} opts.getMap
 * @param {(kind: string, payload: object) => void} [opts.relay]
 * @param {boolean} [opts.tolerant=false]
 * @param {(token: string) => void} [opts.onRestored]
 */
function createRestorationTransform({ getMap, relay, tolerant = false, onRestored }) {
  // Distinct markers the MODEL actually gave back. Counted here rather than
  // by the caller so the completion event carries a number the interface can
  // show directly. Tokens only, never values -- this crosses the
  // page-readable channel.
  //
  // Only locations flagged countable contribute. The echoed prompt and any
  // deep-walk fallback restore normally but do not count, because both
  // contain our markers by construction and would report perfect round-trip
  // fidelity on every turn regardless of what the model did.
  const restored = new Set();
  const countAndForward = (token) => {
    restored.add(token);
    if (onRestored) onRestored(token);
  };

  const buffers = new Map();
  const makeBuffer = (counts) => createDetokenizeBuffer({
    getMap, tolerant, onRestored: counts ? countAndForward : undefined,
  });
  const restoreWhole = (text, counts) => restoreAll(text, {
    getMap, tolerant, onRestored: counts ? countAndForward : undefined,
  });

  const assembler = createFrameAssembler();
  const encoder = new TextEncoder();
  let framesSeen = 0;
  let chunkCount = 0;
  let completeRelayed = false;

  /**
   * "sent" is how many markers the session holds, so sent - restored is how
   * many the model did not give back. That difference is the number the
   * interface must surface honestly: a reply missing a placeholder is
   * incomplete, and the user is entitled to know rather than be shown a
   * plausible-looking answer with a value silently absent.
   *
   * Relayed exactly once. An earlier revision fired it both on seeing
   * [DONE] and again from flush(), so every turn reported twice and the
   * interface recorded the same reply as two.
   *
   * The guard below is regression insurance, not live logic: the two
   * remaining call sites are flush() and cancel(), which the Streams
   * Standard makes mutually exclusive -- a cancelled stream is not
   * flushed, and a closed one cannot be cancelled. It stays because the
   * defect it prevents was introduced by adding a call site, and a third
   * one would reintroduce it silently. Deliberately not test-covered,
   * since no reachable path reaches it twice.
   */
  function relayComplete() {
    if (completeRelayed || !relay) return;
    completeRelayed = true;
    const sent = Object.keys(getMap() || {}).length;
    relay('restoration-complete', {
      framesSeen,
      restored: restored.size,
      sent,
      unreturned: Math.max(0, sent - restored.size),
      restoredTokens: Array.from(restored),
    });
  }

  return new TransformStream({
    transform(chunk, controller) {
      try {
        chunkCount++;
        if (chunkCount <= 3 && relay) {
          // Format drift detection, carried over from the tee() spy branch
          // this transform replaced. Without it, a response that stops
          // being SSE fails silently: the assembler finds no delimiters,
          // every frame passes through untouched, and the user sees raw
          // placeholders with nothing anywhere reporting that restoration
          // has stopped working. Shape only -- no reply text.
          relay('stream-chunk-shape', {
            chunkCount,
            // Decoded text by this point, so .length would be characters.
            // The field is named bytes, so it reports bytes.
            bytes: encoder.encode(chunk).length,
            looksLikeSse: /^(?:data|event):/m.test(chunk),
            frameDelimiters: (chunk.match(/\n\n/g) || []).length,
          });
        }
        for (const frame of assembler.push(chunk)) {
          framesSeen++;
          const out = restoreFrame(frame.raw, buffers, makeBuffer, restoreWhole, relay);
          controller.enqueue(frame.terminated ? out + FRAME_DELIMITER : out);
        }
      } catch (e) {
        if (relay) relay('error', { where: 'restoration transform', message: String(e) });
        controller.enqueue(chunk); // fail open
      }
    },
    cancel() {
      // The user pressed stop, or the page dropped the stream. Report what
      // was restored before that happened; flush() does not run on cancel.
      relayComplete();
    },
    flush(controller) {
      try {
        for (const frame of assembler.flush()) {
          framesSeen++;
          controller.enqueue(restoreFrame(frame.raw, buffers, makeBuffer, restoreWhole, relay));
        }

        // Normally empty: the terminal frame already released every tail. A
        // reply that ended without one still must not lose characters, and
        // must not have bare text spliced into the byte stream either, so
        // what remains is emitted as a well-formed frame of its own.
        for (const [key, record] of buffers) {
          const tail = record.buf.flush();
          if (!tail) continue;
          if (record.pointer) {
            const op = { p: record.pointer, o: 'append', v: record.encode(tail) };
            controller.enqueue(`data: ${JSON.stringify({ v: [op] })}${FRAME_DELIMITER}`);
            if (relay) relay('restoration-tail', { key, length: tail.length, emitted: true });
          } else if (relay) {
            // No pointer to attach it to. Dropped deliberately: a line that
            // belongs to no data: frame is malformed SSE and risks the whole
            // reply, which is worse than losing a partial marker.
            relay('restoration-tail', { key, length: tail.length, emitted: false });
          }
        }

        relayComplete();
      } catch (e) {
        if (relay) relay('error', { where: 'restoration flush', message: String(e) });
      }
    },
  });
}

/**
 * Wrap a Response so its body is restored on the way to the page.
 * Returns the original response unchanged if anything prevents wrapping.
 *
 * Non-2xx bodies are left alone: an error response is not SSE, and running
 * a frame parser over it would at best waste work and at worst mangle a
 * diagnostic the page needs.
 */
function withRestoredBody(response, opts) {
  if (!response || !response.body) return response;
  if (!response.ok) return response;

  try {
    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createRestorationTransform(opts))
      .pipeThrough(new TextEncoderStream());

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (e) {
    if (opts && opts.relay) {
      opts.relay('error', { where: 'withRestoredBody', message: String(e) });
    }
    return response;
  }
}

module.exports = {
  createRestorationTransform,
  withRestoredBody,
  createFrameAssembler,
  restoreFrame,
  isTurnTerminal,
  FRAME_DELIMITER,
};
