/** MAIN-world entry for Netflix: owns the real adapter, serves it to the overlay. */
import { serveAdapter } from '../../bridge/serve.js';
import { NetflixAdapter } from './NetflixAdapter.js';

declare global {
  interface Window {
    __sidebyAdapter?: NetflixAdapter | import('../mock/MockAdapter.js').MockAdapter;
  }
}

if (!window.__sidebyAdapter) {
  const adapter = new NetflixAdapter();
  window.__sidebyAdapter = adapter;
  serveAdapter(adapter);
}
