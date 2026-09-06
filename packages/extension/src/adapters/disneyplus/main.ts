/** MAIN-world entry for disneyplus.com: owns the real adapter, serves it to the overlay. */
import { installAdapter } from '../../bridge/serve.js';
import { DisneyPlusAdapter } from './DisneyPlusAdapter.js';

installAdapter(() => new DisneyPlusAdapter());
