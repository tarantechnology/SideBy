/** MAIN-world entry for the dev mock page (served by the room server at /mock). */
import { installAdapter } from '../../bridge/serve.js';
import { MockAdapter } from './MockAdapter.js';

function boot() {
  const video = document.querySelector('video');
  if (!video) return;
  const contentId = new URLSearchParams(location.search).get('content') ?? 'mock';
  installAdapter(() => new MockAdapter(video, contentId));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
