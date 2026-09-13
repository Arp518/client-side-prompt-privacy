/**
 * test-harness.js — a minimal fake browser for exercising the BUILT BUNDLE
 * in Node.
 *
 * inject.js runs in the page's own JS realm and patches window.fetch, so the
 * only faithful way to test it outside Chrome is to give it a `window`, load
 * the real bundle into a sandboxed context, and drive fetch calls through it.
 * That is what this provides.
 *
 * Testing the bundle rather than the source matters: it catches esbuild
 * problems (a tree-shaken detector, a broken CJS shim) that source-level
 * tests would sail straight past.
 *
 * Shared by leak-test.js, endpoint-test.js, and — later — the response
 * stream tests.
 */

'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_PATH = path.join(__dirname, '..', 'dist', 'inject.bundle.js');

/**
 * Build a sandbox with a fake `window` and a stub backend.
 *
 * @param {{ sseBody?: string, origin?: string }} [opts]
 * @returns {{
 *   sandbox: object,
 *   win: object,
 *   relayed: Array<{kind: string, payload: any}>,
 *   sentBodies: Array<string|null>,
 *   requestedUrls: Array<string>,
 *   kinds: () => Array<string>,
 *   relayedJson: () => string
 * }}
 */
function buildSandbox(opts) {
  const options = opts || {};
  const origin = options.origin || 'https://chatgpt.com';
  const sseBody =
    options.sseBody || 'data: {"v":"hello"}\n\ndata: [DONE]\n\n';

  const relayed = [];
  const sentBodies = [];
  const requestedUrls = [];

  // Stands in for ChatGPT's backend: records what actually left the
  // "browser" and returns a streamed response, so the tee()/stream path is
  // exercised rather than skipped.
  async function originalFetch(input, init) {
    const isRequest =
      typeof input === 'object' && input !== null && 'url' in input;

    requestedUrls.push(isRequest ? input.url : String(input));
    sentBodies.push(
      isRequest ? await input.clone().text() : (init && init.body) || null
    );

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  const win = {
    fetch: originalFetch,
    location: { href: `${origin}/`, origin },
    postMessage(msg /*, targetOrigin */) {
      relayed.push(msg);
    },
    addEventListener() {},
  };

  const sandbox = {
    window: win,
    self: win,
    location: win.location,
    console: { log() {}, warn() {}, error() {} },
    Request,
    Response,
    Headers,
    URL,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;

  return {
    sandbox,
    win,
    relayed,
    sentBodies,
    requestedUrls,
    kinds: () => relayed.map((m) => m.kind),
    relayedJson: () => JSON.stringify(relayed),
  };
}

/**
 * Load the built bundle into a sandbox. Throws a useful message rather than
 * a cryptic one if the build step was skipped.
 */
function loadBundle(harness) {
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error(
      `Bundle not found at ${BUNDLE_PATH}\nRun \`npm run build\` first.`
    );
  }
  const context = vm.createContext(harness.sandbox);
  vm.runInContext(fs.readFileSync(BUNDLE_PATH, 'utf8'), context, {
    filename: 'dist/inject.bundle.js',
  });
  return context;
}

/** Build a ChatGPT-shaped request body around one user prompt. */
function userMessageBody(prompt, extra) {
  return JSON.stringify(
    Object.assign(
      {
        action: 'next',
        conversation_id: 'abc-123',
        messages: [
          {
            id: 'msg-x',
            author: { role: 'user' },
            content: { content_type: 'text', parts: [prompt] },
          },
        ],
      },
      extra || {}
    )
  );
}

/** Let queued microtasks and the detached spy-branch reader settle. */
function settle(ms) {
  return new Promise((r) => setTimeout(r, ms === undefined ? 20 : ms));
}

// --- assertions ------------------------------------------------------------

function createReporter(title) {
  let failures = 0;
  let passes = 0;

  console.log(`\n=== ${title} ===\n`);

  return {
    group(name) {
      console.log(`  -- ${name} --`);
    },
    check(label, condition, detail) {
      if (condition) {
        passes++;
        console.log(`  PASS  ${label}`);
      } else {
        failures++;
        console.log(`  FAIL  ${label}`);
        if (detail) console.log(`        ${detail}`);
      }
    },
    done(extra) {
      const summary =
        failures === 0
          ? `all ${passes} checks passed`
          : `${failures} FAILED of ${passes + failures}`;
      console.log(`\n--- ${summary}${extra ? ` (${extra})` : ''} ---\n`);
      process.exit(failures > 0 ? 1 : 0);
    },
  };
}

/** True if `value` appears in `haystack` literally or JSON-escaped. */
function appearsIn(haystack, value) {
  if (haystack.includes(value)) return true;
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped !== value && haystack.includes(escaped);
}

module.exports = {
  BUNDLE_PATH,
  buildSandbox,
  loadBundle,
  userMessageBody,
  settle,
  createReporter,
  appearsIn,
};
