import { useSyncExternalStore } from 'react';
import type { CallSnapshot, PeerCall } from '../rtc/PeerCall.js';

export function useCall(call: PeerCall): CallSnapshot {
  return useSyncExternalStore((cb) => call.subscribe(cb), () => call.getSnapshot(), () => call.getSnapshot());
}
