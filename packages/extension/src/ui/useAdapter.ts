import { useEffect, useState } from 'react';
import type { AdapterHealth, ContentInfo, PlayerState, VideoAdapter } from '../adapters/VideoAdapter.js';
import type { AdapterProxy } from '../bridge/AdapterProxy.js';

export interface AdapterView {
  state: PlayerState;
  health: AdapterHealth;
  content: ContentInfo;
  connected: boolean;
  log: string[];
}

const MAX_LOG = 60;

/** Subscribes React to adapter snapshots at the adapter's own poll rate. */
export function useAdapter(adapter: AdapterProxy): AdapterView {
  const [view, setView] = useState<AdapterView>(() => ({
    state: adapter.getState(),
    health: adapter.getHealth(),
    content: adapter.getContentInfo(),
    connected: adapter.isConnected(),
    log: [],
  }));

  useEffect(() => {
    let log: string[] = [];
    const push = (line: string) => {
      const t = new Date().toLocaleTimeString([], { hour12: false });
      log = [`${t} ${line}`, ...log].slice(0, MAX_LOG);
    };
    const off = adapter.on((ev) => {
      if (ev.type === 'contentchange') push(`content ${ev.previous ?? '∅'} → ${ev.contentId ?? '∅'}`);
      if (ev.type === 'ready') push('player ready');
      if (ev.type === 'error') push(`error ${ev.message}`);
      if (ev.type !== 'state') setView((v) => ({ ...v, log }));
    });
    // Health/content come over request-response; refresh them at 1Hz, state at poll rate.
    const stateTimer = window.setInterval(() => {
      setView((v) => ({ ...v, state: adapter.getState(), connected: adapter.isConnected() }));
    }, 250);
    const slowTimer = window.setInterval(() => {
      void adapter.refresh().then(() => {
        setView((v) => ({ ...v, health: adapter.getHealth(), content: adapter.getContentInfo(), log }));
      }).catch(() => undefined);
    }, 1000);
    return () => { off(); window.clearInterval(stateTimer); window.clearInterval(slowTimer); };
  }, [adapter]);

  return view;
}
