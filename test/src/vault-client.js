/**
 * vault-client.js — manages the private MAIN-world MessageChannel port
 * to the isolated-world content-bridge (Stage 5).
 *
 * The token map holds real PII values for reverse detokenization.
 * To avoid exposing real values over window.postMessage (readable by any
 * script in the page), content-bridge transfers a MessagePort here.
 * Real token deltas flow exclusively over this private port.
 */

'use strict';

function initVaultClient({ relay }) {
  let vaultPort = null;
  const pendingVaultDeltas = [];

  function sendVaultDelta(delta) {
    if (!delta || Object.keys(delta).length === 0) return;
    if (vaultPort) {
      try {
        vaultPort.postMessage({ kind: 'map-update', delta });
        return;
      } catch (e) {
        relay('error', { where: 'vault port post', message: String(e) });
        vaultPort = null;
      }
    }
    // Port not handed over yet (or it broke) — hold, bounded, and flush
    // once it arrives. Never fall back to window.postMessage for these.
    if (pendingVaultDeltas.length < 50) pendingVaultDeltas.push(delta);
  }

  window.addEventListener('message', function onHandshake(event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'pii-redact-port-offer') return;
    if (vaultPort) return; // accept exactly one port, first offer wins
    const port = event.ports && event.ports[0];
    if (!port) return;

    vaultPort = port;
    window.removeEventListener('message', onHandshake);

    while (pendingVaultDeltas.length) {
      sendVaultDelta(pendingVaultDeltas.shift());
    }
    relay('vault-channel-open', {});
  });

  return { sendVaultDelta };
}

module.exports = { initVaultClient };
