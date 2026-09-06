import { Bug } from 'lucide-react';
import type { SyncSnapshot } from '../sync/SyncEngine.js';
import type { AdapterView } from './useAdapter.js';

interface Props {
  view: AdapterView;
  sync: SyncSnapshot;
  idle: boolean;
  debugOpen: boolean;
  onToggleDebug: () => void;
}

export function Pill({ view, sync, idle, debugOpen, onToggleDebug }: Props) {
  const { state, connected, health } = view;
  let dot = 'sb-pill__dot';
  let sub: string;
  if (!connected || !state.contentId) { sub = 'Waiting for Netflix'; }
  else if (!state.ready) { dot += ' sb-pill__dot--warn'; sub = 'Loading player'; }
  else if (health.path === 'none') { dot += ' sb-pill__dot--bad'; sub = 'No player'; }
  else if (sync.roomId) {
    const drift = sync.driftMs === null ? 0 : Math.abs(sync.driftMs);
    if (sync.status !== 'connected') { dot += ' sb-pill__dot--warn'; sub = 'Connecting'; }
    else if (sync.contentMismatch) { dot += ' sb-pill__dot--warn'; sub = 'Different title'; }
    else if (sync.startsInMs > 0) { dot += ' sb-pill__dot--ok'; sub = `Starting in ${Math.ceil(sync.startsInMs / 1000)}`; }
    else if (sync.correction === 'seek' || drift >= sync.config.hardSeekMs) { dot += ' sb-pill__dot--warn'; sub = 'Resyncing'; }
    else if (sync.correction !== 'none') { dot += ' sb-pill__dot--ok'; sub = 'Catching up'; }
    else { dot += ' sb-pill__dot--ok'; sub = sync.members.length > 1 ? 'In sync' : 'Waiting for friend'; }
  }
  else { dot += ' sb-pill__dot--ok'; sub = state.playing ? 'Playing' : 'Paused'; }

  return (
    <div className={`sb-pill sb-material${idle && !debugOpen ? ' sb-pill--idle' : ''}`}>
      <span className={dot} />
      <span className="sb-pill__label">Sideby</span>
      <span className="sb-pill__sub">· {sub}</span>
      <button className="sb-pill__btn" title="Debug panel (⌘⇧D)" onClick={onToggleDebug} aria-pressed={debugOpen}>
        <Bug size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
