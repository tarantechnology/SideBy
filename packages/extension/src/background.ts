/** MV3 service worker: toolbar click routing and dev-time auto reload. */
declare const __DEV__: boolean;

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  if (tab.url?.startsWith('https://www.netflix.com/')) {
    void chrome.tabs.sendMessage(tab.id, { type: 'sideby:toggle' }).catch(() => undefined);
  } else {
    void chrome.tabs.create({ url: 'https://www.netflix.com/' });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(() => undefined);
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
