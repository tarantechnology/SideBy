import { useCallback, useEffect, useState } from 'react';
import type { AdapterProxy } from '../bridge/AdapterProxy.js';
import type { PeerCall } from '../rtc/PeerCall.js';
import type { SyncEngine } from '../sync/SyncEngine.js';
import { CameraTile } from './CameraTile.js';
import { Card } from './Card.js';
import { Countdown } from './Countdown.js';
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
  const [cardOpen, setCardOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [idle, setIdle] = useState(false);

  const toggleCard = useCallback(() => setCardOpen((v) => !v), []);
  // ⌘⇧D opens the card straight to Advanced.
  const toggleDebug = useCallback(() => { setCardOpen(true); setAdvancedOpen((v) => !v); }, []);

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
      <Pill view={view} sync={sync} idle={idle} cardOpen={cardOpen} onClick={toggleCard} />
      {call && sync.roomId && <CameraTile call={call} peerName={sync.peer?.name} />}
      {sync.startsInMs > 0 && <Countdown startsInMs={sync.startsInMs} />}
      {cardOpen && (
        <Card
          adapter={adapter} view={view} sync={sync} engine={engine} call={call}
          inviteLink={inviteLink} unavailable={unavailable}
          advancedOpen={advancedOpen} onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
          onInvite={onInvite} onLeave={onLeave} onJoin={onJoin} onClose={() => setCardOpen(false)}
          transportKind={transportKind} onTransportChange={onTransportChange}
        />
      )}
    </div>
  );
}
