# Detection evaluation harness

Measures how good the detector actually is. Before this existed, every claim
about detection quality rested on hand-picked examples — and the credit-card
bug showed how that fails: it looked fine while silently dropping valid cards.

Pure Node, no dependencies, no browser. Runs in about a second.

## Commands

```bash
npm run eval            # validate the dataset, then score
npm run eval:validate   # structural checks only; regenerates dataset.json
npm run eval:bench      # detection latency
npm run eval:save       # write baseline.json (do this deliberately)
npm run eval:check      # fail if quality dropped vs baseline — runs in npm test
```

## Files

| File | |
|---|---|
| `dataset.js` | **the source of truth.** Prompts authored with `{{TYPE:value}}` markers |
| `dataset.json` | generated artifact. Gitignored -- regenerate with `npm run eval:validate` |
| `validate.js` | structural checks; writes `dataset.json` |
| `score.js` | precision / recall / F1 |
| `bench.js` | latency |
| `baseline.json` | committed reference the regression gate compares against |
| `failures.json` | generated FP/FN dump. Gitignored |

## Adding prompts

```js
p('sf-201', SF, 'Email me at {{EMAIL:test@example.com}} about order 5551234567.', {
  negatives: ['5551234567'],
  notes: 'order number shaped like a phone',
});
```

Span offsets are computed from the markers, never written by hand. That is
deliberate: a hand-typed offset that is off by one does not throw, it just
silently records a correct detection as a miss and quietly ruins the recall
number.

`negatives` lists strings that look like PII but must not be detected. This
is the field that makes precision mean anything — without decoys, precision
is measured only against ordinary prose and reads far higher than it deserves.

**All values must be synthetic.** Card numbers are the standard published
test numbers.

Credential-shaped values are assembled from fragments via `K()` rather than
written as literals, and `dataset.json` is gitignored. Both because the fake
tokens are realistic enough that GitHub push protection blocks the commit --
which is correct behaviour, and the right response is to avoid storing
contiguous credential-shaped strings rather than to disable the protection.

## Reading the output

Two match modes are reported, and neither alone is honest:

- **exact** — boundaries must line up character for character. Catches
  boundary bugs, but reads a near-miss as a total miss.
- **overlap** — same type, any character overlap. Shows whether the detector
  *found* the thing, but matching one character of a card is not protecting it.

A large gap between the two means a boundary problem, not a detection problem.

`SECRET`, `PERSON`, `ORG` and `LOCATION` are labelled in the dataset but not
implemented yet (Phases 6 and 8). They score zero recall on purpose and are
reported in their own table, so their guaranteed failure does not drag the
headline number down. Labelling them now means the dataset never needs
re-labelling later — which is how ground truth quietly drifts mid-project.

## Baseline, after Phase 6 (2026-09-13)

130 prompts · 99 labelled spans · 58 clean prompts · 36 carrying decoys

| | precision | recall | F1 |
|---|---|---|---|
| exact | 92.6% | 100.0% | **96.1%** |
| overlap | 92.6% | 100.0% | **96.1%** |

Exact and overlap are now identical, which means there are no boundary
errors left anywhere. **Recall is 100% — the detector misses nothing it is
built to find.** Both remaining false positives are on deliberate decoys.

| Type | F1 | |
|---|---|---|
| `SECRET` | 100% | added in Phase 6 |
| `EMAIL` `PHONE` `CREDIT_CARD` `DOB` `IPV6` `STREET_ADDRESS` | 100% | |
| `IPV4` | 95.7% | one decoy remains |
| `SSN` | 88.9% | one decoy remains |
| `PHONE` | 82.8% | **deliberate** — see below |

`PERSON`, `ORG` and `LOCATION` are labelled but unimplemented until Phase 8.

### Phase 6 changes and what they were worth

Starting point was 84.4% exact F1.

| Change | Effect |
|---|---|
| Dropped the trailing `\.?` from `STREET_ADDRESS` | 45.5% → 100% exact. The period intended for `St.` was also eating sentence terminators, so the model received sentences with no full stop |
| Card windows must align to whole digit groups | Stopped a 13-digit Visa being carved out of a 15-digit IMEI, with no recall loss |
| Added `SECRET` | 100% precision and recall, and it fixed `PHONE` firing inside API keys for free — overlap resolution now awards those digit runs to `SECRET` |
| `PHONE` needs punctuation or nearby phone wording | 82.8% → 100%, then **reverted** — see below |
| `IPV4` suppressed after version wording | 81.5% → 95.7% |

### PHONE precision is deliberately low

Bare ten-digit runs match unconditionally, so order numbers, case ids and CI
runner ids are masked alongside real phone numbers. Context gating was tried,
reached 100% precision, and was reverted on purpose:

- For a privacy tool a false negative is a leak and a false positive is an
  annoyance. Those costs are not symmetric, so the default must be to detect.
- It penalised the most likely input format. An Indian mobile number is
  normally written as a bare ten-digit run with no surrounding cue, so the
  gating failed hardest for the users a US-shaped pattern already serves worst.

`82.8%` here is a chosen operating point, not an unfixed bug. Do not "improve"
it without revisiting that trade.

### The other remaining false positives are not bugs

Both are genuinely undecidable from the text:

- `99.95.100.0` in "our SLA target is 99.95.100.0 percent uptime" is a valid dotted quad.
- `445-90-2210` as a policy number has exactly the shape of an SSN.

They were left alone on purpose. Patching them would mean matching the
dataset rather than the problem, and over-masking is the safe direction for
a privacy tool anyway.

### Latency

Not a concern. `tokenize()` costs **0.006 ms at p95** on a typical prompt and
**0.73 ms** on an 11 KB pasted document, which leaves ample headroom for the
NER tier in Phase 8.

## The regression gate

`npm test` runs `eval:check`, which fails the build if any implemented type's
F1 drops more than 2 points below `baseline.json`. Verified non-vacuous:
deliberately weakening the email pattern produces

```
x exact/OVERALL:   F1 84.4% -> 78.3%
x overlap/EMAIL:   F1 100.0% -> 82.1%
x overlap/OVERALL: F1 91.3% -> 86.7%
```

Without this, a change that improves one type while quietly destroying another
ships unnoticed. Update the baseline with `npm run eval:save` only when a drop
is understood and intended.
