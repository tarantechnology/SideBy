import { roomCode } from '@sideby/shared';
import { useState } from 'react';
import type { VideoAdapter } from '../adapters/VideoAdapter.js';
import type { SyncEngine } from '../sync/SyncEngine.js';
import { formatClock, formatDurationShort } from './format.js';
import type { AdapterView } from './useAdapter.js';
import { useSync } from './useSync.js';

interface Props {
  adapter: VideoAdapter;
  view: AdapterView;
  engine: SyncEngine;
  onJoin: (roomId: string) => void;
  onLeave: () => void;
  transportKind: 'local' | 'ws';
  onTransportChange: (kind: 'local' | 'ws') => void;
}

const RATES = [0.98, 1, 1.02] as const;

/** Diagnostics and developer knobs. Nothing here is needed to watch a movie. */
export function AdvancedPanel({ adapter, view, engine, onJoin, onLeave, transportKind, onTransportChange }: Props) {
  const sync = useSync(engine);
  const { state, health, content, connected, log } = view;
  const [code, setCode] = useState('');
  const tl = sync.timeline;
  const drift = sync.driftMs;
  const driftClass = drift === null ? '' : Math.abs(drift) < sync.config.deadbandMs ? 'sb-ok' : Math.abs(drift) < sync.config.hardSeekMs ? 'sb-warn' : 'sb-bad';

  return (
    <div className="sb-advanced">
      <Section title="Sync" aside={sync.roomId ? `${sync.status} · ${sync.role}` : 'not in a room'}>
        {sync.roomId ? (
          <dl className="sb-kv">
            <dt>Room</dt><dd>{sync.roomId} · {sync.members.length} member{sync.members.length === 1 ? '' : 's'}</dd>
            <dt>Revision</dt><dd>{tl?.revision ?? '—'}{tl?.updatedBy ? ` · ${tl.updatedBy.slice(0, 5)}` : ''}</dd>
            <dt>Room</dt><dd>{tl ? (tl.holds.length ? `held by ${tl.holds.length}` : sync.startsInMs > 0 ? `starts in ${(sync.startsInMs / 1000).toFixed(1)}s` : sync.roomPlaying ? 'playing' : 'paused') : '—'}</dd>
            <dt>Expected</dt><dd>{sync.expectedMs === null ? '—' : formatClock(sync.expectedMs)}</dd>
            <dt>Drift</dt><dd className={driftClass}>{drift === null ? '—' : `${drift > 0 ? '+' : ''}${Math.round(drift)} ms`}{sync.correction !== 'none' ? ` · ${sync.correction}` : ''}</dd>
            <dt>Latency</dt><dd>rtt {Math.round(sync.rttMs)} ms · seek lead {sync.seekLeadMs} ms</dd>
            <dt>Last sent</dt><dd>{sync.lastSent ?? '—'}</dd>
            <dt>Last received</dt><dd>{sync.lastReceived ?? '—'}{sync.rejected ? ` · ${sync.rejected} rejected` : ''}</dd>
          </dl>
        ) : (
          <>
            <div className="sb-segmented">
              <button className={transportKind === 'ws' ? 'sb-segmented__on' : ''} onClick={() => onTransportChange('ws')}>Server</button>
              <button className={transportKind === 'local' ? 'sb-segmented__on' : ''} onClick={() => onTransportChange('local')}>Local tabs</button>
            </div>
            <div className="sb-row" style={{ marginTop: 8 }}>
              <input className="sb-input" placeholder="Room code" value={code} spellCheck={false} onChange={(e) => setCode(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Enter' && code) onJoin(code); }} />
              <button className="sb-btn" style={{ flex: '0 0 auto' }} disabled={!code} onClick={() => onJoin(code)}>Join</button>
              <button className="sb-btn" style={{ flex: '0 0 auto' }} onClick={() => { const c = roomCode(); setCode(c); onJoin(c); }}>New</button>
            </div>
          </>
        )}
        <div className="sb-row" style={{ marginTop: 8 }}>
          <Threshold label="Ignore under" value={sync.config.deadbandMs} onChange={(v) => engine.setConfig({ deadbandMs: v })} />
          <Threshold label="Seek over" value={sync.config.hardSeekMs} onChange={(v) => engine.setConfig({ hardSeekMs: v })} />
          <Threshold label="Nudge" value={Math.round(sync.config.nudge * 1000)} suffix="‰" onChange={(v) => engine.setConfig({ nudge: v / 1000 })} />
        </div>
        {sync.roomId && (
          <div className="sb-row" style={{ marginTop: 8 }}>
            <button className="sb-btn" onClick={onLeave}>Leave room</button>
          </div>
        )}
      </Section>

      <Section title="Player" aside={connected ? `${health.polls} samples` : 'not connected'}>
        <dl className="sb-kv">
          <dt>Title</dt><dd title={content.title}>{state.contentId ?? '—'}{content.title ? ` · ${content.title}` : ''}</dd>
          <dt>Position</dt><dd>{formatClock(state.currentTimeMs)} / {formatDurationShort(state.durationMs)}</dd>
          <dt>State</dt><dd className={state.playing ? 'sb-ok' : ''}>{state.ended ? 'ended' : state.playing ? 'playing' : 'paused'}{state.seeking ? ' · seeking' : ''}{state.buffering ? ' · buffering' : ''}</dd>
          <dt>Rate</dt><dd>{state.playbackRate.toFixed(2)}×</dd>
          <dt>Audio</dt><dd>{state.muted ? 'muted' : `${Math.round(state.volume * 100)}%`}</dd>
        </dl>
        <div className="sb-segmented" style={{ marginTop: 8 }}>
          {RATES.map((r) => (
            <button key={r} className={Math.abs(state.playbackRate - r) < 0.001 ? 'sb-segmented__on' : ''} disabled={!state.ready} onClick={() => void adapter.setPlaybackRate(r).catch(() => undefined)}>{r.toFixed(2)}×</button>
          ))}
        </div>
      </Section>

      <Section title="Adapter">
        <dl className="sb-kv">
          <dt>Control path</dt><dd className={health.path === 'netflix-api' ? 'sb-ok' : health.path === 'video-element' ? 'sb-warn' : 'sb-bad'}>{health.path}</dd>
          <dt>Calls</dt><dd>play {health.playCalls} · pause {health.pauseCalls} · seek {health.seekCalls} · rate {health.rateCalls}</dd>
          <dt>Failures</dt><dd className={health.failedCalls ? 'sb-warn' : ''}>{health.failedCalls}{health.consecutiveReadErrors ? ` (${health.consecutiveReadErrors} in a row)` : ''}</dd>
          <dt>Attached</dt><dd>{health.attachedAtMs ? formatDurationShort(Date.now() - health.attachedAtMs) : '—'}</dd>
          {health.lastError && (<><dt>Last error</dt><dd className="sb-bad" title={health.lastError}>{health.lastError}</dd></>)}
        </dl>
        {log.length > 0 && <div className="sb-log">{log.slice(0, 8).map((line, i) => <div key={i}>{line}</div>)}</div>}
      </Section>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
  return (
    <section className="sb-section">
      <div className="sb-panel__head">
        <span className="sb-panel__title">{title}</span>
        {aside && <span className="sb-panel__aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Threshold({ label, value, suffix = 'ms', onChange }: { label: string; value: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="sb-field" title={label}>
      <span className="sb-field__label">{label}</span>
      <input className="sb-input sb-input--num" type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
      <span>{suffix}</span>
    </label>
  );
}
