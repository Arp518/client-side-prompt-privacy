# Response captures

Raw captures of the service's streamed response, recorded by hand from
DevTools. These are what the Phase 7 restoration transform is written and
tested against.

Naming: `YYYY-MM-DD-<case>.txt`, where case is `normal`, `aborted` or
`error`, plus a `-notes.md` per session.

Each file: response headers at the top, raw body below, unedited.

The procedure is in `../../BROWSER-CHECK.md`, Part C. Do not paste a fetch
wrapper into the console to produce these; the extension already patches
fetch and the second wrapper breaks both.

Captures record a real conversation with the service. Use only the synthetic
values from BROWSER-CHECK.md, and read through a capture once before
committing it.
