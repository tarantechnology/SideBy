import { Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PeerCall } from '../rtc/PeerCall.js';
import { useCall } from './useCall.js';

interface Props {
  call: PeerCall;
  peerName?: string;
}

interface Box { x: number; y: number; w: number; h: number }

const MIN_W = 160;
const MAX_W = 640;
const ASPECT = 4 / 3;
const MARGIN = 18;
const STORAGE_KEY = 'sideby:tile';

function defaultBox(): Box {
  const w = 240;
  const h = w / ASPECT;
  return { x: window.innerWidth - w - MARGIN, y: window.innerHeight - h - MARGIN - 80, w, h };
}

function clamp(b: Box): Box {
  const w = Math.min(MAX_W, Math.max(MIN_W, b.w));
  const h = w / ASPECT;
  return {
    w, h,
    x: Math.min(window.innerWidth - w - MARGIN, Math.max(MARGIN, b.x)),
    y: Math.min(window.innerHeight - h - MARGIN, Math.max(MARGIN, b.y)),
  };
}

/**
 * The friend's camera, floating over the movie. Draggable anywhere,
 * resizable from the corner, remembers where you left it.
 */
export function CameraTile({ call, peerName }: Props) {
  const snap = useCall(call);
  const [box, setBox] = useState<Box>(defaultBox);
  const [hover, setHover] = useState(false);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const selfRef = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; start: Box } | null>(null);

  useEffect(() => {
    void chrome.storage.local.get(STORAGE_KEY).then((got) => {
      const saved = got[STORAGE_KEY] as Box | undefined;
      if (saved) setBox(clamp(saved));
    });
    const onResize = () => setBox((b) => clamp(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const el = remoteRef.current;
    if (!el) return;
    if (el.srcObject !== call.getRemoteStream()) el.srcObject = call.getRemoteStream();
    el.volume = snap.remoteVolume;
  });
  useEffect(() => {
    const local = call.getLocalStream();
    if (selfRef.current && selfRef.current.srcObject !== local) selfRef.current.srcObject = local;
  }, [call, snap.media]);

  const onPointerDown = (mode: 'move' | 'resize') => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, start: box };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === 'move') setBox(clamp({ ...d.start, x: d.start.x + dx, y: d.start.y + dy }));
    else setBox(clamp({ ...d.start, w: d.start.w + dx }));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    void chrome.storage.local.set({ [STORAGE_KEY]: box });
  };

  const label = snap.status === 'connected'
    ? (snap.remoteHasVideo ? null : `${peerName ?? 'Friend'} · camera off`)
    : snap.status === 'no-peer' ? 'Waiting for your friend'
    : snap.status === 'failed' ? 'Couldn’t connect camera'
    : snap.status === 'reconnecting' ? 'Reconnecting camera'
    : 'Connecting camera';

  return (
    <div
      className={`sb-tile sb-material${hover ? ' sb-tile--hover' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={onPointerDown('move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <video ref={remoteRef} className="sb-tile__remote" autoPlay playsInline />
      {label && <div className="sb-tile__label">{label}</div>}
      {snap.media === 'on' && <video ref={selfRef} className={`sb-tile__self${snap.camOn ? '' : ' sb-tile__self--off'}`} autoPlay playsInline muted />}
      <div className="sb-tile__controls">
        <button className={`sb-tile__btn${snap.micOn ? '' : ' sb-tile__btn--off'}`} title={snap.micOn ? 'Mute' : 'Unmute'} onPointerDown={(e) => e.stopPropagation()} onClick={() => call.toggleMic()} disabled={snap.media !== 'on'}>
          {snap.micOn ? <Mic size={14} /> : <MicOff size={14} />}
        </button>
        <button className={`sb-tile__btn${snap.camOn ? '' : ' sb-tile__btn--off'}`} title={snap.camOn ? 'Turn camera off' : 'Turn camera on'} onPointerDown={(e) => e.stopPropagation()} onClick={() => (snap.media === 'on' ? call.toggleCam() : void call.enableMedia())}>
          {snap.camOn && snap.media === 'on' ? <Video size={14} /> : <VideoOff size={14} />}
        </button>
      </div>
      <div className="sb-tile__grip" onPointerDown={onPointerDown('resize')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
    </div>
  );
}
