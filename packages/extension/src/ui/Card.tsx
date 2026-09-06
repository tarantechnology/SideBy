import { Check, ChevronRight, Copy, Link2, LogOut, Mic, MicOff, Play, Video, VideoOff, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Readiness } from '@sideby/shared';
import type { VideoAdapter } from '../adapters/VideoAdapter.js';
import type { PeerCall } from '../rtc/PeerCall.js';
import type { SyncEngine, SyncSnapshot } from '../sync/SyncEngine.js';
import { AdvancedPanel } from './AdvancedPanel.js';
import type { AdapterView } from './useAdapter.js';
import { useCall } from './useCall.js';

interface Props {
  adapter: VideoAdapter;
  view: AdapterView;
  sync: SyncSnapshot;
  engine: SyncEngine;
  call: PeerCall | null;
  inviteLink: string | null;
  unavailable: boolean;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  onInvite: () => void;
  onLeave: () => void;
  onJoin: (roomId: string) => void;
  onClose: () => void;
  transportKind: 'local' | 'ws';
  onTransportChange: (kind: 'local' | 'ws') => void;
}

/**
 * The one surface a viewer sees. Invite → friend joins → both ready →
 * start together. One volume for the movie and the friend. Advanced folds
 * away everything else.
 */
export function Card(props: Props) {
  const { view, sync, engine, call, inviteLink, unavailable, advancedOpen, onToggleAdvanced, onInvite, onLeave, onClose } = props;
  const inRoom = sync.roomId !== null;
  return (
    <div className="sb-card sb-material">
      <div className="sb-card__head">
        <span className="sb-card__title">{inRoom ? 'Watching together' : 'Watch together'}</span>
        <button className="sb-pill__btn" onClick={onClose} title="Close"><X size={14} /></button>
      </div>

      {!inRoom ? (
        <>
          <p className="sb-card__text">Invite a friend. Their camera floats over the movie, and you both control one shared playhead.</p>
          <button className="sb-btn sb-btn--on sb-btn--lg" disabled={!view.state.contentId} onClick={onInvite}>
            <Link2 size={14} />Invite a friend
          </button>
          {!view.state.contentId && <p className="sb-card__hint">Open a movie or episode first.</p>}
        </>
      ) : (
        <RoomBody view={view} sync={sync} engine={engine} call={call} adapter={props.adapter} inviteLink={inviteLink} unavailable={unavailable} onLeave={onLeave} />
      )}

      <button className={`sb-disclosure${advancedOpen ? ' sb-disclosure--open' : ''}`} onClick={onToggleAdvanced} aria-expanded={advancedOpen}>
        <ChevronRight size={13} className="sb-disclosure__chev" />Advanced
      </button>
      {advancedOpen && (
        <AdvancedPanel adapter={props.adapter} view={view} engine={engine} onJoin={props.onJoin} onLeave={onLeave} transportKind={props.transportKind} onTransportChange={props.onTransportChange} />
      )}
    </div>
  );
}

function RoomBody({ view, sync, engine, call, adapter, inviteLink, unavailable, onLeave }: {
  view: AdapterView; sync: SyncSnapshot; engine: SyncEngine; call: PeerCall | null; adapter: VideoAdapter;
  inviteLink: string | null; unavailable: boolean; onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    if (!inviteLink) return;
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); } catch { /* link stays visible */ }
  };

  const me = sync.readiness;
  const peer = sync.peer;
  const peerReady = peer?.readiness;
  const bothReady = !!peer?.connected && me.contentMatch && me.playerReady && !!peerReady?.contentMatch && !!peerReady?.playerReady;
  const counting = sync.startsInMs > 0;
  // Only offer a coordinated start while the shared movie is stopped.
  const canStart = bothReady && !sync.roomPlaying && !counting;
  const resume = (sync.timeline?.anchorMediaMs ?? 0) > 2000;

  return (
    <>
      {inviteLink && (
        <button className={`sb-linkrow${copied ? ' sb-linkrow--copied' : ''}`} onClick={() => void copy()} title="Copy invite link">
          <span className="sb-linkrow__url sb-mono">{inviteLink.replace('https://www.', '')}</span>
          <span className="sb-linkrow__icon">{copied ? <Check size={14} /> : <Copy size={14} />}</span>
        </button>
      )}
      <div className="sb-people">
        <Person label="You" readiness={me} connected unavailable={unavailable} />
        <Person label="Friend" readiness={peerReady} connected={!!peer?.connected} present={!!peer} />
      </div>
      {unavailable && <p className="sb-card__warn">This title isn’t available on your Netflix plan or region. Sideby can’t work around that, but you can pick another title together.</p>}
      {sync.contentMismatch && !unavailable && <p className="sb-card__hint">Taking you to the right title…</p>}

      {(canStart || counting) && (
        <button className="sb-btn sb-btn--on sb-btn--lg" style={{ marginTop: 10 }} disabled={counting} onClick={() => engine.startTogether(3000)}>
          <Play size={13} />{counting ? 'Starting…' : resume ? 'Resume together' : 'Start together'}
        </button>
      )}
      {sync.roomPlaying && !counting && <p className="sb-card__hint" style={{ marginTop: 10 }}>Playing in sync. Use Netflix’s controls as usual; your friend follows.</p>}

      <VolumeRows view={view} adapter={adapter} call={call} />

      <div className="sb-row" style={{ marginTop: 10 }}>
        {call && <CallButtons call={call} />}
        <button className="sb-btn" style={{ flex: '0 0 auto', marginLeft: 'auto' }} onClick={onLeave} title="Leave"><LogOut size={13} />Leave</button>
      </div>
    </>
  );
}

/** Two sliders: what you hear of the movie, and what you hear of your friend. */
function VolumeRows({ view, adapter, call }: { view: AdapterView; adapter: VideoAdapter; call: PeerCall | null }) {
  const snap = call ? useCall(call) : null;
  const movie = Math.round((view.state.muted ? 0 : view.state.volume) * 100);
  const friend = Math.round((snap?.remoteVolume ?? 1) * 100);
  return (
    <div className="sb-volumes">
      <VolumeRow label="Movie" value={movie} onChange={(v) => void adapter.setVolume(v / 100).catch(() => undefined)} />
      {call && <VolumeRow label="Friend" value={friend} disabled={!snap?.remoteHasAudio} onChange={(v) => call.setRemoteVolume(v / 100)} />}
    </div>
  );
}

function VolumeRow({ label, value, disabled = false, onChange }: { label: string; value: number; disabled?: boolean; onChange: (v: number) => void }) {
  const Icon = value === 0 ? VolumeX : value < 50 ? Volume1 : Volume2;
  return (
    <label className={`sb-volume${disabled ? ' sb-volume--disabled' : ''}`} title={disabled ? `${label} audio not connected yet` : `${label} volume`}>
      <span className="sb-volume__label">{label}</span>
      <Icon size={14} className="sb-volume__icon" />
      <input className="sb-slider" type="range" min={0} max={100} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${label} volume`} />
      <span className="sb-volume__val sb-mono">{value}</span>
    </label>
  );
}

function CallButtons({ call }: { call: PeerCall }) {
  const snap = useCall(call);
  const on = snap.media === 'on';
  return (
    <>
      <button className={`sb-btn sb-btn--icon${on && !snap.micOn ? ' sb-btn--danger' : ''}`} disabled={!on} onClick={() => call.toggleMic()} title={snap.micOn ? 'Mute microphone' : 'Unmute microphone'}>
        {on && snap.micOn ? <Mic size={14} /> : <MicOff size={14} />}
      </button>
      <button className={`sb-btn sb-btn--icon${on && !snap.camOn ? ' sb-btn--danger' : ''}`} onClick={() => (on ? call.toggleCam() : void call.enableMedia())} title={on ? (snap.camOn ? 'Turn camera off' : 'Turn camera on') : 'Turn camera on'}>
        {on && snap.camOn ? <Video size={14} /> : <VideoOff size={14} />}
      </button>
      {snap.media === 'denied' && <span className="sb-card__hint" style={{ margin: 0, alignSelf: 'center' }}>Camera blocked in Chrome</span>}
    </>
  );
}

function Person({ label, readiness, connected, present = true, unavailable = false }: { label: string; readiness?: Readiness; connected: boolean; present?: boolean; unavailable?: boolean }) {
  let status: string;
  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  if (!present) status = 'Waiting to join';
  else if (!connected) { status = 'Reconnecting'; tone = 'warn'; }
  else if (unavailable) { status = 'Title unavailable'; tone = 'warn'; }
  else if (!readiness?.loggedIn) { status = 'Signing in to Netflix'; tone = 'warn'; }
  else if (!readiness.contentMatch) { status = 'Opening the title'; tone = 'warn'; }
  else if (!readiness.playerReady) { status = 'Loading player'; tone = 'warn'; }
  else { status = readiness.cameraReady ? 'Ready · camera on' : 'Ready'; tone = 'ok'; }
  return (
    <div className="sb-person">
      <span className={`sb-person__dot sb-person__dot--${tone}`} />
      <span className="sb-person__name">{label}</span>
      <span className="sb-person__status">{status}</span>
    </div>
  );
}
