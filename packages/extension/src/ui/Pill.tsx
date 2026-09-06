import { Bug } from 'lucide-react';
import type { AdapterView } from './useAdapter.js';

interface Props {
  view: AdapterView;
  idle: boolean;
  debugOpen: boolean;
  onToggleDebug: () => void;
}

export function Pill({ view, idle, debugOpen, onToggleDebug }: Props) {
  const { state, connected, health } = view;
  let dot = 'sb-pill__dot';
  let sub: string;
  if (!connected || !state.contentId) { sub = 'Waiting for Netflix'; }
  else if (!state.ready) { dot += ' sb-pill__dot--warn'; sub = 'Loading player'; }
  else if (health.path === 'none') { dot += ' sb-pill__dot--bad'; sub = 'No player'; }
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
