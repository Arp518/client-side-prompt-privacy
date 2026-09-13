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

  // Real listener dispatch, so the MAIN-world port handshake can be
  // exercised. postMessage records everything (that array IS the
  // page-observable surface the leak test inspects) and also delivers to
  // registered listeners with `ports` populated from the transfer list.
  const listeners = { message: [] };

  const win = {
    fetch: originalFetch,
    location: { href: `${origin}/`, origin },
    postMessage(msg, _targetOrigin, transfer) {
      relayed.push(msg);
      const event = {
        data: msg,
        origin,
        source: win,
        ports: transfer || [],
      };
      for (const fn of [...listeners.message]) fn(event);
    },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      const i = listeners[type].indexOf(fn);
      if (i !== -1) listeners[type].splice(i, 1);
    },
  };

  // Stand-ins for the transports the canary watches. Each records calls and
  // then behaves inertly, so the canary can be exercised without a network.
  const transportCalls = [];

  function FakeXHR() {}
  FakeXHR.prototype.open = function (method, url) {
    transportCalls.push({ transport: 'xhr', method, url });
  };
  FakeXHR.prototype.send = function () {};

  function FakeWebSocket(url) {
    transportCalls.push({ transport: 'ws', url });
    this.url = url;
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;

  const navigatorStub = {
    sendBeacon(url) {
      transportCalls.push({ transport: 'beacon', url });
      return true;
    },
  };

  win.XMLHttpRequest = FakeXHR;
  win.WebSocket = FakeWebSocket;

  const sandbox = {
    window: win,
    self: win,
    navigator: navigatorStub,
    Proxy,
    Reflect,
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
    listeners,
    relayed,
    transportCalls,
    navigator: navigatorStub,
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

/**
 * A linked pair of MessagePort-alikes.
 *
 * Deliberately not Node's real MessageChannel: those are worker_threads
 * ports whose lifecycle keeps the event loop alive and whose delivery is
 * async, both of which make tests flaky for no benefit. Transfer semantics
 * are a browser guarantee; what needs testing is our own handshake and
 * message handling.
 */
function makePortPair() {
  const a = { onmessage: null, _peer: null, postMessage: null, closed: false };
  const b = { onmessage: null, _peer: null, postMessage: null, closed: false };

  const send = (from) => (data) => {
    if (from.closed) throw new Error('port closed');
    const peer = from._peer;
    if (peer && typeof peer.onmessage === 'function') {
      peer.onmessage({ data });
    }
  };

  a._peer = b;
  b._peer = a;
  a.postMessage = send(a);
  b.postMessage = send(b);
  a.close = () => { a.closed = true; };
  b.close = () => { b.closed = true; };

  return [a, b];
}

/**
 * In-memory stand-in for the chrome.* surface sw.js and content-bridge.js
 * use. Returns the fake plus the backing stores, so tests can assert on
 * what was actually persisted and to which key.
 */
function fakeChrome() {
  const session = {};
  const local = {};
  const listeners = { message: [], tabRemoved: [] };

  const area = (store) => ({
    async get(key) {
      if (key === undefined || key === null) return { ...store };
      if (typeof key === 'string') {
        return Object.prototype.hasOwnProperty.call(store, key)
          ? { [key]: store[key] }
          : {};
      }
      const out = {};
      for (const k of key) if (k in store) out[k] = store[k];
      return out;
    },
    async set(obj) {
      Object.assign(store, obj);
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete store[k];
    },
  });

  const chrome = {
    storage: { session: area(session), local: area(local) },
    runtime: {
      onMessage: {
        addListener(fn) {
          listeners.message.push(fn);
        },
      },
      /** Route a message to the worker's listeners and resolve its reply. */
      sendMessage(msg, sender) {
        return new Promise((resolve) => {
          const fullSender = sender || { tab: { id: 1 } };
          let answered = false;
          const respond = (r) => {
            if (!answered) {
              answered = true;
              resolve(r);
            }
          };
          for (const fn of listeners.message) fn(msg, fullSender, respond);
        });
      },
    },
    tabs: {
      onRemoved: {
        addListener(fn) {
          listeners.tabRemoved.push(fn);
        },
      },
    },
  };

  return {
    chrome,
    session,
    local,
    closeTab: (tabId) => {
      for (const fn of listeners.tabRemoved) fn(tabId);
    },
  };
}

/** Load sw.js into a context wired to a fake chrome. */
function loadServiceWorker(fake) {
  const swPath = path.join(__dirname, 'sw.js');
  const ctx = vm.createContext({
    chrome: fake.chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(swPath, 'utf8'), ctx, { filename: 'src/sw.js' });
  return ctx;
}

module.exports = {
  BUNDLE_PATH,
  makePortPair,
  fakeChrome,
  loadServiceWorker,
  buildSandbox,
  loadBundle,
  userMessageBody,
  settle,
  createReporter,
  appearsIn,
};
