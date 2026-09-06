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

// Content scripts read the session-scoped room and identity.
void (chrome.storage.session as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> } | undefined)
  ?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => undefined);

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
  const toggle = () => chrome.tabs.sendMessage(tabId, { type: 'sideby:toggle' }).catch(() => undefined);
  if (mounted.has(tabId) || (tab.url && serviceForUrl(tab.url))) {
    await toggle();
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    setTimeout(() => void toggle(), 400);
  } catch {
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
