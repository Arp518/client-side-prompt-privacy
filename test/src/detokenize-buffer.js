/**
 * detokenize-buffer.js — restores placeholders in text that arrives in
 * pieces.
 *
 * This is the part of response restoration that has nothing to do with the
 * wire format, and it is the part that is easy to get subtly wrong.
 *
 * The problem: the model streams its reply token by token, so a placeholder
 * does not arrive whole. A single marker routinely shows up as
 *
 *     chunk n     "...contact [EMAIL_PLACE"
 *     chunk n+1   "HOLDER_1] for details..."
 *
 * Replacing per chunk therefore misses it, and the user sees a half-token.
 * Buffering the entire reply instead would work but defeats streaming: the
 * answer would appear all at once at the end.
 *
 * The rule: emit everything up to the last '[' that could still become a
 * placeholder, and hold back from there until the next chunk resolves it.
 *
 * WHY A CAP. "Could still become a placeholder" is a prediction, and in a
 * reply containing a code block it can be wrong forever — an unmatched '['
 * in prose or source would stall the stream indefinitely, which is a worse
 * failure than showing a raw marker. So the hold-back is bounded: once the
 * held text exceeds MAX_HOLD characters it cannot be one of our tokens
 * (the longest possible is far shorter) and is released.
 *
 * Deliberately NOT a TransformStream. Keeping the state machine as a plain
 * push/flush object means it can be tested exhaustively at every possible
 * split point without constructing streams, and the stream wrapper around
 * it stays trivial. See response-transform.js.
 */

'use strict';

const { detokenize, TOKEN_RE } = require('./tokenizer');

/**
 * A complete marker is  [ TYPE _PLACEHOLDER_ <digits> ]  where TYPE is
 * [A-Z][A-Z0-9_]*. Every character of TYPE, of the literal _PLACEHOLDER_,
 * and of the digits is drawn from [A-Z0-9_] — so any '[' followed only by
 * characters from that class is still a viable prefix, and the closing ']'
 * is the only thing that ends it.
 *
 * That makes the test a single cheap regex rather than a parser, and it
 * fails fast on the common false alarms: markdown links, array indexing and
 * '[note]' all contain a character outside the class within a byte or two.
 */
const VIABLE_PREFIX = /^\[[A-Z0-9_]*$/;

/**
 * Longest marker we can emit is on the order of 32 characters
 * (`[STREET_ADDRESS_PLACEHOLDER_999]`). 64 leaves generous headroom for a
 * longer type name without letting a stray bracket stall the stream.
 */
const MAX_HOLD = 64;

/**
 * @param {object} opts
 * @param {() => Record<string,string>} opts.getMap  resolved lazily: the map
 *        grows while the response streams, because a later turn can mint
 *        tokens before this reply finishes.
 * @param {boolean} [opts.tolerant=false]  also recover reformatted markers.
 *        Off by default: a tolerant match is a formatting artifact rather
 *        than a verbatim echo, and conflating the two would inflate any
 *        measurement of round-trip fidelity.
 * @param {(token: string) => void} [opts.onRestored]  called once per
 *        marker actually replaced, for echo instrumentation. Receives the
 *        token, never the value.
 */
function createDetokenizeBuffer({ getMap, tolerant = false, onRestored }) {
  let held = '';

  /** Index of the last '[' that is still a viable marker prefix, or -1. */
  function holdPointFrom(text) {
    const at = text.lastIndexOf('[');
    if (at === -1) return -1;
    const tail = text.slice(at);
    if (tail.length > MAX_HOLD) return -1;        // too long to be ours
    if (!VIABLE_PREFIX.test(tail)) return -1;     // already disqualified
    return at;
  }

  function restore(text) {
    if (!text) return text;
    const map = getMap();
    if (onRestored) {
      // Count before substituting: afterwards the markers are gone.
      const seen = text.match(TOKEN_RE);
      if (seen) {
        for (const token of seen) {
          if (Object.prototype.hasOwnProperty.call(map, token)) onRestored(token);
        }
      }
    }
    return detokenize(text, map, { tolerant });
  }

  return {
    /**
     * Feed the next piece of text. Returns the portion safe to emit now,
     * with any complete markers restored. May return ''.
     */
    push(text) {
      if (typeof text !== 'string' || text === '') return '';
      const combined = held + text;
      const at = holdPointFrom(combined);

      if (at === -1) {
        held = '';
        return restore(combined);
      }

      held = combined.slice(at);
      return restore(combined.slice(0, at));
    },

    /**
     * End of stream: release whatever is still held. A marker that never
     * completed is emitted as-is rather than swallowed — showing the user a
     * raw '[EMAIL_PLACE' is bad, but silently dropping text is worse.
     */
    flush() {
      const rest = held;
      held = '';
      return restore(rest);
    },

    /** Characters currently withheld. Exposed for tests and diagnostics. */
    pending() {
      return held.length;
    },
  };
}

module.exports = { createDetokenizeBuffer, VIABLE_PREFIX, MAX_HOLD };
