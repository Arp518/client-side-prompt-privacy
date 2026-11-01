/**
 * response-capture.js — a real /backend-api/f/conversation stream, recorded.
 *
 * PROVENANCE. Transcribed from the Network tab of a live chatgpt.com session
 * on 2026-11-02 (model slug gpt-6, delta encoding v1), for the prompt
 *
 *     Reply with exactly this sentence, word for word:
 *     "I will email [EMAIL_PLACEHOLDER_1] and call [PHONE_PLACEHOLDER_1]."
 *
 * Identifiers and auth tokens have been replaced with inert stand-ins. The
 * frame shapes, operation pointers, field names and — critically — the
 * points at which the text is split across frames are exactly as recorded.
 *
 * WHY THIS FILE EXISTS. Every shape in response-adapters.js was previously
 * an informed guess, and two of the three were wrong in ways no test could
 * see: the reply still rendered, just with a raw placeholder or a stray
 * fragment in it. Guesses are fine as a starting point but they must not
 * stay guesses, so the recording is kept and replayed.
 *
 * THREE INDEPENDENT FIELDS carry the same reply text, and the page may
 * render from any of them. All three have to be restored:
 *
 *   /message/content/parts/<n>                       append,  plain text
 *   /message/metadata/model_dil_v2/constants         CUMULATIVE, plain text
 *   /message/metadata/model_dil_v2/fallbackMarkdown  append,  markdown-escaped
 *
 * Note the first text frame delivers all three NESTED inside a single
 * `/message/metadata` append rather than at their own pointers. That is the
 * detail that made the markdown field keep its placeholder: an adapter
 * matching on the operation's pointer never sees it.
 */

'use strict';

const CONV = '6ae7a7f3-0000-0000-0000-000000000000';
const MSG = 'ee720f9f-0000-0000-0000-000000000000';
const REQ = '23109094-0000-0000-0000-000000000000';

/** Escape the way ChatGPT does in fallbackMarkdown, and nowhere else. */
function mdEscape(text) {
  return text.replace(/[[\]_]/g, '\\$&');
}

/**
 * Rebuild the recorded stream around a given pair of markers.
 *
 * The split points are the recorded ones: the first frame ends one
 * character into the first marker, and the second frame ends six characters
 * into the second. Both markers therefore straddle a frame boundary, which
 * is the normal case rather than an edge case and the reason the hold-back
 * buffer exists at all.
 *
 * @param {object} [tokens]
 * @param {string} [tokens.email]  marker to embed, default [EMAIL_PLACEHOLDER_1]
 * @param {string} [tokens.phone]  marker to embed, default [PHONE_PLACEHOLDER_1]
 * @returns {{sse: string, expected: string, prompt: string}}
 */
function buildCapturedStream(tokens) {
  const email = (tokens && tokens.email) || '[EMAIL_PLACEHOLDER_1]';
  const phone = (tokens && tokens.phone) || '[PHONE_PLACEHOLDER_1]';

  const prompt = 'Reply with exactly this sentence, word for word:\n'
    + `"I will email ${email} and call ${phone}."`;

  // Recorded split points.
  const deltas = [
    `I will email ${email.slice(0, 1)}`,
    `${email.slice(1)} and call ${phone.slice(0, 6)}`,
    `${phone.slice(6)}.`,
  ];

  const expected = deltas.join('');

  const meta = {
    resolved_model_slug: 'gpt-6',
    message_type: 'next',
    cot_version: 'v5',
    request_id: REQ,
    model_slug: 'gpt-6',
    default_model_slug: 'gpt-6',
    citations: [],
    streaming_parent_revision: 0,
  };

  const frames = [
    { event: 'delta_encoding', data: '"v1"' },

    { data: { type: 'resume_conversation_token', kind: 'topic', token: 'inert', conversation_id: CONV } },

    // The user's own prompt, echoed back. Contains BOTH markers by
    // construction, which is why restorations here must not be counted as
    // the model returning them.
    { data: { type: 'input_message', input_message: {
        id: 'faf06f6a-0000-0000-0000-000000000000',
        author: { role: 'user', name: null, metadata: {} },
        content: { content_type: 'text', parts: [prompt] },
        status: 'finished_successfully', weight: 1.0,
        metadata: { request_id: REQ },
        recipient: 'all', channel: null,
      }, conversation_id: CONV } },

    { event: 'delta', data: { p: '', o: 'add', v: { message: {
        id: 'fe069793-0000-0000-0000-000000000000',
        author: { role: 'assistant', name: null, metadata: {} },
        content: { content_type: 'model_editable_context', model_set_context: '' },
        status: 'finished_successfully', weight: 1.0,
        metadata: { is_visually_hidden_from_conversation: true, model_slug: 'gpt-6' },
        recipient: 'all', channel: null,
      }, conversation_id: CONV, error: null }, c: 0 } },

    { event: 'delta', data: { v: { message: {
        id: MSG,
        author: { role: 'assistant', name: null, metadata: {} },
        content: { content_type: 'text', parts: [''] },
        status: 'in_progress', end_turn: false, weight: 1.0,
        metadata: { is_visually_hidden_from_conversation: true },
        recipient: 'all', channel: 'final',
      }, conversation_id: CONV }, c: 2 } },

    { data: { type: 'message_marker', conversation_id: CONV, message_id: MSG,
        marker: 'user_visible_token', event: 'first' } },

    // First text delta. model_dil_v2 arrives NESTED in a metadata append.
    { event: 'delta', data: { o: 'patch', v: [
        { p: '/message/content/parts/0', o: 'append', v: deltas[0] },
        { p: '/message/end_turn', o: 'replace', v: null },
        { p: '/message/metadata/is_visually_hidden_from_conversation', o: 'remove' },
        { p: '/message/metadata', o: 'append', v: Object.assign({}, meta, {
            model_dil_v2: {
              code: 'DIL.render(__dil.jsx(()=>{const __dilConstants=DIL.useConstants();'
                + 'return __dil.jsx("text",null,__dilConstants["0"]);},{"key":"body:0"}));',
              constants: { 0: deltas[0] },
              fallbackMarkdown: mdEscape(deltas[0]),
              fallbackMarkdownVersion: 1,
              appData: { opGenui: { componentResults: {}, interactionSurface: 'mainline' } },
            },
          }) },
      ] } },

    // Later text deltas: each field at its own pointer.
    { event: 'delta', data: { v: [
        { p: '/message/content/parts/0', o: 'append', v: deltas[1] },
        { p: '/message/metadata/model_dil_v2/constants', o: 'append',
          v: { 0: deltas[0] + deltas[1] } },
        { p: '/message/metadata/model_dil_v2/fallbackMarkdown', o: 'append',
          v: mdEscape(deltas[1]) },
      ] } },

    { event: 'delta', data: { v: [
        { p: '/message/content/parts/0', o: 'append', v: deltas[2] },
        { p: '/message/metadata/model_dil_v2/constants', o: 'append',
          v: { 0: deltas[0] + deltas[1] + deltas[2] } },
        { p: '/message/metadata/model_dil_v2/fallbackMarkdown', o: 'append',
          v: mdEscape(deltas[2]) },
      ] } },

    // Closes the turn. Any text still withheld by a hold-back buffer has to
    // be released here, because the page's reader stops at [DONE].
    { event: 'delta', data: { v: [
        { p: '/message/status', o: 'replace', v: 'finished_successfully' },
        { p: '/message/end_turn', o: 'replace', v: true },
        { p: '/message/metadata', o: 'append', v: { is_complete: true,
            finish_details: { type: 'stop', stop_tokens: [200002] } } },
      ] } },

    { data: { type: 'message_marker', conversation_id: CONV, message_id: MSG,
        marker: 'last_token', event: 'last' } },

    { data: { type: 'message_stream_complete', conversation_id: CONV } },

    { raw: 'data: [DONE]' },
  ];

  const sse = frames.map((f) => {
    if (f.raw) return f.raw;
    const head = f.event ? `event: ${f.event}\n` : '';
    const body = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
    return `${head}data: ${body}`;
  }).join('\n\n') + '\n\n';

  return { sse, expected, prompt };
}

/**
 * Reassemble each of the three render paths from a stream, so a test can
 * assert on what the page would actually display rather than on bytes.
 *
 * @returns {{parts: string, constants: string, fallbackMarkdown: string,
 *            stray: string[], frames: string[]}}
 */
function renderPaths(sseText) {
  let parts = '';
  let fallback = '';
  let constants = '';
  const stray = [];
  const frames = sseText.split('\n\n').filter((f) => f.trim());

  const takeDil = (dil) => {
    if (!dil || typeof dil !== 'object') return;
    if (dil.constants && typeof dil.constants['0'] === 'string') constants = dil.constants['0'];
    if (typeof dil.fallbackMarkdown === 'string') fallback += dil.fallbackMarkdown;
  };

  for (const frame of frames) {
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) { stray.push(frame); continue; }
    const body = line.slice(5).trim();
    if (body === '[DONE]' || body === '') continue;
    let p;
    try { p = JSON.parse(body); } catch (e) { stray.push(frame); continue; }
    if (typeof p !== 'object' || p === null) continue;

    const ops = Array.isArray(p.v) ? p.v : (typeof p.o === 'string' ? [p] : []);
    for (const op of ops) {
      if (!op || typeof op.p !== 'string') continue;
      if (op.p.startsWith('/message/content/parts/') && typeof op.v === 'string') parts += op.v;
      else if (op.p.endsWith('/fallbackMarkdown') && typeof op.v === 'string') fallback += op.v;
      else if (op.p.endsWith('/constants') && op.v && typeof op.v === 'object') {
        if (typeof op.v['0'] === 'string') constants = op.v['0'];
      } else if (op.v && typeof op.v === 'object') {
        takeDil(op.v.model_dil_v2);
      }
    }
  }

  return {
    parts,
    constants,
    fallbackMarkdown: fallback.replace(/\\([[\]_])/g, '$1'),
    stray,
    frames,
  };
}

module.exports = { buildCapturedStream, renderPaths, mdEscape };
