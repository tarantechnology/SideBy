import type { VideoAdapter } from '../adapters/VideoAdapter.js';
import { BRIDGE_CHANNEL, isBridgeMessage, type BridgeMessage } from './messages.js';

declare global {
  interface Window {
    /** The MAIN-world adapter, for the isolated world's bridge and for automation. */
    __sidebyAdapter?: VideoAdapter;
  }
}

/**
 * MAIN-world entry helper: constructs the service's adapter once per page
 * and serves it to the isolated world over window.postMessage.
 */
export function installAdapter(create: () => VideoAdapter): void {
  if (window.__sidebyAdapter) return;
  const adapter = create();
  window.__sidebyAdapter = adapter;
  serveAdapter(adapter);
}

/** Exposes a MAIN-world adapter to the isolated world over window.postMessage. */
export function serveAdapter(adapter: VideoAdapter): void {
  const post = (msg: BridgeMessage) => window.postMessage(msg, location.origin);
  adapter.on((event) => post({ channel: BRIDGE_CHANNEL, kind: 'evt', event }));
  const hello = () => post({ channel: BRIDGE_CHANNEL, kind: 'hello', service: adapter.service, state: adapter.getState(), health: adapter.getHealth(), content: adapter.getContentInfo() });

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !isBridgeMessage(ev.data) || ev.data.kind !== 'req') return;
    const msg = ev.data;
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
  const helloTimer = window.setInterval(hello, 1000);
  window.addEventListener('message', (ev) => {
    if (ev.source === window && isBridgeMessage(ev.data) && ev.data.kind === 'req') window.clearInterval(helloTimer);
  }, { once: true });
}
