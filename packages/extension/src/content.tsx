/**
 * Isolated-world content script. Mounts the overlay in a Shadow DOM so
 * Netflix's CSS cannot reach it, and talks to the MAIN-world adapter.
 */
import { createRoot } from 'react-dom/client';
import { AdapterProxy } from './bridge/AdapterProxy.js';
import { getMemberId, getMemberToken, getStoredRoom, getTransportPreference, setStoredRoom, setTransportPreference } from './storage.js';
import { SyncEngine } from './sync/SyncEngine.js';
import { LocalTransport } from './transport/LocalTransport.js';
import type { Transport } from './transport/Transport.js';
import { WsTransport } from './transport/WsTransport.js';
import { App } from './ui/App.js';
import themeCss from './ui/theme.css';

import { buildId as __BUILD_ID__ } from 'virtual:build-id';

declare const __DEV__: boolean;
declare const __SERVER_URL__: string;

const HOST_ID = 'sideby-host';

async function mount() {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = themeCss;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  (document.body ?? document.documentElement).appendChild(host);

  // Keep typing/shortcuts inside the overlay from reaching Netflix's hotkeys.
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  // Netflix fullscreens a specific element; ride along so we stay visible.
  document.addEventListener('fullscreenchange', () => {
    const target = document.fullscreenElement ?? document.body;
    if (host.parentElement !== target) target.appendChild(host);
  });

  const adapter = new AdapterProxy();
  const bus = new EventTarget();

  // Capture phase: Netflix's player stops keydown propagation at the document.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      e.stopPropagation();
      bus.dispatchEvent(new Event('toggle-debug'));
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'sideby:toggle') bus.dispatchEvent(new Event('toggle-debug'));
  });

  // Long-lived port: keeps the service worker awake for dev reload and,
  // later, lets it know which tabs are on Netflix.
  const port = chrome.runtime.connect({ name: 'sideby-tab' });
  const keepalive = window.setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch { window.clearInterval(keepalive); } }, 20_000);

  const memberId = await getMemberId();
  const memberToken = await getMemberToken();
  let transportKind = await getTransportPreference();
  const makeTransport = (kind: 'local' | 'ws'): Transport =>
    kind === 'local' ? new LocalTransport(memberId) : new WsTransport(__SERVER_URL__, memberId, memberToken);
  let engine = new SyncEngine(adapter, makeTransport(transportKind));

  const join = (roomId: string) => {
    void setStoredRoom({ roomId, transport: transportKind, joinedAtMs: Date.now() });
    void engine.join(roomId).catch((err) => console.warn('[sideby] join failed', err));
  };
  const setTransport = (kind: 'local' | 'ws') => {
    if (kind === transportKind) return;
    engine.leave();
    transportKind = kind;
    void setTransportPreference(kind);
    engine = new SyncEngine(adapter, makeTransport(kind));
    render();
  };
  const leave = () => {
    void setStoredRoom(null);
    engine.leave();
  };

  const root = createRoot(mountPoint);
  const render = () => root.render(<App adapter={adapter} engine={engine} bus={bus} onJoin={join} onLeave={leave} transportKind={transportKind} onTransportChange={setTransport} />);
  render();
  if (__DEV__) console.info('[sideby] overlay mounted as', memberId);

  // Refresh or navigation must not lose the room: rejoin what we were in.
  const stored = await getStoredRoom();
  if (stored && Date.now() - stored.joinedAtMs < 6 * 60 * 60 * 1000) {
    if (stored.transport !== transportKind) setTransport(stored.transport);
    join(stored.roomId);
  }

  // Test bridge: the MAIN world (and automation running there) can drive
  // the engine over postMessage, since isolated-world globals are invisible.
  host.dataset.member = memberId;
  host.dataset.build = __BUILD_ID__;
  window.addEventListener('message', (ev) => {
    const msg = ev.data as { channel?: string; id?: number; cmd?: string; args?: unknown[] };
    if (ev.source !== window || msg?.channel !== 'sideby/test/v1' || !msg.cmd) return;
    let value: unknown;
    try {
      switch (msg.cmd) {
        case 'join': join(String(msg.args?.[0])); break;
        case 'leave': leave(); break;
        case 'start': engine.startTogether(Number(msg.args?.[0] ?? 3000)); break;
        case 'config': engine.setConfig(msg.args?.[0] as Record<string, number>); break;
        case 'snapshot': value = engine.getSnapshot(); break;
        case 'toggleDebug': bus.dispatchEvent(new Event('toggle-debug')); break;
      }
      window.postMessage({ channel: 'sideby/test/v1', id: msg.id, ok: true, value }, location.origin);
    } catch (err) {
      window.postMessage({ channel: 'sideby/test/v1', id: msg.id, ok: false, error: String(err) }, location.origin);
    }
  });
}

if (document.body) void mount();
else document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
