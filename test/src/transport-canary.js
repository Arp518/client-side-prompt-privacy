/**
 * transport-canary.js — watches non-fetch transports for ChatGPT conversation sends.
 *
 * This extension patches window.fetch. If OpenAI moves conversation requests to
 * XMLHttpRequest, sendBeacon, or WebSocket, this extension would silently stop
 * redacting prompts while still appearing active.
 *
 * This canary monitors those transports in observe-only mode and warns loudly
 * without altering or dropping requests.
 */

'use strict';

function looksLikeConversationUrl(url) {
  try {
    const raw = typeof url === 'string' ? url : url && (url.url || url.href);
    if (typeof raw !== 'string') return false;
    return /\/backend-api\/[^?#]*conversation/i.test(raw);
  } catch (e) {
    return false;
  }
}

function installTransportCanary({ relay, logPrefix = '[PII-REDACT PHASE0]' }) {
  function warnUninterceptedTransport(transport, detail) {
    relay('unintercepted-transport', { transport, ...detail });
    console.warn(
      `${logPrefix} ${transport} was used for a conversation request. ` +
        `This extension only masks fetch(), so that request was NOT redacted. ` +
        `The interception point needs updating.`
    );
  }

  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
      const originalOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        try {
          if (looksLikeConversationUrl(url)) {
            warnUninterceptedTransport('XMLHttpRequest', { method });
          }
        } catch (e) {
          /* observation must never break the page */
        }
        return originalOpen.apply(this, arguments);
      };
    }
  } catch (e) {
    relay('error', { where: 'canary/xhr', message: String(e) });
  }

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const originalBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        try {
          if (looksLikeConversationUrl(url)) {
            warnUninterceptedTransport('sendBeacon', {});
          }
        } catch (e) {
          /* ignore */
        }
        return originalBeacon(url, data);
      };
    }
  } catch (e) {
    relay('error', { where: 'canary/sendBeacon', message: String(e) });
  }

  try {
    const OriginalWebSocket = window.WebSocket;
    if (typeof OriginalWebSocket === 'function') {
      // A Proxy keeps the prototype, static constants, and instanceof intact.
      window.WebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
          try {
            if (looksLikeConversationUrl(args[0])) {
              warnUninterceptedTransport('WebSocket', {});
            }
          } catch (e) {
            /* ignore */
          }
          return Reflect.construct(target, args);
        },
      });
    }
  } catch (e) {
    relay('error', { where: 'canary/websocket', message: String(e) });
  }
}

module.exports = { installTransportCanary, looksLikeConversationUrl };
