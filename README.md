# Sideby

Netflix, multiplayer. Watch a title in sync with one friend whose camera floats over the movie.

Sideby never screen-shares, captures, proxies, or interferes with Netflix's video. Each person streams Netflix on their own account at whatever quality Netflix provides. Sideby only synchronizes playback and runs a separate WebRTC camera/mic call.

## Layout

| Path | What |
| --- | --- |
| `packages/extension` | Chrome MV3 extension (TypeScript, React overlay in a Shadow DOM) |
| `packages/shared` | Types and pure room-timeline logic shared by extension and server |
| `packages/server` | Node WebSocket room server (in-memory rooms) |
| `tools/chrome` | Launch a dedicated Chrome profile and drive it over CDP for real-Netflix testing |
| `dev/mock-player` | Plain `<video>` page implementing the same adapter, for automated sync tests |

## Develop

```bash
pnpm install
pnpm --filter @sideby/extension dev     # rebuilds on change, auto-reloads the loaded extension
pnpm --filter @sideby/server dev        # room server on :8787
```

Load `packages/extension/dist` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).
On any `netflix.com/watch/...` page press **⌘⇧D** (or click the toolbar icon) for the debug panel.

### Testing on real Netflix from the CLI

```bash
tools/chrome/launch.sh                  # dedicated profile at ~/.sideby-chrome, CDP on :9222
# one-time in that window: sign in to Netflix, load the unpacked extension
pnpm --filter @sideby/chrome-tools exec tsx drive.ts tabs
pnpm --filter @sideby/chrome-tools exec tsx drive.ts debug 0
```

## Architecture

- **`VideoAdapter`** (`packages/extension/src/adapters/VideoAdapter.ts`) is the only surface the rest of Sideby knows. `NetflixAdapter` runs in the page's MAIN world, prefers Netflix's own player API, and falls back to the `<video>` element. `AdapterProxy` exposes it to the isolated world over `postMessage`.
- **Sync** keeps an authoritative room timeline on the server, compares each client's clock-corrected position against it, and corrects drift: ignore tiny drift, nudge playback rate for moderate drift, hard-seek for large drift.
- **Camera** is a peer-to-peer WebRTC connection signaled over the same WebSocket. Camera failure never blocks sync.
