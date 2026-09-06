import { roomCode } from '@sideby/shared';
import { LogOut, Play, Users } from 'lucide-react';
import { useState } from 'react';
import type { SyncEngine } from '../sync/SyncEngine.js';
import { formatClock } from './format.js';
import { useSync } from './useSync.js';

interface Props {
  engine: SyncEngine;
  onJoin: (roomId: string) => void;
  onLeave: () => void;
}

export function SyncPanel({ engine, onJoin, onLeave }: Props) {
  const sync = useSync(engine);
  const [code, setCode] = useState('');
  const inRoom = sync.roomId !== null;

  const driftClass = sync.driftMs === null ? '' : Math.abs(sync.driftMs) < sync.config.deadbandMs ? 'sb-ok' : Math.abs(sync.driftMs) < sync.config.hardSeekMs ? 'sb-warn' : 'sb-bad';
  const tl = sync.timeline;

  return (
    <>
      <div className="sb-panel__head">
        <span className="sb-panel__title">Sync</span>
        <span className="sb-muted sb-mono" style={{ fontSize: 11 }}>{inRoom ? `${sync.status} · ${sync.role}` : 'not in a room'}</span>
      </div>
      {!inRoom ? (
        <div className="sb-row">
          <input
            className="sb-input sb-mono"
            placeholder="room code"
            value={code}
            spellCheck={false}
            onChange={(e) => setCode(e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter' && code) onJoin(code); }}
          />
          <button className="sb-btn" style={{ flex: '0 0 auto' }} disabled={!code} onClick={() => onJoin(code)}>Join</button>
          <button className="sb-btn sb-btn--on" style={{ flex: '0 0 auto' }} onClick={() => { const c = roomCode(); setCode(c); onJoin(c); }}>Create</button>
        </div>
      ) : (
        <>
          <dl className="sb-kv">
            <dt>Room</dt><dd>{sync.roomId}</dd>
            <dt>Members</dt><dd><Users size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{sync.members.length}</dd>
            <dt>Revision</dt><dd>{tl?.revision ?? '—'}{tl?.updatedBy ? ` · ${tl.updatedBy.slice(0, 5)}` : ''}</dd>
            <dt>Room state</dt><dd>{tl ? (tl.holds.length ? `held (${tl.holds.length})` : sync.startsInMs > 0 ? `starts in ${(sync.startsInMs / 1000).toFixed(1)}s` : tl.playing ? 'playing' : 'paused') : '—'}</dd>
            <dt>Expected</dt><dd>{sync.expectedMs === null ? '—' : formatClock(sync.expectedMs)}</dd>
            <dt>Drift</dt><dd className={driftClass}>{sync.driftMs === null ? '—' : `${sync.driftMs > 0 ? '+' : ''}${Math.round(sync.driftMs)} ms`}{sync.correction !== 'none' ? ` · ${sync.correction}` : ''}</dd>
            <dt>Seek lead</dt><dd>{sync.seekLeadMs} ms · rtt {Math.round(sync.rttMs)} ms</dd>
            <dt>Sent</dt><dd>{sync.lastSent ?? '—'}</dd>
            <dt>Received</dt><dd>{sync.lastReceived ?? '—'}{sync.rejected ? ` · ${sync.rejected} rejected` : ''}</dd>
            {sync.contentMismatch && (<><dt>Content</dt><dd className="sb-warn">room is on {tl?.contentId}</dd></>)}
          </dl>
          <div className="sb-row" style={{ marginTop: 8 }}>
            <button className="sb-btn sb-btn--on" onClick={() => engine.startTogether(3000)}><Play size={13} />Start together</button>
            <button className="sb-btn" style={{ flex: '0 0 auto' }} onClick={onLeave}><LogOut size={13} />Leave</button>
          </div>
          <div className="sb-row" style={{ marginTop: 6 }}>
            <Threshold label="dead" value={sync.config.deadbandMs} onChange={(v) => engine.setConfig({ deadbandMs: v })} />
            <Threshold label="seek" value={sync.config.hardSeekMs} onChange={(v) => engine.setConfig({ hardSeekMs: v })} />
            <Threshold label="nudge" value={Math.round(sync.config.nudge * 1000)} suffix="‰" onChange={(v) => engine.setConfig({ nudge: v / 1000 })} />
          </div>
        </>
      )}
    </>
  );
}

function Threshold({ label, value, suffix = 'ms', onChange }: { label: string; value: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="sb-field">
      <span>{label}</span>
      <input className="sb-input sb-input--num sb-mono" type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
      <span>{suffix}</span>
    </label>
  );
}
