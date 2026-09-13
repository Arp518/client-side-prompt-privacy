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

## Baseline, as of 2026-09-13

130 prompts · 99 labelled spans · 58 clean prompts · 36 carrying decoys

| | precision | recall | F1 |
|---|---|---|---|
| exact | 77.7% | 92.4% | **84.4%** |
| overlap | 84.0% | 100.0% | **91.3%** |

**Recall is 100% in overlap mode — the detector currently misses nothing it
is built to find.** Every point of lost quality is a false positive.

### Known weaknesses, in priority order

| Type | exact F1 | What's wrong |
|---|---|---|
| `STREET_ADDRESS` | 45.5% | 100% in overlap mode, so it *finds* every address but gets the boundary wrong. The trailing `\.?` intended for `St.` also eats sentence-ending periods, so `742 Evergreen Terrace.` is captured with the full stop attached — the model then receives a sentence with no terminator. Also misses lowercase (`123 main st`). |
| `PHONE` | 75.0% | Matches any 10-digit run: order numbers, part numbers, case IDs. Also fires *inside* API keys — `ghp_1234567890abc…` yields a PHONE match on the digit run, so a token gets partially mangled without being properly protected. |
| `IPV4` | 81.5% | Four-part version strings are indistinguishable from IPs by shape alone (`3.11.4.2`, `1.2.3.4`). Genuinely ambiguous; needs context, not a better pattern. |
| `SSN` | 88.9% | A policy number with SSN shape (`445-90-2210`) matches. Probably unfixable by pattern alone. |
| `CREDIT_CARD` | 94.7% | The windowed retry carves a fake 13-digit Visa out of a 15-digit IMEI. Needs a length-boundary guard. |

`EMAIL`, `DOB` and `IPV6` are at 100% on both modes.

### Latency

Not a concern. `tokenize()` costs **0.006 ms at p95** on a typical prompt, and
**0.73 ms** on an 11 KB pasted document. Detection is nowhere near the send path's
bottleneck, which leaves room for the NER tier in Phase 8.

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
