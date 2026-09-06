/**
 * Everything Sideby needs to know about a streaming service outside its
 * player: where it lives, how a title's URL looks, and which pages are the
 * service's own sign-in / profile flow rather than "the wrong page".
 *
 * Pure and DOM-free (except `currentService()`), so it runs in both worlds
 * and in tests. The manifest's host permissions mirror `origins`.
 */
export type ServiceId = 'netflix' | 'disneyplus' | 'hulu';

export interface StreamingService {
  readonly id: ServiceId;
  /** Display name for copy ("Signing in to Disney+"). */
  readonly name: string;
  readonly home: string;
  /** Origins (match patterns) the extension is injected on. */
  readonly origins: readonly string[];
  matchesHost(hostname: string): boolean;
  /** Stable title id from a playback URL path, or null when not on a title. */
  contentIdFromPath(pathname: string): string | null;
  /** Canonical playback URL for a title id. */
  watchUrl(contentId: string): string;
  /** Pages where the service is handling sign-in, profiles, PINs, or billing. */
  isLoginOrGate(pathname: string): boolean;
  /** Selectors for the service's own "can't play this" surfaces. */
  readonly unavailableSelectors: string;
  /** Copy the service shows when a title cannot be played. */
  readonly unavailableText: RegExp;
}

/** Disney+ prefixes most paths with a locale segment: /en-us/play/<id>. */
const LOCALE = '(?:/[a-z]{2}(?:-[a-z]{2})?)?';

export const NETFLIX: StreamingService = {
  id: 'netflix',
  name: 'Netflix',
  home: 'https://www.netflix.com/',
  origins: ['https://www.netflix.com/*'],
  matchesHost: (h) => h === 'www.netflix.com' || h === 'netflix.com',
  contentIdFromPath: (p) => /^\/watch\/(\d+)/.exec(p)?.[1] ?? null,
  watchUrl: (id) => `https://www.netflix.com/watch/${id}`,
  isLoginOrGate: (p) => /^\/(login|signup|SignUp|profiles|ProfilesGate|switchprofile|browse\/profiles|profilegate|LoginHelp)/i.test(p),
  unavailableSelectors: '[data-uia="error-page"], [data-uia="nfplayer-error"], .nfp-error-page',
  unavailableText: /not available|isn'?t available|unavailable in your|Error Code/i,
};

export const DISNEYPLUS: StreamingService = {
  id: 'disneyplus',
  name: 'Disney+',
  home: 'https://www.disneyplus.com/',
  origins: ['https://www.disneyplus.com/*', 'https://disneyplus.com/*'],
  matchesHost: (h) => h === 'www.disneyplus.com' || h === 'disneyplus.com',
  // Current player URLs are /play/<uuid>; older links used /video/<uuid>.
  contentIdFromPath: (p) => new RegExp(`^${LOCALE}/(?:play|video)/([A-Za-z0-9_-]{8,})`, 'i').exec(p)?.[1] ?? null,
  watchUrl: (id) => `https://www.disneyplus.com/play/${id}`,
  isLoginOrGate: (p) =>
    new RegExp(`^${LOCALE}/(login|identity|select-profile|profiles?|edit-profiles?|add-profile|welcome|begin|sign-?up|account|pin|password|commerce|subscribe)(/|$)`, 'i').test(p),
  unavailableSelectors: '[data-testid="error-page"], [data-testid="playback-error"], [data-testid="unavailable-content"], .error-page',
  unavailableText: /not available|isn'?t available|unavailable|something went wrong|Error Code/i,
};

export const HULU: StreamingService = {
  id: 'hulu',
  name: 'Hulu',
  home: 'https://www.hulu.com/',
  origins: ['https://www.hulu.com/*'],
  matchesHost: (h) => h === 'www.hulu.com' || h === 'hulu.com',
  contentIdFromPath: (p) => /^\/watch\/([A-Za-z0-9-]{8,})/i.exec(p)?.[1] ?? null,
  watchUrl: (id) => `https://www.hulu.com/watch/${id}`,
  isLoginOrGate: (p) => /^\/(login|profiles?|welcome|signup|start|account|plans|billing|activate)(\/|$)/i.test(p),
  unavailableSelectors: '[data-testid="error-page"], [data-testid="playback-error"], .PlaybackError, .ErrorPage',
  unavailableText: /not available|isn'?t available|unavailable|can'?t play|something went wrong|Error Code/i,
};

export const SERVICES: readonly StreamingService[] = [NETFLIX, DISNEYPLUS, HULU];

export function serviceById(id: string): StreamingService | null {
  return SERVICES.find((s) => s.id === id) ?? null;
}

export function serviceForHost(hostname: string): StreamingService | null {
  return SERVICES.find((s) => s.matchesHost(hostname)) ?? null;
}

export function serviceForUrl(url: string): StreamingService | null {
  try {
    return serviceForHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** The service whose page this script runs on. Only null off-service (never in practice). */
export function currentService(): StreamingService | null {
  return typeof location === 'undefined' ? null : serviceForHost(location.hostname);
}

/** A title as the room knows it: service-qualified so any tab can find its way there. */
export interface ContentRef {
  serviceId: string;
  contentId: string;
}

/** "netflix:70158900" — what the room timeline stores. */
export function contentKey(serviceId: string, contentId: string): string {
  return `${serviceId}:${contentId}`;
}

export function parseContentKey(key: string | null | undefined): ContentRef | null {
  if (!key) return null;
  const i = key.indexOf(':');
  if (i <= 0 || i === key.length - 1) return null;
  return { serviceId: key.slice(0, i), contentId: key.slice(i + 1) };
}
