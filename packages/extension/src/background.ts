/**
 * MV3 service worker: toolbar routing, seat bookkeeping, dev auto reload.
 *
 * The toolbar icon toggles the overlay on pages that have one (streaming
 * services, the room server's pages) and opens the side panel anywhere
 * else, so a room can start or be joined from any page.
 */
import { serviceForUrl } from './adapters/services.js';

declare const __DEV__: boolean;

// Content scripts read the session-scoped room and identity.
void (chrome.storage.session as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> } | undefined)
  ?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => undefined);

/** Tabs with a mounted overlay, by their long-lived port. */
const mounted = new Set<number>();
/** Which tab currently seats which room, so the panel can defer to it. */
let seat: { tabId: number; roomId: string } | null = null;

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (tabId !== undefined) mounted.add(tabId);
  port.onMessage.addListener((msg: { type?: string; roomId?: string | null }) => {
    if (msg?.type !== 'seat' || tabId === undefined) return;
    if (msg.roomId) seat = { tabId, roomId: msg.roomId };
    else if (seat?.tabId === tabId) seat = null;
  });
  port.onDisconnect.addListener(() => {
    if (tabId !== undefined) mounted.delete(tabId);
    if (seat?.tabId === tabId) seat = null;
  });
});

chrome.runtime.onMessage.addListener((msg: { type?: string; roomId?: string }, _sender, sendResponse) => {
  if (msg?.type === 'sideby:seat?') {
    sendResponse({ held: !!seat && seat.roomId === msg.roomId && mounted.has(seat.tabId) });
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  if (tabId === undefined) return;
  if (mounted.has(tabId) || (tab.url && serviceForUrl(tab.url))) {
    const delivered = await chrome.tabs.sendMessage(tabId, { type: 'sideby:toggle', open: true }).then(() => true, () => false);
    if (delivered) return;
  }
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

if (__DEV__) {
  const DEV_VERSION_URL = 'http://127.0.0.1:8788/version';
  const ownId = fetch(chrome.runtime.getURL('build-id.txt')).then((r) => r.text()).then((t) => t.trim());
  const check = async () => {
    try {
      const res = await fetch(DEV_VERSION_URL, { cache: 'no-store' });
      const id = (await res.text()).trim();
      if (id && id !== (await ownId)) chrome.runtime.reload();
    } catch {
      /* dev server not running */
    }
  };
  setInterval(check, 1500);
  chrome.alarms.create('sideby-dev-reload', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sideby-dev-reload') void check(); });
}
