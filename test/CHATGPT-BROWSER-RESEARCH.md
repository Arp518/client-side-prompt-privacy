# ChatGPT Browser Research — Findings Log

Running record of what has been **demonstrated** versus what is merely
**assumed**. Stage 10 (the writeup) depends on being able to tell those
apart, and a "known" fact about ChatGPT's frontend has a shelf life — this
file is what tells you whether something needs re-verifying after an
OpenAI frontend update.

One entry per finding. Do not delete superseded entries; add a new one and
mark the old one superseded, so drift is visible.

**Entry schema**

```
### <short title>
Date tested:
Chrome version:
ChatGPT URL:
Observed behavior:
Evidence:
Assumption made:
Implementation consequence:
Confidence:  observed directly | inferred
Stability:   documented browser API | empirical ChatGPT behavior, may change
```

---

## Stage 2 — Build wiring and log hygiene

### F-001 · Bundle builds and loads as a valid MV3 extension

Date tested: 2026-09-13
Chrome version: _(not yet — offline verification only)_
ChatGPT URL: n/a
Observed behavior: `npm run build` produces `dist/inject.bundle.js` (19 KB,
IIFE). Both content scripts referenced by `manifest.json` exist on disk and
pass `node --check`. `detectPII` is present in the bundle, so esbuild did
not tree-shake the detector.
Evidence: `npm test` — 13 round-trip + 47 tokenizer + 25 leak checks, all
passing. Manifest validation script output.
Assumption made: none. This is a build fact, not a ChatGPT fact.
Implementation consequence: the extension can be loaded unpacked. Prior to
this the manifest pointed at a file that did not exist, so it could not.
Confidence: observed directly
Stability: documented browser API

### F-002 · No raw PII crosses the postMessage bridge

Date tested: 2026-09-13
Chrome version: n/a (Node sandbox)
ChatGPT URL: n/a
Observed behavior: `src/leak-test.js` runs the real built bundle inside a
`node:vm` sandbox with a fake `window`, pushes a request containing one
synthetic value of each supported PII type, and asserts none of those
values appear in (a) the outgoing request body or (b) any relayed payload.
All 25 checks pass. Deliberately re-enabling `DEBUG_DUMP_RAW` makes 8 of
them fail, confirming the guard is load-bearing rather than vacuous.
Evidence: `npm run test:leak`.
Assumption made: that the Node sandbox's `Request`/`Response`/
`ReadableStream` behave like Chrome's for the code paths exercised. Broadly
safe (both are WHATWG implementations) but not a substitute for the live
test in F-004.
Implementation consequence: defect D8 is fixed and regression-guarded. The
research log now carries counts, types and byte lengths only.
Confidence: observed directly
Stability: documented browser API

---

## Stage 3 — Session tokenizer

### F-003 · Cross-turn placeholder collision reproduced and fixed

Date tested: 2026-09-13
Chrome version: n/a (Node)
ChatGPT URL: n/a
Observed behavior: with the stateless tokenizer, two turns each minted
`[EMAIL_PLACEHOLDER_1]`; merging the maps kept only the later value, so
turn 1 detokenized to the wrong person's address:

```
t1 "mail alice@x.com" -> { "[EMAIL_PLACEHOLDER_1]": "alice@x.com" }
t2 "mail bob@y.com"   -> { "[EMAIL_PLACEHOLDER_1]": "bob@y.com"   }
merged                -> { "[EMAIL_PLACEHOLDER_1]": "bob@y.com"   }
detokenize(t1)        -> "mail bob@y.com"          <-- WRONG
```

After `createTokenSession()`: turn 2 mints `_2`, turn 1 restores correctly,
and a value repeated in a later turn reuses its original token.
Evidence: `npm run test:tokenizer`, group "D1"; plus a multi-turn
integration check in `leak-test.js` driving three sequential fetches
through the real bundle.
Assumption made: one MAIN-world realm per tab, so one session per tab.
Holds for a hard load; an SPA soft-navigation between conversations does
**not** re-execute the MAIN-world script, so the session persists across
conversation switches within a tab. Worth confirming live (F-005) —
it means placeholder numbering continues across conversations, which is
correct for restoration but should be disclosed.
Implementation consequence: defect D1 fixed. Unblocks Stage 4 — without
this, response detokenization would have restored wrong values in any
multi-turn conversation.
Confidence: observed directly
Stability: documented browser API

### F-004 · Credit-card recall loss reproduced and fixed

Date tested: 2026-09-13
Observed behavior: `detectPII('id 99 4111111111111111 done')` returned `[]`.
The greedy digit-run regex swallowed the leading `99 `, Luhn failed on the
resulting 18-digit string, and the post-hoc filter discarded the match with
no retry — a valid card would have left the browser unmasked. Fixed by
retrying over plausible card-length windows, gated by an issuer
prefix/length check so the retry does not carve fake cards out of arbitrary
digit runs.
Evidence: `npm run test:tokenizer`, group "D11" — 10 cases covering Visa,
Amex, Mastercard, Discover, plus negative controls (generic 16-digit
number, USPS tracking number, 10-digit phone) that must stay empty.
Assumption made: that no major card scheme uses 17- or 18-digit numbers.
Standard, but it means a 17/18-digit card would be missed.
Implementation consequence: recall up on the embedded-card case, precision
up on long digit runs. Stage 6's eval must quantify both rather than trust
these hand-picked cases.
Confidence: observed directly
Stability: n/a — pure logic, no browser or ChatGPT dependency

---

## OPEN — requires a live browser session

These are the gate on Stage 4. Nothing in the response-side design should
be written until F-005 and F-006 are filled in.

### F-005 · Live end-to-end verification of the detector _(NOT YET RUN)_

The detector and tokenizer have never executed against chatgpt.com. Follow
the procedure in the plan, §2.6. Record here: whether
`/backend-api/f/conversation` is still the send endpoint; whether the
payload still matches `messages[].content.parts[]`; the observed
`replacements` count; and — the only proof that counts — whether the
**Network tab payload** shows placeholders rather than real values.

### F-006 · Live response stream shape _(NOT YET RUN)_

Required before any Stage 4 parser is written. Capture: response
`Content-Type` and full headers; whether `Content-Length` is present;
frame delimiter; whether frames are `data:`-only; the delta op format and
which field carries user-visible text; whether a placeholder ever splits
across two `v` values; whether text is delivered twice (append deltas plus
a final full-message frame); and one capture each of an aborted stream and
an error response.

Store raw captures under `test/research/captures/` with the date and build.
