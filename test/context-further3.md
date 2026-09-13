What the project is

A Chrome extension that sits between you and ChatGPT. You type normally; it catches personal data in the outgoing request, swaps it for placeholders before it leaves your machine, and swaps the real values back into the reply so you never see the placeholders. OpenAI's servers only ever receive the masked version. Everything happens in your browser — no server, no cloud, nothing to trust but the extension itself.

Right now: the masking half works. The restoring half doesn't exist yet. That's the gap between "interesting prototype" and "usable tool," and it's Stage 4.

What "D" means

D = defect. I numbered them during the audit so we could track them across stages instead of losing them in prose. Fifteen total.

Fixed
ID	Problem	Why it mattered
D1	Placeholder numbering restarted every message, so turn 2's [EMAIL_PLACEHOLDER_1] overwrote turn 1's	Silent data corruption. Turn 1 would have restored to the wrong person's email once restoration existed
D8	The extension relayed the entire untokenized prompt over postMessage and saved it to disk	The tool's own log was collecting plaintext personal data — and because inject.js shares a JS context with the page, ChatGPT's own scripts could read it. The privacy tool was a privacy leak
D11	detectPII('id 99 4111111111111111 done') returned nothing	A valid credit card leaving unmasked. The greedy pattern swallowed the neighbouring digits, the checksum failed on the combined run, and nothing retried
D12	Restoration only matched the exact token	If the model wrote [ EMAIL_PLACEHOLDER_1 ] or dropped the brackets, the user would see raw placeholder text instead of their data
D9 (half)	Rebuilt request dropped its AbortSignal	"Stop generating" silently stopped working on any message the extension touched
D15	Tokenized every message in the payload, not just yours	Would corrupt conversation history on regenerate/edit
D13	Bridge loaded after the interceptor	Every event before page-idle was thrown away, including startup
D14	No sender check on incoming messages	Any embedded iframe could inject fake entries into the log
D4	Log writes raced each other	Entries silently dropped during streaming — exactly when you most want the record
D5	Logged on every DOM mutation	Hundreds of console lines per reply; also real overhead
D6	Dead code, wrong import paths, postMessage(…, "*")	Housekeeping
Still open
ID	Problem	Where it gets fixed
D2	No response-side restoration — you see [EMAIL_PLACEHOLDER_1] in replies	Stage 4. The big one
D9 (half)	Cancelling one tee() branch doesn't cancel the source, so the stream keeps running after "stop"	Stage 4
D3	Real values live only in the page's memory — lost on reload, invisible to any UI	Stage 5
D10	chrome.storage.session can't be written from a content script at all (MV3 restricts it to trusted contexts, and there's no service worker)	Stage 5 — this is what forces the architecture
D7	Phone pattern matches any 10-digit number; street addresses need capital letters, so 123 main st is missed	Stage 6, once we can measure it
Concretely, what changed in the code

inject.js — session-scoped tokenizer replacing the per-call merge; relays shape/counts instead of the prompt; forwards signal and friends on rebuild; filters to user messages; debug dump behind an off-by-default flag.

tokenizer.js — rewritten. Added createTokenSession() (monotonic counters + value→token reuse, so the same email keeps the same placeholder all conversation), single-pass detokenize with an optional tolerant mode, and classifyEcho() which reports whether a placeholder came back exact, reformatted, or not at all. That last one is what will let the UI honestly say "5 restored, 2 couldn't be" instead of pretending everything worked.

detector.js — credit-card detection now retries over real card lengths when the first checksum fails, gated by an issuer prefix check so it doesn't invent cards out of order numbers. I caught that second problem only because fixing the first one introduced it.

content-bridge.js — buffered debounced writes, sender validation, document_start, message text no longer persisted, console noise off by default.

package.json — build, watch, and three test scripts. Previously there was no way to build at all.good

Plus: removed the two AI-directed strings from the tracked docs and repaired the sentence one of them had split in half.

Testing

npm test runs three suites — 85 checks, all passing:

smoke.js (13) — your original round-trip demo
tokenizer-test.js (47, new) — every assertion tied to a specific defect above
leak-test.js (25, new) — loads the real built bundle into a fake browser and proves no personal data reaches either the outgoing request or the internal log, across three sequential messages

I sanity-checked that last one by deliberately reintroducing the D8 leak: 8 checks failed, then passed again on revert. A test that can't fail isn't protecting anything.

Next stage — and a suggestion

Stage 5 is what I said I'd start: add a service worker, and move real values out of page memory into chrome.storage.session over a private MessageChannel rather than the page-readable postMessage bridge. It fixes D3 and D10, and it's the prerequisite for any UI that shows what's been masked.


Setup instructions — Her side

1. Pull

git fetch origin && git checkout stage-2-3-fixes

2. Install dependencies — node_modules isn't in git, and she'll need Node 18+ (tested on 22).

cd test && npm ci

3. Run the tests before touching Chrome. If anything's broken it shows up here in two seconds instead of after twenty minutes of browser debugging.

cd test && npm test

Expected: 13 passed, 47 passed, 18 checks passed, 25 checks passed — 103 checks total.

4. Build the bundle. This is not optional.

cd test && npm run build

dist/ is gitignored, so it does not come down with the pull. Skipping this means Chrome tries to load a file that doesn't exist and the extension fails silently. This is the single most likely thing to go wrong.

5. Load in Chrome

chrome://extensions → Developer mode on
If she already has an older copy loaded, remove it — don't just reload
Load unpacked → select the test folder (not the repo root)
Check for a red Errors button before doing anything else

6. Open a brand-new tab to https://chatgpt.com.

Not a refresh of an existing tab. The interceptor runs in the page's own JS context at document_start, and that only re-injects on a real navigation. Any tab that was open before the reload is now running orphaned code and will log Extension context invalidated.

Turn on Preserve log in both Console and Network first.

7. Send this (synthetic values only — deliberately no email, so it can't pass on the old email-only detector's behavior):

Call me at 555-123-4567, my server is 192.168.1.100, SSN 123-45-6789, card 4111 1111 1111 1111. Born 03/14/1990, at 742 Evergreen Terrace.
Part C — What she should see
Where	Expected
Console, filter PII-REDACT	injector active — patched window.fetch and bridge active on …
Console	body-shape-captured — counts and lengths, no prompt text
Console	body-mutated with replacements: 6 and a typesFound breakdown
Network → POST /backend-api/f/conversation → Payload	Placeholders, not real values. This is the only real proof
Console	response-status {status: 200, ok: true}
The page	Reply streams normally, token by token

Things that look wrong but are correct:

Her own message bubble shows the original text — the UI renders that locally from what she typed, it isn't what got sent
The reply will contain literal [PHONE_PLACEHOLDER_1] text — restoration is Stage 4, not built yet
The console is much quieter than before; that's D5 fixed, not something broken
Part D — The one thing worth asking her to capture

This is what unblocks Stage 4, the actual feature. While that tab is open:

Network → the POST → Response tab (or EventStream), then copy out the raw response and note:

The Content-Type, and whether a Content-Length header is present
What separates one frame from the next — blank line, or something else
Whether frames are all data: lines, or there are event: lines too
Which JSON field carries the visible reply text
Whether a long word ever arrives split across two frames — send something that makes the model echo a placeholder, then look for a frame whose text ends mid-token
What terminates the stream

Plus, if she can: one capture of hitting Stop generating mid-reply, and one of an error response.

Save those under test/research/captures/ with the date. With that in hand I can build the response-side restoration properly instead of guessing at the format — which is the difference between a day's work and a week of debugging a stream parser against assumptions.