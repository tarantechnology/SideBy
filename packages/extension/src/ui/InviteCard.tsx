import { Check, Copy, Link2, LogOut, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Readiness } from '@sideby/shared';
import type { SyncSnapshot } from '../sync/SyncEngine.js';
import type { AdapterView } from './useAdapter.js';

interface Props {
  view: AdapterView;
  sync: SyncSnapshot;
  inviteLink: string | null;
  unavailable: boolean;
  onInvite: () => void;
  onStart: () => void;
  onLeave: () => void;
  onClose: () => void;
}

/**
 * The product surface: one card that takes you from "alone on Netflix" to
 * "watching together". Invite → friend joins → both ready → start together.
 */
export function InviteCard({ view, sync, inviteLink, unavailable, onInvite, onStart, onLeave, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (!inviteLink) return;
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); } catch { /* clipboard blocked; link is still visible */ }
  };

  const me = sync.readiness;
  const peer = sync.peer;
  const peerReady = peer?.readiness;
  const bothReady = !!peer?.connected && me.contentMatch && me.playerReady && !!peerReady?.contentMatch && !!peerReady?.playerReady;
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
          <div className="sb-row" style={{ marginTop: 10 }}>
            <button className="sb-btn sb-btn--on" disabled={!bothReady || sync.startsInMs > 0} onClick={onStart} title={bothReady ? 'Start playback for both of you on a shared countdown' : 'Waits until both players are ready'}>
              <Play size={13} />{sync.startsInMs > 0 ? 'Starting…' : 'Start together'}
            </button>
            <button className="sb-btn" style={{ flex: '0 0 auto' }} onClick={onLeave} title="Leave the room"><LogOut size={13} /></button>
          </div>
        </>
      )}
    </div>
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
