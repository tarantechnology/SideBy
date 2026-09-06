import { useCallback, useEffect, useState } from 'react';
import type { AdapterProxy } from '../bridge/AdapterProxy.js';
import type { PeerCall } from '../rtc/PeerCall.js';
import type { SyncEngine } from '../sync/SyncEngine.js';
import { CameraTile } from './CameraTile.js';
import { Countdown } from './Countdown.js';
import { DebugPanel } from './DebugPanel.js';
import { InviteCard } from './InviteCard.js';
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
  onInvite: () => void;
  inviteLink: string | null;
  unavailable: boolean;
  transportKind: 'local' | 'ws';
  onTransportChange: (kind: 'local' | 'ws') => void;
}

const IDLE_MS = 3000;

export function App({ adapter, engine, call, bus, onJoin, onLeave, onInvite, inviteLink, unavailable, transportKind, onTransportChange }: Props) {
  const view = useAdapter(adapter);
  const sync = useSync(engine);
  const [debugOpen, setDebugOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [idle, setIdle] = useState(false);

  const toggleDebug = useCallback(() => setDebugOpen((v) => !v), []);
  const toggleCard = useCallback(() => setCardOpen((v) => !v), []);

  useEffect(() => {
    const onToggle = () => toggleDebug();
    const onCard = () => toggleCard();
    const onOpenCard = () => setCardOpen(true);
    bus.addEventListener('toggle-debug', onToggle);
    bus.addEventListener('toggle-card', onCard);
    bus.addEventListener('open-card', onOpenCard);
    return () => { bus.removeEventListener('toggle-debug', onToggle); bus.removeEventListener('toggle-card', onCard); bus.removeEventListener('open-card', onOpenCard); };
  }, [bus, toggleDebug, toggleCard]);

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
      <Pill view={view} sync={sync} idle={idle} debugOpen={debugOpen} onToggleDebug={toggleDebug} onClick={toggleCard} />
      {call && sync.roomId && <CameraTile call={call} peerName={sync.peer?.name} />}
      {sync.startsInMs > 0 && <Countdown startsInMs={sync.startsInMs} />}
      {cardOpen && !debugOpen && (
        <InviteCard view={view} sync={sync} inviteLink={inviteLink} unavailable={unavailable} onInvite={onInvite} onStart={() => engine.startTogether(3000)} onLeave={() => { onLeave(); }} onClose={() => setCardOpen(false)} />
      )}
      {debugOpen && <DebugPanel adapter={adapter} view={view} engine={engine} onJoin={onJoin} onLeave={onLeave} transportKind={transportKind} onTransportChange={onTransportChange} />}
    </div>
  );
}
