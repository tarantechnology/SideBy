/** MAIN-world entry for netflix.com: owns the real adapter, serves it to the overlay. */
import { installAdapter } from '../../bridge/serve.js';
import { NetflixAdapter } from './NetflixAdapter.js';

installAdapter(() => new NetflixAdapter());
