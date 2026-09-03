# Client-Side Prompt Privacy — Chrome Extension

A Chrome Extension (Manifest V3) that intercepts prompts sent from the ChatGPT web UI, detects structured PII using **regex only (no NER, no ML)**, replaces detected PII with reversible placeholder tokens **before the request leaves the browser**, and keeps the original values locally. The AI service never sees the real values.

```
User types prompt
      ↓
inject.js intercepts fetch (MAIN world)
      ↓
detector.js finds PII spans (regex)
      ↓
tokenizer.js replaces spans with placeholders
      ↓
Original values kept in local memory only
      ↓
Tokenized prompt sent to ChatGPT
      ↓
ChatGPT responds (may echo placeholders back)
      ↓
[NOT YET BUILT] Response is detokenized before the user sees it
```

---

## Current Status: Phase 1 complete, Phase 2 (response detokenization) not started

| Phase | Status |
|---|---|
| Phase 0 — fetch interception, request tampering survival, `tee()`, DOM fallback | ✅ Done, validated live |
| Phase 1 — real PII detector + tokenizer wired into `inject.js`, bundled with esbuild | ✅ Done, **not yet live-tested** |
| Phase 1.5 — `sessionMap` persisted via `chrome.storage.session` (currently in-memory only) | ❌ Not started |
| Phase 2 — response-side detokenization (restore placeholders in ChatGPT's reply) | ❌ Not started |

---

## Folder Structure

```
client-side-prompt-privacy/
└── test/                          ← this is the actual extension root Chrome loads
    ├── package.json
    ├── package-lock.json
    ├── node_modules/              (gitignored — regenerate with npm install)
    ├── manifest.json              ← points MAIN-world script at dist/inject.bundle.js
    ├── src/
    │   ├── inject.js              MAIN world — fetch interceptor, calls tokenize()
    │   ├── content-bridge.js      ISOLATED world — chrome.storage.local logging, DOM role detection
    │   ├── detector.js            standalone regex PII detector (Node-testable)
    │   ├── tokenizer.js           tokenize()/detokenize(), wraps detector.js
    │   └── smoke.js               Node test harness (not shipped to browser)
    └── dist/
        └── inject.bundle.js       (gitignored — regenerate with npm run build / esbuild)
```

**Note:** `node_modules/` and `dist/` should be in `.gitignore` — they're regenerable build artifacts, not source. If they're not already ignored, add them before your next commit.

---

## What each file does

- **`detector.js`** — Standalone regex engine. `detectPII(text)` returns spans `{start, end, type, value}`. Supports `EMAIL`, `PHONE`, `SSN`, `CREDIT_CARD` (Luhn-validated), `IPV4`, `IPV6`, `DOB` (only flagged near birth-context keywords), `STREET_ADDRESS`. Has no browser/Node-specific dependencies — pure JS, runs anywhere.
- **`tokenizer.js`** — `tokenize(text)` runs `detectPII` and replaces each span with a placeholder like `[PHONE_PLACEHOLDER_1]`, returning `{tokenizedText, map, spans}`. `detokenize(text, map)` reverses it. Placeholder numbering is per-type, assigned in left-to-right reading order.
- **`inject.js`** — Runs in the page's **MAIN world** (not the extension's isolated world) because that's the only way to see/modify `window.fetch` arguments before ChatGPT's own code calls it. Patches `fetch`, finds the `/backend-api/f/conversation` endpoint, walks the JSON body to `messages[].content.parts[]`, calls `tokenize()` on each text part, writes only `tokenizedText` back into the payload. The original values go into `sessionMap` — **never** into the JSON that gets sent. Also uses `response.body.tee()` to split the streamed reply into a UI branch (untouched, handed to ChatGPT's page) and a spy branch (currently only logged, not yet detokenized).
- **`content-bridge.js`** — Runs in the extension's **isolated world**, where `chrome.*` APIs are available. Listens for `window.postMessage` events from `inject.js` and writes them to `chrome.storage.local` for debugging. Independently watches the DOM via `MutationObserver` to detect message roles (`data-message-author-role="user"|"assistant"`) as a fallback signal.
- **`smoke.js`** — Node-only test file, run with `node src/smoke.js` (or via `test/` from repo root). Runs 13 hardcoded test cases through `detectPII` → `tokenize` → `detokenize` and checks the round trip matches the original text. **Currently: 13 passed, 0 failed.** This only proves round-trip correctness, not detection precision/recall against a labeled dataset — that's a separate testing task (see below).

---

## Why MAIN world vs ISOLATED world matters

Chrome extensions normally run content scripts in an **isolated world** — sandboxed, can't see the page's own JS variables, but *can* call `chrome.*` APIs.

`inject.js` needs to patch `window.fetch` **before ChatGPT's own code calls it**, which only works if it runs in the page's actual JS context — the **MAIN world**. The tradeoff: MAIN-world scripts **cannot** call `chrome.*` APIs at all (no `chrome.storage`, nothing).

That's why the architecture is split in two:
```
inject.js (MAIN world)
    — sees/mutates fetch, tokenizes prompts
    — can't touch chrome.storage
    ↓ window.postMessage
content-bridge.js (ISOLATED world)
    — can call chrome.storage.local / chrome.storage.session
    — currently only used for debug logging
```

---

## What has been tested so far

✅ **Node-level (`smoke.js`)**: all 13 detector/tokenizer round-trip test cases pass — email, dashed/parenthesized phone, SSN, valid & invalid Luhn credit cards, IPv4, IPv6, DOB with/without birth context, street address, multiple emails, clean text with no PII.

✅ **Phase 0 (validated live on chatgpt.com, before Phase 1 detector was wired in)**:
- Plaintext request body is visible before it leaves the browser.
- A mutated request body is accepted by ChatGPT (200 OK, coherent reply referencing injected placeholders verbatim).
- `tee()` on the streamed response doesn't break ChatGPT's own UI rendering.
- DOM fallback (`content-bridge.js`) independently confirms message role via `[data-message-author-role]`.

❌ **Not yet tested**: the bundled `inject.js` (with the real `detector.js`/`tokenizer.js` wired in, replacing the old toy `EMAIL_RE`) has **not been tested live against chatgpt.com yet**. This is the immediate next step for whoever picks this up — see "How to run and test it" below.

---

## How to set up and run this

### 1. Install dependencies
```powershell
cd client-side-prompt-privacy/test
npm install
```

### 2. Bundle `inject.js`
`inject.js` uses `require('./tokenizer')`, which only works in Node — not directly in a browser. esbuild bundles `inject.js` + `tokenizer.js` + `detector.js` into one browser-safe file.

```powershell
npx esbuild src/inject.js --bundle --outfile=dist/inject.bundle.js
```

Re-run this **every time** you edit `inject.js`, `tokenizer.js`, or `detector.js`. (Optional: add `"build": "esbuild src/inject.js --bundle --outfile=dist/inject.bundle.js"` to `package.json` scripts, then just run `npm run build`.)

### 3. Load the extension in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `test/` folder (this is the extension root — `manifest.json` lives here)

### 4. Test the detector/tokenizer standalone (no browser needed)
```powershell
node src/smoke.js
```
Should print `13 passed, 0 failed`.

### 5. Test live against ChatGPT (the step that hasn't been done yet — do this first)
1. Reload the extension in `chrome://extensions` (circular arrow icon)
2. Open a **fresh** ChatGPT tab (`https://chatgpt.com`) — MAIN-world scripts only re-inject on a real navigation, not a soft refresh
3. Open DevTools (`F12`) → **Console** tab
4. Confirm you see `[PII-REDACT PHASE0] injector active — patched window.fetch` on page load
5. Send a prompt with **non-email** PII, to prove the real detector is running (the old toy code only ever caught emails):
   ```
   Call me at 555-123-4567, my server is 192.168.1.100
   ```
6. In the console, find the `body-mutated` event and confirm `after` shows `[PHONE_PLACEHOLDER_1]` and `[IPV4_PLACEHOLDER_1]`, not the raw values, with `replacements: 2`
7. Open DevTools → **Network** tab → find the POST to `/backend-api/f/conversation` → check the actual request payload → confirm it contains the placeholders, not the raw phone number/IP. This is the real proof — console logs alone don't guarantee what left the browser.
8. Confirm ChatGPT's reply still streams in and renders normally in the UI (proves `tee()` isn't broken by the new detector).

---

## Known limitation right now: responses are NOT detokenized

If ChatGPT's reply contains a placeholder like `[PHONE_PLACEHOLDER_1]` (because it echoed the tokenized prompt back), **the user will see that raw placeholder string in the chat UI** — nothing currently converts it back to the real value. This is expected at the current stage, not a bug. See "What's next" below.

---

## What's next (in priority order)

### 1. Live-test the current code (see step 5 above) — do this first
Confirm the real detector/tokenizer is actually working end-to-end against chatgpt.com before building anything else on top of it.

### 2. Persist `sessionMap` to `chrome.storage.session`
Right now `sessionMap` in `inject.js` is a plain in-memory JS object — it's lost if the tab closes or the extension reloads. `inject.js` (MAIN world) **cannot** call `chrome.storage` directly. The flow needs to be:
```
inject.js (MAIN world)
    ↓ window.postMessage (reuse the existing relay() function)
content-bridge.js (ISOLATED world)
    ↓
chrome.storage.session.set(...)
```
`content-bridge.js` already listens for `window.addEventListener("message", ...)` — extend that handler to recognize a new message kind (e.g. `"map-update"`) and write it to `chrome.storage.session`.

### 3. Response-side detokenization
Currently `response.body.tee()`'s spy branch only logs chunk previews — it doesn't call `detokenize()` on anything, and the UI branch is passed straight through unmodified. To fix:
- ChatGPT's streamed response is likely SSE-style JSON events, not raw text — inspect the actual shape in DevTools → Network → the response's EventStream view before writing the parser.
- Placeholders can be split across stream chunk boundaries (e.g. `[PHONE_PLA` in one chunk, `CEHOLDER_1]` in the next) — naive per-chunk `detokenize()` calls will miss these. Needs a buffering approach: hold back text from the last unresolved `[` onward, only flush once a full token or definitely-not-a-token text is confirmed.
- Build a wrapping `ReadableStream` around `uiBranch` (not just `spyBranch`) that runs each chunk through the buffered detokenize logic and re-encodes it, since `uiBranch` is what the user actually sees — right now it's passed to `new Response()` completely untouched.

### 4. Move from AES-less in-memory storage to actual encryption
The original project spec calls for encrypting `sessionMap` values with the **Web Crypto API (AES-GCM)** before persisting them — not just storing them plaintext in `chrome.storage.session`. Not implemented yet; currently out of scope until step 2 (storage plumbing) is solid.

### 5. Detection quality testing
`smoke.js` proves round-trip correctness on 13 hand-picked cases, not real-world precision/recall. Build a larger labeled test set and measure:
- **Precision** — of everything flagged as PII, how much actually was PII
- **Recall** — of everything that actually was PII, how much got flagged
- **Processing time** — latency per prompt

### 6. Handle non-JSON / unexpected payload shapes gracefully
`findTextParts()` in `inject.js` assumes ChatGPT's request shape is `messages[].content.parts[]`. If ChatGPT changes this (they update their frontend periodically), the extension will silently stop tokenizing anything and log `no-text-parts-found`. Worth periodically re-checking via the Network tab, and eventually adding an alert/fallback rather than silent failure.

---

## Explicitly out of scope for now

- NER / ML-based detection (regex only, by design)
- Multi-platform support (Gemini, Claude, etc. — ChatGPT only for now)
- A backend server or centralized PII database (everything must stay client-side)
- IndexedDB (currently using `chrome.storage.session` instead — simpler for this scope; can revisit later per the original spec doc)