/** MAIN-world entry for hulu.com: owns the real adapter, serves it to the overlay. */
import { installAdapter } from '../../bridge/serve.js';
import { HuluAdapter } from './HuluAdapter.js';

installAdapter(() => new HuluAdapter());
