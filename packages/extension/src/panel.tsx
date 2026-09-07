/**
 * Side panel entry. The same session as the page overlay, without a player:
 * a room can start or be joined from any page, and it stays here while you
 * browse until a service tab takes the seat.
 */
import { startSession } from './session.js';
import themeCss from './ui/theme.css';

async function mount() {
  const host = document.getElementById('sideby-host')!;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = themeCss;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  const bus = new EventTarget();
  await startSession({ surface: 'panel', mountPoint, host, bus });
}

void mount().catch((err) => console.error('[sideby] panel failed to mount', err));
