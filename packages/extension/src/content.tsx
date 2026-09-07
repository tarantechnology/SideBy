/**
 * Isolated-world content script. Runs on the streaming services and the
 * room server's pages. Mounts the overlay in a Shadow DOM so the page's CSS
 * cannot reach it, then hands over to the shared session.
 */
import { startSession } from './session.js';
import themeCss from './ui/theme.css';

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

  // Keep typing/shortcuts inside the overlay from reaching the page's hotkeys.
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  // Players fullscreen a specific element; ride along so we stay visible.
  document.addEventListener('fullscreenchange', () => {
    const target = document.fullscreenElement ?? document.body;
    if (host.parentElement !== target) target.appendChild(host);
  });

  const bus = new EventTarget();

  // Capture phase: players stop keydown propagation at the document.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      e.stopPropagation();
      bus.dispatchEvent(new Event('toggle-debug'));
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg: { type?: string; open?: boolean }) => {
    if (msg?.type === 'sideby:toggle') bus.dispatchEvent(new Event(msg.open ? 'open-card' : 'toggle-card'));
  });

  await startSession({ surface: 'page', mountPoint, host, bus });
}

const boot = () => mount().catch((err) => console.error('[sideby] overlay failed to mount', err));
if (document.body) void boot();
else document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
