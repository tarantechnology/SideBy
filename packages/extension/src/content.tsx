/**
 * Isolated-world content script. Runs on the streaming services and the
 * room server's pages automatically, and in any other tab the toolbar icon
 * was clicked in. Mounts the overlay in a Shadow DOM so the page's CSS
 * cannot reach it, and talks to the MAIN-world adapter when there is one.
 *
 * The room belongs to the browser session, so it follows the viewer from a
 * hangout tab to a title and back; the server hands the seat to whichever
 * tab joined last and this tab steps aside when that happens.
 */
import { createRoot } from 'react-dom/client';
import { AdapterProxy } from './bridge/AdapterProxy.js';
import { roomCode } from '@sideby/shared';
import { currentService, serviceById } from './adapters/services.js';
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
declare const __SERVER_HTTP__: string;

const HOST_ID = 'sideby-host';
const ROOM_MEMORY_MS = 6 * 60 * 60 * 1000;

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

  // Keep typing/shortcuts inside the overlay from reaching the page's hotkeys.
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  // Players fullscreen a specific element; ride along so we stay visible.
  document.addEventListener('fullscreenchange', () => {
    const target = document.fullscreenElement ?? document.body;
    if (host.parentElement !== target) target.appendChild(host);
  });

  /** Where we are: a streaming service, the dev mock player, or anywhere else (hangout). */
  const service = currentService();
  const onServer = location.origin === __SERVER_HTTP__;
  const isMock = onServer && location.pathname.startsWith('/mock');
  const hangout = !service && !isMock;
  const contentPrefix = service?.id ?? (isMock ? 'mock' : null);
  const isNetflix = service?.id === 'netflix';

  const adapter = new AdapterProxy();
  const bus = new EventTarget();

  // Capture phase: players stop keydown propagation at the document.
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

  // Long-lived port: tells the service worker this tab has the overlay, and
  // keeps it awake for dev reload.
  const port = chrome.runtime.connect({ name: 'sideby-tab' });
  const keepalive = window.setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch { window.clearInterval(keepalive); } }, 20_000);

  const memberId = await getMemberId();
  const memberToken = await getMemberToken();
  let transportKind = await getTransportPreference();
  const makeTransport = (kind: 'local' | 'ws'): Transport => {
    const t: Transport = kind === 'local' ? new LocalTransport(memberId) : new WsTransport(__SERVER_URL__, memberId, memberToken);
    // Another tab of ours joined the room: it has the seat now. Keep the room
    // remembered so the viewer can bring it back here.
    t.on((ev) => { if (ev.type === 'status' && ev.status === 'closed' && ev.detail === 'replaced') onReplaced(); });
    return t;
  };
  const makeEngine = () => new SyncEngine(adapter, transport, { contentPrefix, hangout, loggedIn: () => !isLoginOrGate() });
  let transport = makeTransport(transportKind);
  let engine = makeEngine();
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

  let inviteLink: string | null = null;
  let unavailable = false;
  let blocked: 'concurrent' | null = null;
  /** The seat moved to another of our tabs. */
  let moved = false;
  /** Current title id: the adapter knows best; the URL is the fallback before it attaches. */
  const currentContentId = () => adapter.getState().contentId ?? contentIdFromPath();
  /** Navigate this tab to a title on the current service (no-op off-service). */
  const goToTitle = (contentId: string) => {
    const url = watchUrl(contentId);
    if (url) location.assign(url);
  };

  const join = (roomId: string) => {
    moved = false;
    void setStoredRoom({ roomId, transport: transportKind, joinedAtMs: Date.now(), contentId: currentContentId(), service: service?.id ?? null });
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
    engine = makeEngine();
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
    moved = false;
    render();
  };
  const onReplaced = () => {
    if (moved) return;
    moved = true;
    engine.leave();
    call?.disableMedia();
    render();
  };
  /** Take the seat back from the other tab. */
  const bringHere = () => {
    void getStoredRoom().then((stored) => {
      if (!stored) { moved = false; render(); return; }
      if (stored.contentId) inviteLink = buildInviteLink(service?.id === stored.service ? stored.contentId : null, stored.roomId);
      join(stored.roomId);
      render();
    });
  };

  /** Host flow: create a server room here (with or without a title) and hand back a link. */
  const invite = () => {
    if (transportKind !== 'ws') setTransport('ws');
    const roomId = roomCode();
    inviteLink = buildInviteLink(currentContentId(), roomId);
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
    inviteLink = buildInviteLink(pending.contentId, pending.roomId);
    join(pending.roomId);
    await clearPendingJoin();
    bus.dispatchEvent(new Event('open-card'));
    render();
  };

  /**
   * Follow the room when it moves to another title on this service (friend
   * navigated, or autoplay). Elsewhere the card offers "Open on <service>".
   */
  let navigatedTo: string | null = null;
  const followRoomContent = () => engine.subscribe(() => {
    const snap = engine.getSnapshot();
    const target = snap.roomContent;
    if (!snap.roomId || !target || !service || target.serviceId !== service.id) return;
    if (snap.contentMismatch && navigatedTo !== target.contentId && !isLoginOrGate()) {
      navigatedTo = target.contentId;
      void isUnavailable(target.contentId).then((bad) => {
        if (bad) { unavailable = true; render(); return; }
        void setPendingJoin({ roomId: snap.roomId!, contentId: target.contentId, service: service.id, createdAtMs: Date.now(), navAttempts: 1 });
        goToTitle(target.contentId);
      });
    }
  });
  let unfollow = followRoomContent();

  /** From a hangout (or another service): go where the room is watching. */
  const openRoomContent = () => {
    const snap = engine.getSnapshot();
    const target = snap.roomContent;
    const svc = target && serviceById(target.serviceId);
    if (!snap.roomId || !target || !svc) return;
    void setPendingJoin({ roomId: snap.roomId, contentId: target.contentId, service: svc.id, createdAtMs: Date.now(), navAttempts: 1 }).then(() => {
      location.assign(svc.watchUrl(target.contentId));
    });
  };

  const root = createRoot(mountPoint);
  const render = () => root.render(
    <App
      adapter={adapter} engine={engine} call={call} bus={bus}
      onJoin={join} onLeave={leave} onInvite={invite} onBringHere={bringHere} onOpenRoomContent={openRoomContent}
      inviteLink={inviteLink} unavailable={unavailable} blocked={blocked} moved={moved} hangout={hangout}
      transportKind={transportKind} onTransportChange={setTransport}
    />,
  );
  render();
  if (__DEV__) console.info('[sideby] overlay mounted as', memberId, hangout ? '(hangout)' : `(${contentPrefix})`);

  // Arriving via an invite link? Remember it before the page redirects us anywhere.
  const fromLink = consumeInviteParam();
  if (fromLink) await setPendingJoin(fromLink);
  const pending = fromLink ?? (await getPendingJoin());
  if (pending) {
    await continuePendingJoin(pending);
  } else {
    // The session's room comes with us: a refresh, a new title, or a new site rejoins it.
    const stored = await getStoredRoom();
    if (stored && Date.now() - stored.joinedAtMs < ROOM_MEMORY_MS) {
      if (stored.transport !== transportKind) setTransport(stored.transport);
      const here = currentContentId();
      if (service && here && stored.contentId && stored.service === service.id && here !== stored.contentId && !isLoginOrGate()) {
        // We came back on a different page (e.g. /browse after a refresh); go to the title.
        void setPendingJoin({ roomId: stored.roomId, contentId: stored.contentId, service: service.id, createdAtMs: Date.now(), navAttempts: 1 });
        goToTitle(stored.contentId);
      } else {
        inviteLink = buildInviteLink(stored.service === (service?.id ?? null) ? stored.contentId ?? null : null, stored.roomId);
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
