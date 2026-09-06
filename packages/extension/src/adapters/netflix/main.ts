/**
 * MAIN-world entry. Owns the real NetflixAdapter and exposes it to the
 * isolated-world content script over window.postMessage.
 */
import { NetflixAdapter } from './NetflixAdapter.js';
import { BRIDGE_CHANNEL, isBridgeMessage, type BridgeMessage } from '../../bridge/messages.js';

declare global {
  interface Window {
    __sidebyAdapter?: NetflixAdapter;
  }
}

if (!window.__sidebyAdapter) {
  const adapter = new NetflixAdapter();
  window.__sidebyAdapter = adapter;

  const post = (msg: BridgeMessage) => window.postMessage(msg, location.origin);

  adapter.on((event) => post({ channel: BRIDGE_CHANNEL, kind: 'evt', event }));

  const hello = () =>
    post({
      channel: BRIDGE_CHANNEL,
      kind: 'hello',
      service: adapter.service,
      state: adapter.getState(),
      health: adapter.getHealth(),
      content: adapter.getContentInfo(),
    });

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !isBridgeMessage(ev.data)) return;
    const msg = ev.data;
    if (msg.kind === 'hello') return; // our own announcement echoing back
    if (msg.kind !== 'req') return;
    try {
      let value: unknown;
      switch (msg.method) {
        case 'play': await adapter.play(); break;
        case 'pause': await adapter.pause(); break;
        case 'seek': await adapter.seek(Number(msg.args[0])); break;
        case 'setPlaybackRate': await adapter.setPlaybackRate(Number(msg.args[0])); break;
        case 'setVolume': await adapter.setVolume(Number(msg.args[0])); break;
        case 'getState': value = adapter.getState(); break;
        case 'getContentInfo': value = adapter.getContentInfo(); break;
        case 'getHealth': value = adapter.getHealth(); break;
      }
      post({ channel: BRIDGE_CHANNEL, kind: 'res', id: msg.id, ok: true, value });
    } catch (err) {
      post({ channel: BRIDGE_CHANNEL, kind: 'res', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  hello();
  // The isolated script may attach after us; keep announcing until it asks.
  const helloTimer = window.setInterval(hello, 1000);
  window.addEventListener('message', (ev) => {
    if (ev.source === window && isBridgeMessage(ev.data) && ev.data.kind === 'req') window.clearInterval(helloTimer);
  }, { once: true });
}
