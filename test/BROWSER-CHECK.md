# Browser verification and response capture

One session, two jobs. **Everything from Phase 2 onward has only ever run in
Node.** This is the first time the real extension meets a real browser, and
it is also where we capture the response format that Phase 7 is blocked on.

Budget an hour. Work top to bottom; part B depends on part A passing.

Use only the synthetic values given here. Never type real personal data,
real card numbers or real credentials into a prompt while the extension is
logging.

---

## Part A — setup

### A1. Build

```bash
cd test && npm ci && npm test && npm run build
```

Expect **149 checks** across five suites, then "no regression vs baseline".
`dist/` is gitignored, so the build is not optional — skipping it means
Chrome loads a file that does not exist and the extension fails silently.
This is the single most common way this goes wrong.

### A2. Load the extension

1. `chrome://extensions`
2. Developer mode **on**
3. **If an older copy is loaded, remove it.** Do not just reload — a stale
   copy produces "Extension context invalidated" noise that looks like a bug
   and is not.
4. **Load unpacked** → select the `test` folder (not the repo root)
5. Look for a red **Errors** button on the card before going further

### A3. Service worker registers

On the extension card, click **service worker**. A DevTools window should
open for `sw.js`.

- [ ] The link exists
- [ ] It opens without an error
- [ ] Console shows no exception on load

**If there is no "service worker" link, stop.** Nothing downstream works:
session storage is written only by the worker, so the vault stays empty.

### A4. Open a fresh tab

Go to `https://chatgpt.com` in a **new tab**. Not a refresh of an existing
one — the interceptor runs in the page's own JS context at `document_start`
and only re-injects on a real navigation.

In DevTools, turn on **Preserve log** in both Console and Network first.

---

## Part B — verify the pipeline

### B1. Both scripts loaded

Filter the console for `PII-REDACT`.

- [ ] `injector active — patched window.fetch`
- [ ] `bridge active on https://chatgpt.com/...`
- [ ] `[vault-channel-open]`

`vault-channel-open` is the one that matters. It means the private
`MessageChannel` port was offered by the bridge and accepted by the
interceptor. **Without it, real values never reach storage** and everything
downstream is dead, even though the page will look completely normal.

### B2. Send a test prompt

Paste exactly this:

```
Call me at 555-123-4567, my server is 192.168.1.100, SSN 123-45-6789,
card 4111 1111 1111 1111. Born 03/14/1990, at 742 Evergreen Terrace.
```

Watch the console for:

- [ ] `[request-seen]`
- [ ] `[body-shape-captured]` — keys, counts, lengths, **no prompt text**
- [ ] `[body-mutated]` with `replacements: 7` and a `typesFound` breakdown
- [ ] `[response-status] {status: 200, ok: true}`

Record the actual `replacements` number even if it is not 7.

### B3. The only proof that counts

DevTools → **Network** → the POST to `/backend-api/f/conversation` →
**Payload**.

- [ ] The payload contains `[PHONE_PLACEHOLDER_1]`, `[IPV4_PLACEHOLDER_1]`
      and so on
- [ ] It does **not** contain `555-123-4567`, `123-45-6789`, or the card

Console logs do not prove this. Only the payload does. **Screenshot this.**

### B4. The vault

In the **service worker** DevTools console (not the page console):

```js
chrome.storage.session.get(null, console.log)
```

- [ ] A key shaped `map:<number>` exists
- [ ] It maps placeholders to the real values
- [ ] The tab id matches the ChatGPT tab

### B5. No plaintext in the log

In the **page** console:

```js
chrome.storage.local.get('phase0_log', (r) => {
  const s = JSON.stringify(r);
  console.log('entries:', r.phase0_log?.length);
  for (const v of ['555-123-4567','123-45-6789','4111','Evergreen','192.168.1.100'])
    console.log(v, s.includes(v) ? 'LEAKED' : 'clean');
});
```

- [ ] Every line reads `clean`

Any `LEAKED` is a stop-the-line defect. Copy the offending entry and send it
to me before continuing.

### B6. The page still works

- [ ] The reply streams in token by token, normally
- [ ] No visible slowdown when sending
- [ ] The console is quiet during streaming

Things that look wrong and are correct: your own message bubble shows the
original text (the UI renders what you typed locally, not what was sent), and
the reply will contain literal `[PHONE_PLACEHOLDER_1]` text, because
restoration is Phase 7 and does not exist yet.

### B7. Stop generating

Send a prompt that produces a long answer ("explain TCP congestion control in
detail"), then hit **Stop** mid-stream.

- [ ] Generation visibly stops
- [ ] The Network entry for the POST shows cancelled/aborted
- [ ] No hang, no duplicated reply

This is the known half-fixed defect: cancelling one `tee()` branch does not
cancel the source. Note whether the request actually cancels or merely
appears to.

### B8. Canary is quiet

- [ ] No `unintercepted-transport` warning during normal use

If one appears, **copy it verbatim**. It means the service reached the
conversation endpoint by a transport we do not mask, and masking is silently
not happening.

---

## Part C — capture the response format

**This is what Phase 7 is blocked on.** Without it I would be writing a
stream parser against guesses.

**Do not paste a `fetch` wrapper into the console.** The extension already
patches `fetch`; stacking a second wrapper is a failure mode this project has
already lost time to. Everything below is read-only inspection.

### C1. A normal reply

Send a prompt that makes the model echo a placeholder back, so we can see one
in the stream:

```
Repeat this exactly, character for character: my address is
742 Evergreen Terrace and my number is 555-123-4567.
```

Then: Network → the POST → **Response** tab (and **EventStream** if Chrome
offers it).

Record:

- [ ] `Content-Type` header, verbatim
- [ ] Whether a `Content-Length` header is present
- [ ] All response headers (right-click → Copy response headers)
- [ ] **The complete raw response body**, copied exactly, not summarised
- [ ] What separates one frame from the next (blank line? newline? length
      prefix?)
- [ ] Whether every frame is a `data:` line, or whether `event:` lines appear
- [ ] Which JSON field carries the visible reply text
- [ ] Whether the same text arrives twice (incremental deltas *and* a final
      full message)
- [ ] What terminates the stream
- [ ] **Whether a placeholder is ever split across two frames** — look for a
      frame whose text ends mid-token, like `[EMAIL_PLACE`

That last one is the single most valuable observation in this document. It is
the reason the restoration transform needs a look-back buffer at all.

### C2. An aborted stream

Repeat B7 and save that response too, however partial.

### C3. An error response

If you can trigger one (send during a rate limit, or let a session expire),
save it. Otherwise note that none was captured.

### C4. Save them

```
test/research/captures/2026-10-31-normal.txt
test/research/captures/2026-10-31-aborted.txt
test/research/captures/2026-10-31-error.txt
test/research/captures/2026-10-31-notes.md
```

Put the headers at the top of each file and the raw body below, unedited.
The notes file holds your answers to the C1 checklist, the Chrome version,
and anything that surprised you.

**Check before committing**: the captures contain a real conversation with the
service. They should contain only the synthetic values above, but read
through them once and redact anything else.

---

## What to send me

1. Which checkboxes failed, with the console output for each
2. The screenshot from B3
3. The `replacements` number from B2
4. The capture files from Part C

With C1 in hand I can write the frame parser and the restoration transform
properly, which is Phase 7 and the last thing standing between this and a
tool that actually works end to end.
