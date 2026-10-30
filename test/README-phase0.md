# client-side-prompt-privacy
A client-side privacy framework that detects sensitive information in Generative AI prompts, replaces it with reversible tokens, securely stores the original data locally, and restores it in AI responses without exposing the sensitive information to the AI service.

## Final Tech Stack

**Extension core**
- Chrome Extension Manifest V3
- Vanilla JS for the MAIN-world injected interceptor (patches `fetch`/`XHR`) — no dependencies here, it runs in the page's real JS environment
- Vanilla JS content script (isolated world) as the bridge between the injected script and extension APIs
- MV3 service worker for lifecycle/coordination if needed

**Detection**
- Regex (hand-written) — email, phone, card, API key, SSN-shape
- `compromise.js` (npm) — person/org/location NER, rule-based, runs fully offline
- `esbuild` or `Vite` (extension mode) to bundle these into the content script

**Storage — no database, no backend**
- `chrome.storage.session` — placeholder map, memory-only, cleared on tab close
- `chrome.storage.local` — persistent redaction log + user-defined custom rules, user-clearable

**Response capture**
- `Response.body.tee()` + `ReadableStream` reader — primary approach for streamed detokenization
- `MutationObserver` on the chat DOM — fallback if teeing proves fragile

**Evaluation (separate from the extension)**
- JSON file of ~150 synthetic labeled prompts
- Python script for precision/recall scoring
- CSV/JSON export from the extension popup for the paraphrase-rate log
- Python + matplotlib (or a spreadsheet) for the writeup charts

**Tooling**
- Node.js + npm, Chrome DevTools + Load Unpacked, Git/GitHub

No FastAPI, no IndexedDB, no server — confirmed for the reasons above.

---

## Implementation Plan

**Phase 0 — Prove the architecture. Do not skip or shortcut this.**
1. Minimal extension: manifest + one MAIN-world script.
2. Patch `window.fetch`, log the body of any request to ChatGPT's conversation endpoint. Confirm you see plaintext.
3. Modify that body before letting the request through (swap an email for a placeholder). Confirm ChatGPT still responds coherently — this is your Risk 2 check.
4. Test response-side capture: try `response.body.tee()` on the streamed reply, confirm ChatGPT's own UI still renders normally off the branch you didn't keep.
5. In parallel, build a bare `MutationObserver` prototype watching the chat container, as your fallback if step 4 is fragile.

Stop and reassess the target platform only if step 2 or 3 fails — based on what we found earlier (multiple shipped extensions already do this against ChatGPT), that's unlikely.

**Phase 1 — Build the evaluation harness**
1. Write ~150 synthetic prompts with planted fake PII, labeled with ground-truth spans. Split deliberately into two buckets: short/factual prompts and open-ended/conversational prompts — you need this split to show the paraphrase-rate difference later.
2. Store as JSON: `{text, spans: [{start, end, type, value}]}`.

**Phase 2 — Detection engine, standalone**
1. Regex tier first, run and mask those spans.
2. compromise.js NER tier on what's left.
3. Score against your harness: precision/recall, iterate until reasonable.
4. Only once this works standalone do you wire it into the extension — debugging detection logic inside a browser extension is much slower than debugging it as plain JS/Node.

**Phase 3 — Tokenizer**
1. Type classification heuristics (email domain → personal/work, etc.).
2. Placeholder generation + session map, written to `chrome.storage.session`.

**Phase 4 — Detokenizer**
1. Build against whichever capture method Phase 0 validated (tee'd stream or MutationObserver).
2. Buffer logic that doesn't display a partial placeholder split across chunks/DOM mutations.
3. Instrument it to log, per placeholder sent: recovered verbatim / paraphrased / dropped — this feeds directly into your eval.

**Phase 5 — Popup + UX**
1. Live redaction count, session log.
2. Explicit "not recovered" indicator for paraphrase failures (turns your known limitation into an honest, visible feature rather than a silent bug).
3. Clear-data button, verified to actually clear both storage areas.

**Phase 6 — Run the real evaluation**
1. Push all 150 harness prompts through the live extension against real ChatGPT.
2. Log detection precision/recall + the verbatim/paraphrased/dropped split, broken out by your two prompt buckets.

**Phase 7 — Writeup**
1. Lead with the paraphrase-rate finding as the centerpiece result, not a footnote.
2. Detection precision/recall as supporting data.
3. Honest discussion of the structural ceiling and what it means for this class of tool, positioned against the existing shipped products you now know about.

 Phase 0 gating everything else.


----------------testing--------------
# Phase 0 — Testing Guide

This is deliberately not a working redaction tool. It's an instrumented
harness to answer four yes/no architecture questions before you write any
real detection logic. Don't skip straight to Phase 2 until all four have a
clear answer, per the plan.

## Load it

1. `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. **Load unpacked** → select the `pii-redaction-extension` folder
4. Go to `https://chatgpt.com`, open DevTools (F12) → **Console** tab
5. You should immediately see:
   - `[PII-REDACT PHASE0] injector active — patched window.fetch`
   - `[PII-REDACT PHASE0][bridge] bridge active on https://chatgpt.com/...`

If you don't see both lines, the extension isn't injecting at all — check
`chrome://extensions` for a red "Errors" button on the card before doing
anything else.

## Test 1 — Can we see the plaintext body?

Send any message in ChatGPT. Watch the console for:

- `[request-seen]` — confirms the fetch patch caught the right request. If
  this never fires, your endpoint match failed — see Troubleshooting below.
- `[raw-body-captured]` — the parsed JSON body. **This is Test 1's answer.**
  If you see it, you're reading plaintext before it leaves the browser.

**If `request-seen` fires but `raw-body-captured` doesn't:** the body isn't
a JSON string in the shape expected — check `[body-not-json]` in the
console for a raw preview and adjust.

## Test 2 — Can we modify it and have ChatGPT still accept it?

Send a message that includes a fake email, e.g.:
`"my email is test@example.com, can you summarize this for me"`

Watch for:
- `[body-mutated]` — shows the before/after body. If this fires, the
  substitution mechanism works.
- `[response-status]` — check `status` and `ok`. **This is Test 2's real
  answer.** If `ok: true` and ChatGPT responds coherently in the UI (using
  the placeholder sensibly, e.g. "I see you shared an email — I'll refer to
  it as requested"), tampering survives.
- `[possible-rejection]` — if this fires, compare: does the *same* message
  succeed with `MUTATE_BODY = false` (top of `inject.js`)? If yes-with-flag-off
  / no-with-flag-on, that's a confirmed Risk 2 hit — ChatGPT is rejecting
  tampered payloads, and the whole redact-before-send architecture needs
  rethinking for this platform, not just a smaller tweak.

**If `no-text-parts-found` fires instead:** the payload shape doesn't match
`messages[].content.parts[]` anymore. Check `raw-body-captured` from Test 1
to see the actual shape and update `findTextParts()` in `inject.js`
accordingly — this is the single most likely thing to have drifted since
this harness was written.

## Test 3 — Does `tee()` break ChatGPT's own rendering?

With a normal (or the email) message sent, just watch the ChatGPT UI itself
as the response streams in.

- **Pass:** response renders token-by-token exactly as it always does, and
  the console shows `[stream-chunk-sample]` (first 3 chunks) followed by
  `[stream-complete]`.
- **Fail:** UI freezes, response never appears, or appears all at once after
  a long delay. If you see a `[tee()]` entry under `[error]`, `tee()` threw —
  check the message. If the UI just hangs with no error logged, suspect
  backpressure: our spy-branch reader loop should never block the branch
  handed back to the page, so a hang points at something ChatGPT's own code
  does with the Response object that this harness doesn't yet account for
  (e.g. reading `.headers` in a way that requires the body settled).

If Test 3 fails, that's expected to be plausible per the plan — it's exactly
why the MutationObserver fallback exists. Don't treat a Test 3 failure as
blocking; treat it as "Phase 4 builds on MutationObserver instead of tee()."

## Test 4 — MutationObserver fallback (independent of 1-3)

This runs regardless of whether fetch patching works at all. As responses
render, watch for `[dom-mutation-observed]` entries with a `role` and
`textPreview`.

- If these never appear, `TURN_SELECTOR` in `content-bridge.js`
  (`[data-message-author-role]`) doesn't match current ChatGPT markup.
  Inspect a message bubble in DevTools → Elements and find whatever
  attribute/class is stable across turns, then update the constant.

## Reviewing the persisted log
Everything relayed also gets written to `chrome.storage.local` under the key
`phase0_log` (capped at the most recent 200 entries), independent of console
scrollback. To inspect it:

1. `chrome://extensions` → find this extension → **service worker** link
   isn't present here (no background worker in Phase 0) — instead, open the
   ChatGPT tab's DevTools Console and run:
   ```js
   chrome.storage.local.get('phase0_log', console.log)
   ```

## What "Phase 0 passed" actually means

Per the plan, you only stop and reconsider the target platform if Test 1 or
Test 2 fails outright (can't see the body at all, or every mutated request
gets rejected). A Test 3 failure alone is not a stop condition — it just
tells you Phase 4 is built on `MutationObserver` instead of stream teeing.
Write down the actual outcome of all four before moving to Phase 1 so the
eval harness assumptions match what's really possible here.

## Known rough edges in this harness (not bugs to "fix" — just be aware)

- `ENDPOINT_MATCHERS` includes a deliberately broad `"conversation"`
  fallback so *something* logs on first run. Narrow it once you've confirmed
  the real endpoint in the Network tab, or you'll get noisy `request-seen`
  hits on unrelated requests.
- `findTextParts()` assumes the `messages[].content.parts[]` shape from
  ChatGPT's historical API. If OpenAI changed this, Test 1 will still show
  you the raw body (`raw-body-captured`) — use that to fix the walk.
- No background service worker, no popup. Deliberately out of scope for
  Phase 0 per the plan — those show up in Phase 5.