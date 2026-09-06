import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import type { VideoAdapter } from '../adapters/VideoAdapter.js';
import type { SyncEngine } from '../sync/SyncEngine.js';
import { formatClock, formatDurationShort } from './format.js';
import { SyncPanel } from './SyncPanel.js';
import type { AdapterView } from './useAdapter.js';

interface Props {
  adapter: VideoAdapter;
  view: AdapterView;
  engine: SyncEngine;
  onJoin: (roomId: string) => void;
  onLeave: () => void;
}

const RATES = [0.98, 1, 1.02] as const;
const SEEK_STEP_MS = 10_000;

export function DebugPanel({ adapter, view, engine, onJoin, onLeave }: Props) {
  const { state, health, content, connected, log } = view;
  const ready = connected && state.ready;
  const run = (label: string, fn: () => Promise<void>) => () => {
    fn().catch((err) => console.warn(`[sideby] ${label} failed`, err));
  };

  const pathClass = health.path === 'netflix-api' ? 'sb-ok' : health.path === 'video-element' ? 'sb-warn' : 'sb-bad';

  return (
    <div className="sb-panel sb-material">
      <div className="sb-panel__head">
        <span className="sb-panel__title">Player</span>
        <span className="sb-muted sb-mono" style={{ fontSize: 11 }}>{connected ? `${health.polls} polls` : 'not connected'}</span>
      </div>
      <dl className="sb-kv">
        <dt>Content</dt><dd title={content.title}>{state.contentId ?? '—'}{content.title ? ` · ${content.title}` : ''}</dd>
        <dt>Time</dt><dd>{formatClock(state.currentTimeMs)}</dd>
        <dt>Duration</dt><dd>{formatDurationShort(state.durationMs)}</dd>
        <dt>State</dt><dd className={state.playing ? 'sb-ok' : ''}>{state.ended ? 'ended' : state.playing ? 'playing' : 'paused'}{state.seeking ? ' · seeking' : ''}</dd>
        <dt>Buffering</dt><dd className={state.buffering ? 'sb-warn' : ''}>{state.buffering ? 'yes' : 'no'}</dd>
        <dt>Rate</dt><dd>{state.playbackRate.toFixed(2)}×</dd>
        <dt>Ready</dt><dd className={state.ready ? 'sb-ok' : 'sb-warn'}>{state.ready ? 'yes' : 'no'}</dd>
      </dl>
      <div className="sb-sep" />
      <div className="sb-row">
        <button className="sb-btn" disabled={!ready} onClick={run('seek-', () => adapter.seek(state.currentTimeMs - SEEK_STEP_MS))}><RotateCcw size={13} />10s</button>
        <button className={`sb-btn${state.playing ? '' : ' sb-btn--on'}`} disabled={!ready} onClick={run('play', () => adapter.play())}><Play size={13} />Play</button>
        <button className={`sb-btn${state.playing ? ' sb-btn--on' : ''}`} disabled={!ready} onClick={run('pause', () => adapter.pause())}><Pause size={13} />Pause</button>
        <button className="sb-btn" disabled={!ready} onClick={run('seek+', () => adapter.seek(state.currentTimeMs + SEEK_STEP_MS))}>10s<RotateCw size={13} /></button>
      </div>
      <div className="sb-row">
        {RATES.map((r) => (
          <button
            key={r}
            className={`sb-btn sb-mono${Math.abs(state.playbackRate - r) < 0.001 ? ' sb-btn--on' : ''}`}
            disabled={!ready}
            onClick={run('rate', () => adapter.setPlaybackRate(r))}
          >
            {r.toFixed(2)}×
          </button>
        ))}
      </div>
      <div className="sb-sep" />
      <SyncPanel engine={engine} onJoin={onJoin} onLeave={onLeave} />
      <div className="sb-sep" />
      <div className="sb-panel__head">
        <span className="sb-panel__title">Adapter</span>
      </div>
      <dl className="sb-kv">
        <dt>Path</dt><dd className={pathClass}>{health.path}</dd>
        <dt>API / video</dt><dd>{health.apiFound ? 'api' : '—'} / {health.videoFound ? 'video' : '—'}</dd>
        <dt>Calls</dt><dd>▶{health.playCalls} ⏸{health.pauseCalls} ⇄{health.seekCalls} ×{health.rateCalls}</dd>
        <dt>Failures</dt><dd className={health.failedCalls ? 'sb-warn' : ''}>{health.failedCalls}{health.consecutiveReadErrors ? ` (${health.consecutiveReadErrors} in a row)` : ''}</dd>
        <dt>Attached</dt><dd>{health.attachedAtMs ? formatDurationShort(Date.now() - health.attachedAtMs) : '—'}</dd>
        {health.lastError && (<><dt>Last error</dt><dd className="sb-bad" title={health.lastError}>{health.lastError}</dd></>)}
      </dl>
      {log.length > 0 && (
        <div className="sb-log">{log.map((line, i) => <div key={i}>{line}</div>)}</div>
      )}
    </div>
  );
}
