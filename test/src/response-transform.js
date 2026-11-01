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
 * FAIL OPEN throughout. A frame that will not parse is passed through
 * untouched; an adapter that finds no text location leaves the frame alone;
 * a transform that throws during construction leaves the response as it
 * was. Degrading to today's behaviour — the user sees a raw placeholder —
 * is always preferable to breaking the reply.
 */

'use strict';

const { createDetokenizeBuffer } = require('./detokenize-buffer');
const { findTextLocations } = require('./response-adapters');

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
 * Restore placeholders inside one frame.
 *
 * @returns {string} the frame, re-serialised if it was modified, or the
 *          original text unchanged if anything about it was unexpected.
 */
function restoreFrame(raw, buffer, relay) {
  // SSE data lines carry the payload; anything else (event:, id:, retry:,
  // comments, the [DONE] sentinel) is protocol and passes through.
  if (!raw.startsWith('data:')) return raw;

  const body = raw.slice(5).trim();
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
  if (!locations.length) return raw;

  let changed = false;
  for (const loc of locations) {
    const original = loc.get();
    const restored = buffer.push(original);
    if (restored !== original) changed = true;
    loc.set(restored);
  }

  if (!changed) return raw;

  try {
    return 'data: ' + JSON.stringify(parsed);
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
  const buffer = createDetokenizeBuffer({ getMap, tolerant, onRestored });
  const assembler = createFrameAssembler();
  let framesSeen = 0;

  return new TransformStream({
    transform(chunk, controller) {
      try {
        for (const frame of assembler.push(chunk)) {
          framesSeen++;
          const out = restoreFrame(frame.raw, buffer, relay);
          controller.enqueue(frame.terminated ? out + FRAME_DELIMITER : out);
        }
      } catch (e) {
        if (relay) relay('error', { where: 'restoration transform', message: String(e) });
        controller.enqueue(chunk); // fail open
      }
    },
    flush(controller) {
      try {
        for (const frame of assembler.flush()) {
          framesSeen++;
          controller.enqueue(restoreFrame(frame.raw, buffer, relay));
        }
        // Anything still withheld by the hold-back buffer. Emitted raw: an
        // incomplete marker shown to the user is bad, silently dropping
        // text is worse.
        const tail = buffer.flush();
        if (tail) controller.enqueue(tail);
        if (relay) relay('restoration-complete', { framesSeen });
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

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
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
  FRAME_DELIMITER,
};
