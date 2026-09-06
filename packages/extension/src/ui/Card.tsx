import { Check, ChevronRight, Copy, Link2, LogOut, Mic, MicOff, Pause, Play, RotateCcw, RotateCw, Video, VideoOff, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Readiness } from '@sideby/shared';
import { currentService } from '../adapters/services.js';
import type { VideoAdapter } from '../adapters/VideoAdapter.js';
import type { PeerCall } from '../rtc/PeerCall.js';
import type { SyncEngine, SyncSnapshot } from '../sync/SyncEngine.js';
import { AdvancedPanel } from './AdvancedPanel.js';
import { formatClock } from './format.js';
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
  blocked: 'concurrent' | null;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  onInvite: () => void;
  onLeave: () => void;
  onJoin: (roomId: string) => void;
  onClose: () => void;
  transportKind: 'local' | 'ws';
  onTransportChange: (kind: 'local' | 'ws') => void;
}

const SKIP_MS = 10_000;
const SERVICE_NAME = currentService()?.name ?? 'the service';

/**
 * The one surface a viewer sees. Invite → friend joins → both ready →
 * start together. Then transport controls, two volumes, camera, leave.
 * Advanced folds away diagnostics.
 */
export function Card(props: Props) {
  const { view, sync, engine, call, adapter, inviteLink, unavailable, blocked, advancedOpen, onToggleAdvanced, onInvite, onLeave, onClose } = props;
  const inRoom = sync.roomId !== null;
  return (
    <div className="sb-card sb-material">
      <div className="sb-card__head">
        <span className="sb-card__title">{inRoom ? 'Watching together' : ''}</span>
        <button className="sb-iconbtn" onClick={onClose} title="Close"><X size={14} /></button>
      </div>

      {blocked === 'concurrent' && (
        <p className="sb-card__warn">Netflix is already playing on this account in another tab or browser. Close it, then reload this page.</p>
      )}

      {!inRoom ? (
        <div className="sb-hero">
          <div className="sb-hero__glyph" aria-hidden="true"><span /><span /></div>
          <div className="sb-hero__title">{view.content.title ?? 'Watch together'}</div>
          <div className="sb-hero__sub">{view.state.contentId ? 'Watch it in sync with a friend.' : 'Open a movie or episode first.'}</div>
          <button className="sb-btn sb-btn--primary sb-btn--lg" disabled={!view.state.contentId} onClick={onInvite}>
            <Link2 size={14} />Invite a friend
          </button>
        </div>
      ) : (
        <RoomBody view={view} sync={sync} engine={engine} call={call} adapter={adapter} inviteLink={inviteLink} unavailable={unavailable} onLeave={onLeave} />
      )}

      <button className={`sb-disclosure${advancedOpen ? ' sb-disclosure--open' : ''}`} onClick={onToggleAdvanced} aria-expanded={advancedOpen}>
        <ChevronRight size={13} className="sb-disclosure__chev" />Advanced
      </button>
      {advancedOpen && (
        <AdvancedPanel adapter={adapter} view={view} engine={engine} onJoin={props.onJoin} onLeave={onLeave} transportKind={props.transportKind} onTransportChange={props.onTransportChange} />
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
  const started = sync.roomPlaying || (sync.timeline?.anchorMediaMs ?? 0) > 2000 || (sync.timeline?.revision ?? 0) > 3;
  // A coordinated start is offered once, before anything has played. After
  // that the shared movie is driven by the transport controls below.
  const offerStart = bothReady && !started && !counting;
  const state = view.state;
  const ready = view.connected && state.ready;
  const run = (fn: () => Promise<void>) => () => { fn().catch(() => undefined); };

  return (
    <>
      {inviteLink && (
        <button className={`sb-linkrow${copied ? ' sb-linkrow--copied' : ''}`} onClick={() => void copy()} title="Copy invite link">
          <span className="sb-linkrow__url">{inviteLink.replace('https://www.', '')}</span>
          <span className="sb-linkrow__icon">{copied ? <Check size={14} /> : <Copy size={14} />}</span>
        </button>
      )}

      <div className="sb-people">
        <Person label="You" readiness={me} connected unavailable={unavailable} />
        <Person label="Friend" readiness={peerReady} connected={!!peer?.connected} present={!!peer} />
      </div>
      {unavailable && <p className="sb-card__warn">This title isn’t available on your {SERVICE_NAME} plan or region. Sideby can’t work around that, but you can pick another title together.</p>}
      {sync.contentMismatch && !unavailable && <p className="sb-card__hint">Taking you to the right title…</p>}

      {(offerStart || counting) && (
        <button className="sb-btn sb-btn--primary sb-btn--lg" style={{ marginTop: 12 }} disabled={counting} onClick={() => engine.startTogether(3000)}>
          <Play size={13} />{counting ? 'Starting…' : 'Start together'}
        </button>
      )}

      <div className="sb-transport" style={{ marginTop: 12 }}>
        <button className="sb-btn sb-btn--icon" disabled={!ready} onClick={run(() => adapter.seek(state.currentTimeMs - SKIP_MS))} title="Back 10 seconds"><RotateCcw size={15} /></button>
        <button className="sb-btn sb-btn--icon sb-btn--main" disabled={!ready} onClick={run(() => (state.playing ? adapter.pause() : adapter.play()))} title={state.playing ? 'Pause for both' : 'Play for both'}>
          {state.playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="sb-btn sb-btn--icon" disabled={!ready} onClick={run(() => adapter.seek(state.currentTimeMs + SKIP_MS))} title="Forward 10 seconds"><RotateCw size={15} /></button>
        <span className="sb-transport__time">{formatClock(state.currentTimeMs).replace(/\.\d$/, '')}<span className="sb-transport__status"> · {syncWord(sync, peer?.connected ?? false)}</span></span>
      </div>

      <VolumeRows view={view} adapter={adapter} call={call} />

      <div className="sb-row" style={{ marginTop: 12 }}>
        {call && <CallButtons call={call} />}
        <button className="sb-btn" style={{ marginLeft: 'auto', flex: '0 0 auto' }} onClick={onLeave} title="Leave the room"><LogOut size={13} />Leave</button>
      </div>
    </>
  );
}

function syncWord(sync: SyncSnapshot, peerConnected: boolean): string {
  if (!peerConnected) return 'waiting for friend';
  if (sync.startsInMs > 0) return `starting in ${Math.ceil(sync.startsInMs / 1000)}`;
  if ((sync.timeline?.holds.length ?? 0) > 0) return 'waiting for buffer or ad';
  if (sync.correction === 'seek') return 'resyncing';
  if (sync.correction !== 'none') return 'catching up';
  return sync.roomPlaying ? 'in sync' : 'paused together';
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
      <span className="sb-volume__val">{value}</span>
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
  else if (!readiness?.loggedIn) { status = `Signing in to ${SERVICE_NAME}`; tone = 'warn'; }
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
