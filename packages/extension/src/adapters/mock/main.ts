/** MAIN-world entry for the dev mock page (served by the room server at /mock). */
import { serveAdapter } from '../../bridge/serve.js';
import { MockAdapter } from './MockAdapter.js';

function boot() {
  const video = document.querySelector('video');
  if (!video || window.__sidebyAdapter) return;
  const contentId = new URLSearchParams(location.search).get('content') ?? 'mock';
  const adapter = new MockAdapter(video, contentId);
  window.__sidebyAdapter = adapter;
  serveAdapter(adapter);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
