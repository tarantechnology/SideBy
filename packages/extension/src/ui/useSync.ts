import { useSyncExternalStore } from 'react';
import type { SyncEngine, SyncSnapshot } from '../sync/SyncEngine.js';

export function useSync(engine: SyncEngine): SyncSnapshot {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.getSnapshot(),
    () => engine.getSnapshot(),
  );
}
