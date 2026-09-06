/**
 * Isolated-world content script. Mounts the overlay in a Shadow DOM so
 * Netflix's CSS cannot reach it, and talks to the MAIN-world adapter.
 */
import { createRoot } from 'react-dom/client';
import { AdapterProxy } from './bridge/AdapterProxy.js';
import { App } from './ui/App.js';
import themeCss from './ui/theme.css';

declare const __DEV__: boolean;

const HOST_ID = 'sideby-host';

function mount() {
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

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      bus.dispatchEvent(new Event('toggle-debug'));
    }
  });

  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'sideby:toggle') bus.dispatchEvent(new Event('toggle-debug'));
  });

  // Long-lived port: keeps the service worker awake for dev reload and,
  // later, lets it know which tabs are on Netflix.
  const port = chrome.runtime.connect({ name: 'sideby-tab' });
  const keepalive = window.setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch { window.clearInterval(keepalive); } }, 20_000);

  createRoot(mountPoint).render(<App adapter={adapter} bus={bus} />);
  if (__DEV__) console.info('[sideby] overlay mounted');
}

if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount, { once: true });
