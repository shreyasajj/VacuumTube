# Bigscreen Bridge local control

This checkout is the local `bigscreen-bridge` branch of
[shreyasajj/VacuumTube](https://github.com/shreyasajj/VacuumTube), based on
upstream revision `0c7df3a1e2411b430e416a0b8f3c872bb1f8fb4d`. The patch adds
local control without changing Electron's existing per-profile instance lock.

## Interface

On Linux the main process owns
`$XDG_RUNTIME_DIR/bigscreen-bridge/vacuumtube.sock`. The directory is mode 0700,
the socket mode 0600, and both must belong to the current Unix user. The Flatpak
adds only `--filesystem=xdg-run/bigscreen-bridge:create` to its existing permissions.
This does not grant access to the external bridge's configuration or bearer token.

Each connection sends one JSON line, at most 16 KiB, and receives one JSON line.
Every command has a bounded string request `id`. Responses contain the same `id`,
`ok`, and either `result` or `error: {code,message}`. A cache of 128 results makes
retries idempotent; conflicting reuse of an ID fails. Transient readiness/busy
errors are retriable. Mutating commands are serialized while state/focus requests
remain available. Connections, pending commands and idle times are bounded.

```json
{"id":"state-1","command":"get_state"}
{"id":"focus-1","command":"focus"}
{"id":"video-1","command":"open","content_type":"video","content_id":"M7lc1UVf-VE"}
{"id":"playlist-1","command":"open","content_type":"playlist","content_id":"PLBCF2DAC6FFB574DE"}
{"id":"search-1","command":"open","content_type":"search","content_id":"KDE Bigscreen"}
{"id":"pause-1","command":"pause"}
{"id":"play-1","command":"play"}
{"id":"seek-1","command":"seek","position":12}
{"id":"level-1","command":"volume_set","volume_level":0.25}
{"id":"mute-1","command":"volume_mute","muted":true}
{"id":"stop-1","command":"stop"}
```

Video IDs have exactly 11 URL-safe characters; playlist IDs have 10–128. Search
text is limited to 200 characters and excludes control characters. Requests
cannot supply URLs, script, shell commands or configuration fields.

The main process accepts bridge telemetry/acknowledgements only from its current
BrowserWindow and an HTTPS `www.youtube.com/tv` frame. It prefers the frame that
owns the player and invalidates control on navigation, window closure and renderer
loss. A five-second watchdog stops advertising stale player capabilities.

## Tested Leanback behavior

Video and playlist navigation reuse the existing `h5vcc` deep-link listener.
The ordinary YouTube results URL did **not** open search during live testing.
Search instead uses a fixed `searchEndpoint` through VacuumTube's existing
command resolver. Its readiness is advertised separately from the link listener.

Leanback registers its listener before the initial route has settled. Navigation
therefore retries the same fixed request at three-second intervals, bounded to
18 seconds, until the requested route/content is observed. Acknowledgements are
`video_selected`, `playlist_selected` or `search_opened`; unsupported/unconfirmed
navigation returns an explicit error. Search confirmation includes the actual
public query observed in Leanback's search request. Selection is distinct from
successful network playback; follow media state for playback status.

Telemetry uses the actual `.html5-video-player` APIs for ID, position, duration,
state and player output volume. `getVideoData().title` was empty in live Leanback,
so a bounded, read-only cache observes public ID/title fields from responses the
application already parses. It never retains stream URLs, cookies or response
bodies. Thumbnails use the fixed YouTube image host and the validated video ID.

Play/pause/stop/seek are advertised only when the corresponding player method and
state support them. Seek is absolute, finite and bounded by duration. Volume and
mute use the existing volume-control module's controller, shared with keyboard
and casting actions; directly setting player volume would be overwritten by its
100 ms loop. `volume` is the configured level, `muted` is separate, and
`output_volume` is read from the player for verification. Levels are 0–1 with
percent granularity. No next/previous/repeat/queue features are advertised.

## Development installation

Use the companion bridge repository's `scripts/deploy-vacuumtube.sh` with this
checkout. It runs `scripts/build-bridge-asar.cjs` locally against the installed
archive, checks that version/dependencies match, and keeps the installed Linux
Electron binary and production dependencies. This adds no runtime dependencies.
For a different version/dependency set, use a full Linux Electron build instead.

The TV needs its existing VacuumTube Flatpak plus `org.freedesktop.Sdk//26.08`.
`flatpak/install-bridge.sh` installs a user-level build from the local
`bigscreen-vacuumtube` development repository. The system Flatpak remains intact.
The original commit is recorded in `~/.cache/vacuumtube-bridge-build/base-commit`.
No upstream release is published or automatically installed by this path.

Rollback to the system installation with `flatpak uninstall --user
rocks.shy.VacuumTube` (without deleting app data), and disable `vacuumtube_control`
in the bridge's private configuration if the restored build lacks the hook.
Normal user-profile data remains in the same Flatpak application directory.

## Validation

Run `npm test` for protocol, replay, frame trust, socket permissions/bounds,
metadata matching, delayed navigation and controller tests. Companion TV scripts
exercise the real Leanback page, existing instance reuse, metadata, video/playlist/
search, playback, volume/mute, authenticated Wayland control and cold launch.
The native smoke test uses a separate `--portable` test profile, then the bridge
smoke test confirms cold launch of the normal profile. Configuration backups are
private under `~/.cache/bigscreen-backups/`. Test playback is stopped afterward.

Live verification applies to the tested Leanback implementation and content.
Future YouTube changes can invalidate capabilities; errors/timeouts are reported
instead of silently opening another window. The patch does not extract secrets,
export playlists/subscriptions, or add YouTube library browsing.
