/**
 * Isolated-world content script. Mounts the overlay in a Shadow DOM so
 * the service's CSS cannot reach it, and talks to the MAIN-world adapter.
 */
import { createRoot } from 'react-dom/client';
import { AdapterProxy } from './bridge/AdapterProxy.js';
import { roomCode } from '@sideby/shared';
import { currentService } from './adapters/services.js';
import { buildInviteLink, clearPendingJoin, consumeInviteParam, contentIdFromPath, getPendingJoin, isLoginOrGate, isUnavailable, markUnavailable, netflixShowsConcurrentStreams, serviceShowsUnavailable, setPendingJoin, watchUrl, type PendingJoin } from './invite.js';
import { PeerCall } from './rtc/PeerCall.js';
import { getMemberId, getMemberToken, getStoredRoom, getTransportPreference, setStoredRoom, setTransportPreference } from './storage.js';
import { SyncEngine } from './sync/SyncEngine.js';
import { LocalTransport } from './transport/LocalTransport.js';
import type { Transport } from './transport/Transport.js';
import { WsTransport } from './transport/WsTransport.js';
import { App } from './ui/App.js';
import themeCss from './ui/theme.css';

import { buildId as __BUILD_ID__ } from 'virtual:build-id';

declare const __DEV__: boolean;
declare const __SERVER_URL__: string;

const HOST_ID = 'sideby-host';

async function mount() {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = themeCss;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  (document.body ?? document.documentElement).appendChild(host);

  // Keep typing/shortcuts inside the overlay from reaching Netflix's hotkeys.
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  // Netflix fullscreens a specific element; ride along so we stay visible.
  document.addEventListener('fullscreenchange', () => {
    const target = document.fullscreenElement ?? document.body;
    if (host.parentElement !== target) target.appendChild(host);
  });

  const adapter = new AdapterProxy();
  const bus = new EventTarget();

  // Capture phase: Netflix's player stops keydown propagation at the document.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      e.stopPropagation();
      bus.dispatchEvent(new Event('toggle-debug'));
    }
  }, true);

  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'sideby:toggle') bus.dispatchEvent(new Event('toggle-card'));
  });

  // Long-lived port: keeps the service worker awake for dev reload and,
  // later, lets it know which tabs are on Netflix.
  const port = chrome.runtime.connect({ name: 'sideby-tab' });
  const keepalive = window.setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch { window.clearInterval(keepalive); } }, 20_000);

  const memberId = await getMemberId();
  const memberToken = await getMemberToken();
  let transportKind = await getTransportPreference();
  const makeTransport = (kind: 'local' | 'ws'): Transport =>
    kind === 'local' ? new LocalTransport(memberId) : new WsTransport(__SERVER_URL__, memberId, memberToken);
  let transport = makeTransport(transportKind);
  let engine = new SyncEngine(adapter, transport);
  let call: PeerCall | null = null;

  const setupCall = () => {
    call?.stop();
    call = null;
    if (transport.kind !== 'ws') return;
    call = new PeerCall(transport);
    call.start();
    call.subscribe(() => engine.setCameraReady(call?.getSnapshot().media === 'on'));
  };
  setupCall();

  const join = (roomId: string) => {
    void setStoredRoom({ roomId, transport: transportKind, joinedAtMs: Date.now(), contentId: currentContentId() });
    void engine.join(roomId).catch((err) => console.warn('[sideby] join failed', err));
    // Camera is opt-in per session and must never gate sync.
    if (call && call.getSnapshot().media === 'off') void call.enableMedia();
  };
  const setTransport = (kind: 'local' | 'ws') => {
    if (kind === transportKind) return;
    engine.leave();
    transportKind = kind;
    void setTransportPreference(kind);
    transport = makeTransport(kind);
    engine = new SyncEngine(adapter, transport);
    unfollow();
    unfollow = followRoomContent();
    setupCall();
    render();
  };
  const leave = () => {
    void setStoredRoom(null);
    void clearPendingJoin();
    engine.leave();
    call?.disableMedia();
    inviteLink = null;
    render();
  };

  let inviteLink: string | null = null;
  let unavailable = false;
  let blocked: 'concurrent' | null = null;
  /** The streaming service this page belongs to; null on the dev mock page, which never navigates. */
  const service = currentService();
  const isNetflix = service?.id === 'netflix';
  /** Navigate this tab to a title on the current service (no-op off-service). */
  const goToTitle = (contentId: string) => {
    const url = watchUrl(contentId);
    if (url) location.assign(url);
  };
  /** Current title id: the adapter knows best; the URL is the fallback before it attaches. */
  const currentContentId = () => adapter.getState().contentId ?? contentIdFromPath();

  /** Host flow: create a server room for the current title and hand back a link. */
  const invite = () => {
    const contentId = currentContentId();
    if (!contentId) return;
    if (transportKind !== 'ws') setTransport('ws');
    const roomId = roomCode();
    inviteLink = buildInviteLink(contentId, roomId);
    join(roomId);
    void navigator.clipboard.writeText(inviteLink).catch(() => undefined);
    bus.dispatchEvent(new Event('open-card'));
    render();
  };

  /**
   * Guest flow. The link may land on login, a profile gate, or the wrong
   * page; the pending record survives all of that until we are on the title.
   */
  const continuePendingJoin = async (pending: PendingJoin) => {
    const here = currentContentId();
    if (pending.contentId && here !== pending.contentId) {
      if (!service || isLoginOrGate()) return; // The service is handling sign-in; we'll be back.
      if (await isUnavailable(pending.contentId)) { unavailable = true; render(); return; }
      if (pending.navAttempts >= 2) {
        // The service keeps bouncing us away from this title: treat as unavailable.
        await markUnavailable(pending.contentId);
        unavailable = true;
        render();
        return;
      }
      await setPendingJoin({ ...pending, navAttempts: pending.navAttempts + 1 });
      goToTitle(pending.contentId);
      return;
    }
    if (transportKind !== 'ws') setTransport('ws');
    if (pending.contentId) inviteLink = buildInviteLink(pending.contentId, pending.roomId);
    join(pending.roomId);
    await clearPendingJoin();
    bus.dispatchEvent(new Event('open-card'));
    render();
  };

  /** Follow the room when it moves to another title (friend navigated, or autoplay). */
  let navigatedTo: string | null = null;
  const followRoomContent = () => engine.subscribe(() => {
    const snap = engine.getSnapshot();
    if (!snap.roomId || !snap.timeline?.contentId) return;
    const target = snap.timeline.contentId;
    if (service && snap.contentMismatch && navigatedTo !== target && !isLoginOrGate()) {
      navigatedTo = target;
      void isUnavailable(target).then((bad) => {
        if (bad) { unavailable = true; render(); return; }
        void setPendingJoin({ roomId: snap.roomId!, contentId: target, service: service.id, createdAtMs: Date.now(), navAttempts: 1 });
        goToTitle(target);
      });
    }
  });
  let unfollow = followRoomContent();

  const root = createRoot(mountPoint);
  const render = () => root.render(<App adapter={adapter} engine={engine} call={call} bus={bus} onJoin={join} onLeave={leave} onInvite={invite} inviteLink={inviteLink} unavailable={unavailable} blocked={blocked} transportKind={transportKind} onTransportChange={setTransport} />);
  render();
  if (__DEV__) console.info('[sideby] overlay mounted as', memberId);

  // Arriving via an invite link? Remember it before the service redirects us anywhere.
  const fromLink = consumeInviteParam();
  if (fromLink) await setPendingJoin(fromLink);
  const pending = fromLink ?? (await getPendingJoin());
  if (pending) {
    await continuePendingJoin(pending);
  } else {
    // Refresh or navigation must not lose the room: rejoin what we were in.
    const stored = await getStoredRoom();
    if (stored && Date.now() - stored.joinedAtMs < 6 * 60 * 60 * 1000) {
      if (stored.transport !== transportKind) setTransport(stored.transport);
      const here = currentContentId();
      if (service && here && stored.contentId && here !== stored.contentId && !isLoginOrGate()) {
        // We came back on a different page (e.g. /browse after a refresh); go to the title.
        void setPendingJoin({ roomId: stored.roomId, contentId: stored.contentId, service: service.id, createdAtMs: Date.now(), navAttempts: 1 });
        goToTitle(stored.contentId);
      } else {
        if (stored.contentId) inviteLink = buildInviteLink(stored.contentId, stored.roomId);
        join(stored.roomId);
        render();
      }
    }
  }

  // If the service refuses the title, say why instead of looping or guessing.
  const checkRefusal = () => {
    if (!service || adapter.getState().ready) return;
    if (isNetflix && netflixShowsConcurrentStreams()) { blocked = 'concurrent'; render(); return; }
    const id = contentIdFromPath();
    if (id && serviceShowsUnavailable()) { void markUnavailable(id); unavailable = true; render(); }
  };
  window.setTimeout(checkRefusal, 6_000);
  window.setTimeout(checkRefusal, 15_000);

  // Test bridge: the MAIN world (and automation running there) can drive
  // the engine over postMessage, since isolated-world globals are invisible.
  host.dataset.member = memberId;
  host.dataset.build = __BUILD_ID__;
  window.addEventListener('message', (ev) => {
    const msg = ev.data as { channel?: string; id?: number; cmd?: string; args?: unknown[] };
    if (ev.source !== window || msg?.channel !== 'sideby/test/v1' || !msg.cmd) return;
    let value: unknown;
    try {
      switch (msg.cmd) {
        case 'join': join(String(msg.args?.[0])); break;
        case 'leave': leave(); break;
        case 'start': engine.startTogether(Number(msg.args?.[0] ?? 3000)); break;
        case 'config': engine.setConfig(msg.args?.[0] as Record<string, number>); break;
        case 'snapshot': value = engine.getSnapshot(); break;
        case 'toggleDebug': bus.dispatchEvent(new Event('toggle-debug')); break;
      }
      window.postMessage({ channel: 'sideby/test/v1', id: msg.id, ok: true, value }, location.origin);
    } catch (err) {
      window.postMessage({ channel: 'sideby/test/v1', id: msg.id, ok: false, error: String(err) }, location.origin);
    }
  });
}

if (document.body) void mount();
else document.addEventListener('DOMContentLoaded', () => void mount(), { once: true });
