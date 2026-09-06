import { describe, expect, it } from 'vitest';
import { contentKey, DISNEYPLUS, HULU, NETFLIX, parseContentKey, SERVICES, serviceForHost, serviceForUrl } from '../src/adapters/services.js';

describe('service registry', () => {
  it('resolves a service from its hosts and nothing else', () => {
    expect(serviceForHost('www.netflix.com')).toBe(NETFLIX);
    expect(serviceForHost('www.disneyplus.com')).toBe(DISNEYPLUS);
    expect(serviceForHost('disneyplus.com')).toBe(DISNEYPLUS);
    expect(serviceForHost('www.hulu.com')).toBe(HULU);
    expect(serviceForHost('localhost')).toBeNull();
    expect(serviceForHost('notnetflix.com')).toBeNull();
    expect(serviceForUrl('https://www.hulu.com/watch/abc')).toBe(HULU);
    expect(serviceForUrl('not a url')).toBeNull();
  });

  it('round-trips a content id through its watch URL', () => {
    for (const svc of SERVICES) {
      const id = svc.id === 'netflix' ? '70158900' : '3fbf3f6b-3b1b-4a1c-9f1a-2c1a5c9e7d21';
      const url = new URL(svc.watchUrl(id));
      expect(svc.matchesHost(url.hostname)).toBe(true);
      expect(svc.contentIdFromPath(url.pathname)).toBe(id);
    }
  });
});

describe('Netflix paths', () => {
  it('parses /watch ids and ignores the rest', () => {
    expect(NETFLIX.contentIdFromPath('/watch/70158900?trackId=1')).toBe('70158900');
    expect(NETFLIX.contentIdFromPath('/browse')).toBeNull();
    expect(NETFLIX.contentIdFromPath('/title/70158900')).toBeNull();
  });
  it('recognises gates', () => {
    expect(NETFLIX.isLoginOrGate('/login')).toBe(true);
    expect(NETFLIX.isLoginOrGate('/browse')).toBe(false);
  });
});

describe('Disney+ paths', () => {
  const id = '3fbf3f6b-3b1b-4a1c-9f1a-2c1a5c9e7d21';
  it('parses /play and legacy /video ids with or without a locale prefix', () => {
    expect(DISNEYPLUS.contentIdFromPath(`/play/${id}`)).toBe(id);
    expect(DISNEYPLUS.contentIdFromPath(`/en-us/play/${id}`)).toBe(id);
    expect(DISNEYPLUS.contentIdFromPath(`/en-gb/video/${id}`)).toBe(id);
    expect(DISNEYPLUS.contentIdFromPath(`/fr/play/${id}`)).toBe(id);
    expect(DISNEYPLUS.contentIdFromPath(`/browse/entity-${id}`)).toBeNull();
    expect(DISNEYPLUS.contentIdFromPath('/home')).toBeNull();
  });
  it('recognises gates but not browse pages', () => {
    expect(DISNEYPLUS.isLoginOrGate('/login')).toBe(true);
    expect(DISNEYPLUS.isLoginOrGate('/en-us/select-profile')).toBe(true);
    expect(DISNEYPLUS.isLoginOrGate('/identity/login')).toBe(true);
    expect(DISNEYPLUS.isLoginOrGate('/home')).toBe(false);
    expect(DISNEYPLUS.isLoginOrGate(`/play/${id}`)).toBe(false);
  });
});

describe('Hulu paths', () => {
  const id = '8e8e2b5c-2c2e-4d7f-9c2b-1f8b0d4e6a7c';
  it('parses /watch ids', () => {
    expect(HULU.contentIdFromPath(`/watch/${id}`)).toBe(id);
    expect(HULU.contentIdFromPath(`/watch/${id}?foo=bar`)).toBe(id);
    expect(HULU.contentIdFromPath('/series/greys-anatomy-abc')).toBeNull();
    expect(HULU.contentIdFromPath('/hub/home')).toBeNull();
  });
  it('recognises gates', () => {
    expect(HULU.isLoginOrGate('/login')).toBe(true);
    expect(HULU.isLoginOrGate('/profiles')).toBe(true);
    expect(HULU.isLoginOrGate('/welcome')).toBe(true);
    expect(HULU.isLoginOrGate('/hub/home')).toBe(false);
    expect(HULU.isLoginOrGate(`/watch/${id}`)).toBe(false);
  });
});

describe('content keys', () => {
  it('qualifies a title with its service and parses it back', () => {
    expect(contentKey('netflix', '70158900')).toBe('netflix:70158900');
    expect(parseContentKey('netflix:70158900')).toEqual({ serviceId: 'netflix', contentId: '70158900' });
    expect(parseContentKey('disneyplus:3fbf3f6b-3b1b-4a1c-9f1a-2c1a5c9e7d21')).toEqual({ serviceId: 'disneyplus', contentId: '3fbf3f6b-3b1b-4a1c-9f1a-2c1a5c9e7d21' });
  });
  it('rejects keys without a service', () => {
    expect(parseContentKey('70158900')).toBeNull();
    expect(parseContentKey(':x')).toBeNull();
    expect(parseContentKey('netflix:')).toBeNull();
    expect(parseContentKey(null)).toBeNull();
  });
});
