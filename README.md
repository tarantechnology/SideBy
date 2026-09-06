# Sideby

Netflix, Disney+, and Hulu, multiplayer. Watch a title in sync with one friend whose camera floats over the movie.

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

1. Open a movie or episode on Netflix, Disney+, or Hulu and click the Sideby toolbar icon (or the Sideby pill).
2. **Invite a friend** copies a link like `netflix.com/watch/<id>?sideby=<room>` (or `disneyplus.com/play/<id>?…`, `hulu.com/watch/<id>?…`). Both of you watch on the same service.
3. Your friend opens it with Sideby installed. The service handles sign-in, profile, and PIN as usual; Sideby resumes the join once they land on the title. If they are on the wrong title, Sideby takes them to the right one. If the title is not on their plan or region, Sideby says so and stops.
4. When both players are ready, **Start together** counts down against server time and both players start on the same instant.
5. Play, pause, or seek on either side and the other follows. Drift is corrected continuously. Buffering on one side pauses both and resumes them together. An ad break on one side (Hulu, or an ad-supported Disney+ plan) does the same: the room holds until the ad ends, then resumes together.

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
- **Sync** keeps an authoritative room timeline on the server, compares each client's clock-corrected position against it, and corrects drift: ignore tiny drift, nudge playback rate for moderate drift, hard-seek for large drift.
- **Camera** is a peer-to-peer WebRTC connection signaled over the same WebSocket. Camera failure never blocks sync.
