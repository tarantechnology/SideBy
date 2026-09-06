/**
 * MV3 service worker: toolbar routing and dev-time auto reload.
 *
 * The toolbar icon toggles the overlay where it already runs (streaming
 * services, the room server's pages) and injects it into any other tab so
 * a room can start anywhere. Pages that refuse scripts fall back to the
 * server's lobby page.
 */
import { serviceForUrl } from './adapters/services.js';

declare const __DEV__: boolean;
declare const __SERVER_HTTP__: string;

// Content scripts read the session-scoped room and identity; nothing may be
// injected before this grant lands or the first storage read would throw.
const sessionReady: Promise<void> = Promise.resolve(
  (chrome.storage.session as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> } | undefined)
    ?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }),
).then(() => undefined, () => undefined);

/** Tabs with a mounted overlay, by their long-lived port. */
const mounted = new Set<number>();

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (tabId !== undefined) {
    mounted.add(tabId);
    port.onDisconnect.addListener(() => mounted.delete(tabId));
  }
  port.onMessage.addListener(() => undefined);
});

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  if (tabId === undefined) return;
  // Already mounted (or should be, on a service page): just toggle the card.
  if (mounted.has(tabId) || (tab.url && serviceForUrl(tab.url))) {
    const delivered = await chrome.tabs.sendMessage(tabId, { type: 'sideby:toggle', open: true }).then(() => true, () => false);
    if (delivered) return;
    // A service page whose content script is gone (extension reloaded under it): inject below.
  }
  await sessionReady;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    // The content script opens its card on mount when told to; a late toggle is harmless.
    setTimeout(() => void chrome.tabs.sendMessage(tabId, { type: 'sideby:toggle', open: true }).catch(() => undefined), 300);
  } catch (err) {
    console.warn('[sideby] cannot inject here, opening the lobby', err);
    await chrome.tabs.create({ url: `${__SERVER_HTTP__}/join` });
  }
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
