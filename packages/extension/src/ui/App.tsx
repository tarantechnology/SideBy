import { useCallback, useEffect, useState } from 'react';
import type { AdapterProxy } from '../bridge/AdapterProxy.js';
import type { PeerCall } from '../rtc/PeerCall.js';
import type { SyncEngine } from '../sync/SyncEngine.js';
import { CameraTile } from './CameraTile.js';
import { DebugPanel } from './DebugPanel.js';
import { Pill } from './Pill.js';
import { useAdapter } from './useAdapter.js';
import { useSync } from './useSync.js';

interface Props {
  adapter: AdapterProxy;
  engine: SyncEngine;
  call: PeerCall | null;
  /** External toggle signal (toolbar click, keyboard shortcut). */
  bus: EventTarget;
  onJoin: (roomId: string) => void;
  onLeave: () => void;
  transportKind: 'local' | 'ws';
  onTransportChange: (kind: 'local' | 'ws') => void;
}

const IDLE_MS = 3000;

export function App({ adapter, engine, call, bus, onJoin, onLeave, transportKind, onTransportChange }: Props) {
  const view = useAdapter(adapter);
  const sync = useSync(engine);
  const [debugOpen, setDebugOpen] = useState(false);
  const [idle, setIdle] = useState(false);

  const toggleDebug = useCallback(() => setDebugOpen((v) => !v), []);

  useEffect(() => {
    const onToggle = () => toggleDebug();
    bus.addEventListener('toggle-debug', onToggle);
    return () => bus.removeEventListener('toggle-debug', onToggle);
  }, [bus, toggleDebug]);

  // Mirror Netflix: fade the pill when the mouse rests, wake it on movement.
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    window.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('keydown', wake, { passive: true });
    return () => { window.clearTimeout(timer); window.removeEventListener('mousemove', wake); window.removeEventListener('keydown', wake); };
  }, []);

  return (
    <div className="sb-root">
      <Pill view={view} sync={sync} idle={idle} debugOpen={debugOpen} onToggleDebug={toggleDebug} />
      {call && sync.roomId && <CameraTile call={call} peerName={sync.peer?.name} />}
      {debugOpen && <DebugPanel adapter={adapter} view={view} engine={engine} onJoin={onJoin} onLeave={onLeave} transportKind={transportKind} onTransportChange={onTransportChange} />}
    </div>
  );
}
