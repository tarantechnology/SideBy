# Sideby

Netflix, Disney+, and Hulu, multiplayer. Watch a title in sync with one friend whose camera floats over the movie, or just hang out on a call and pick a title later.

Sideby never screen-shares, captures, proxies, or interferes with the service's video. Each person streams on their own account at whatever quality the service provides. Sideby only synchronizes playback and runs a separate WebRTC camera/mic call.

## Layout

| Path | What |
| --- | --- |
| `packages/extension` | Chrome MV3 extension (TypeScript, React overlay in a Shadow DOM) |
| `packages/shared` | Types and pure room-timeline logic shared by extension and server |
| `packages/server` | Node WebSocket room server (in-memory rooms) |
| `tools/chrome` | Launch a dedicated Chrome profile and drive it over CDP for real-Netflix testing |
| `dev/mock-player` | Plain `<video>` page implementing the same adapter, for automated sync tests |

## Use

1. Click the Sideby toolbar icon on any page. On Netflix, Disney+, or Hulu it opens the card over the player. Anywhere else it opens Sideby in Chrome's side panel, which stays with you while you browse.
2. **Invite a friend** copies a link, or a friend pastes the room code into **Have a code?** From a title the link is the title's own URL with the room attached (`netflix.com/watch/<id>?sideby=<room>`, `disneyplus.com/play/<id>?…`, `hulu.com/watch/<id>?…`). From the panel or any other page it is `<server>/join/<room>`. Either way the card has camera, mic, and friend volume: hang out first, watch later.
3. Your friend opens the link with Sideby installed. On a title link the service handles sign-in, profile, and PIN as usual; Sideby resumes the join once they land on the title, takes them to the right one if they are elsewhere on that service, and says so if the title is not on their plan or region.
4. The room belongs to your browser session, not a tab. Open a movie on any supported service and the room comes with you; the panel steps back to "In another tab" and the friend's card shows **Open on Netflix** (or Disney+, Hulu) to follow. Bring the room back to the panel any time.
5. When both players are ready, **Start together** counts down against server time and both players start on the same instant.
6. Play, pause, or seek on either side and the other follows. Drift is corrected continuously. Buffering on one side pauses both and resumes them together. An ad break on one side (Hulu, or an ad-supported Disney+ plan) does the same: the room holds until the ad ends, then resumes together.

Sideby never touches system volume; the card's sliders are the movie (when there is one) and your friend's voice.

## Develop

```bash
pnpm install
pnpm --filter @sideby/extension dev     # rebuilds on change, auto-reloads the loaded extension
pnpm --filter @sideby/server dev        # room server on :8787
```

Load `packages/extension/dist` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).
On any title page (`netflix.com/watch/…`, `disneyplus.com/play/…`, `hulu.com/watch/…`) press **⌘⇧D** (or click the toolbar icon) for the debug panel. After changing `manifest.json` (new hosts), reload the extension once on `chrome://extensions`.

### Testing on real Netflix from the CLI

```bash
tools/chrome/launch.sh                  # dedicated profile at ~/.sideby-chrome, CDP on :9222
# one-time in that window: sign in to Netflix, load the unpacked extension
pnpm --filter @sideby/chrome-tools exec tsx drive.ts tabs
pnpm --filter @sideby/chrome-tools exec tsx drive.ts debug 0
```

## Architecture

- **`VideoAdapter`** (`packages/extension/src/adapters/VideoAdapter.ts`) is the only surface the rest of Sideby knows. One adapter per service runs in the page's MAIN world; `AdapterProxy` exposes it to the isolated world over `postMessage`.
  - `BaseVideoAdapter` holds what every service shares: polling, media-event wakeups, SPA navigation tracking, health, and ad-break freezing (during an ad the adapter keeps reporting the last content position as "buffering", so the room holds and nothing reads as a user seek).
  - `NetflixAdapter` prefers Netflix's own player API and falls back to the `<video>` element. `DisneyPlusAdapter` drives the BAM player API hanging off `<disney-web-player>` (position, duration, and seeks are in milliseconds there; the `<video>` clock restarts after every seek, so it is not the media position) and uses the element only for rate nudges. `HuluAdapter` drives the `<video>` element directly, preferring the element Hulu labels as content.
  - `services.ts` is the registry of everything outside the player: hosts, watch-URL shape, content-id parsing, sign-in/profile gate paths, and unavailable-title surfaces. Invite links, join continuation, and the manifest all derive from it. Adding a service means one registry entry, one adapter, one MAIN-world entry, and one build entry.
- **Two surfaces, one session.** `session.tsx` owns the room, the call, and the invite/join flows. The content script hosts it over the page on the three services and the room server's pages (`/join/<room>`, `/join`, `/mock`); the side panel (`panel.tsx`) hosts it anywhere else, with no player, so no broad host permission is needed. Without a player the card runs in hangout mode: link, code, people, camera and mic, friend volume.
- **The room follows the browser session.** Identity and the current room live in `chrome.storage.session`. Every surface that mounts joins the active room; the server gives the seat to the newest socket and tells the older one it was replaced, which then offers to bring the room back. The panel asks the service worker first and defers to a tab that is already watching. Titles are stored in the room as service-qualified keys (`netflix:70158900`), so a surface on another site can still offer the way there.
- **Sync** keeps an authoritative room timeline on the server, compares each client's clock-corrected position against it, and corrects drift: ignore tiny drift, nudge playback rate for moderate drift, hard-seek for large drift.
- **Camera** is a peer-to-peer WebRTC connection signaled over the same WebSocket. Camera failure never blocks sync.
