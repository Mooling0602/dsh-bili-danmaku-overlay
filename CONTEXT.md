# CONTEXT.md

Technical detail for agents and maintainers. `AGENTS.md` holds the rules; this file holds the working model of the system: how the halves fit together, which invariants cannot be broken, what the upstream protocols require, and which commands do what.

## What the plugin is

A Cordis bundle for the DeepSeek Harness that shows Bilibili live-room danmaku inside the DSH Web UI, as floating windows that sit above any page plus a small always-present ball that manages them.

It has two halves that ship as one package:

- **Host half** (`host.ts` plus `src/*.ts`) runs inside the `dsh` Node process. It owns credentials, resolves room ids, holds one upstream connection per room, polls history and stats, and exposes HTTP routes.
- **Client half** (`src/client/*`) runs in the browser. It renders the windows and the ball, and talks to the Host only through the routes below.

The split matters in practice: a Host change reaches the running process after a rebuild, while a Client change additionally needs the page reloaded.

## Module map

| Path | Owns |
| --- | --- |
| `host.ts` | Cordis entry: reads the entry config, constructs the poller, mounts the routes. |
| `src/config.ts` | The entry's schema, defaults and the projection the page reads. |
| `src/credentials.ts` | Resolves `BILIBILI_SESSDATA` and `BILIBILI_JCT` from `~/.dsh/.credentials.yaml` by reference name. |
| `src/bili.ts` | Upstream HTTP: room resolution, WBI signing, history, stats, sending a danmaku. |
| `src/comet.ts` | The live danmaku WebSocket: handshake, auth, frame decoding, heartbeat, reconnect. |
| `src/stream.ts` | One room's connection lifecycle, turning Comet frames into message rows and announcing state changes. |
| `src/poller.ts` | `Map<number, RoomLoop>`: which rooms are connected, history polling, stats polling, fan-out to subscribers. |
| `src/routes.ts` | Every HTTP route under `ROUTE_PREFIX`. |
| `src/types.ts` | Shared types, including the message row the page renders. |
| `src/client/api.ts` | The page's typed wrappers over those routes, plus the localStorage state format. |
| `src/client/rooms.ts` | `RoomStore`: one room's page-side state, its own connection, history merge, dedup, title, alias, view, position. Also holds `stateTone` and `aggregateState`. |
| `src/client/overlay.tsx` | The container: restores rooms, creates stores, persists state, renders every window and the ball. |
| `src/client/window.tsx` | One floating danmaku window. |
| `src/client/ball.tsx` | The Bilibili TV ball and its room-management menu. |
| `src/client/config-page.tsx` | The plugin settings page. |
| `src/client/copy.ts` | The `zh` and `en` dictionaries and the `CopyKey` union. |
| `src/client/index.tsx` | Registers the overlay into `shell.overlay` and the settings page into the plugin settings row. |
| `build.mjs` | esbuild: `src/client/index.tsx` to `client.js` (IIFE), `host.ts` to `index.js` (ESM). |
| `cordis.patch.yml` | The bundle patch that inserts this plugin into a profile. |

## Build and the two bundles

```sh
npm run build      # node build.mjs
npm run typecheck  # tsc --noEmit, must print nothing
```

- `client.js` is an IIFE. Its global name is derived from the package name (`__dsh_` plus the name with non-alphanumerics stripped), so two bundles cannot collide.
- `index.js` is ESM and keeps `@deepseek-ai/schemastery` and `@deepseek-ai/cordis` external. `schemastery` must stay external because the settings system recognises a schema by class identity, and an inlined copy would be a different class with the same shape.
- The Client bundle currently requires exactly three specifiers at runtime: `react`, `react/jsx-runtime` and `@deepseek-ai/dsh-client-ui-primitives`. The rest of `CLIENT_EXTERNAL` in `build.mjs` is listed for the type imports that produce no `require`. Check the truth with `grep -o 'require("[^"]*")' client.js` after a build.
- `tsconfig.json` sets `erasableSyntaxOnly`, so no `enum`, no `namespace` and no constructor parameter properties. It also sets `verbatimModuleSyntax`, so a type-only import needs `import type`, and `noUnusedLocals` plus `noUnusedParameters`, so an unused binding fails the type check.
- **The build output is committed, as a bounded transition.** Both files carry a generated banner and are never edited by hand.

### The committed output is temporary

The Harness loads `index.js` and `client.js` from the package directory, so a clone without them cannot be installed. During development that is the whole point: committing them lets the plugin be installed straight from the GitHub source, before any release artifact exists.

The target state is a source-only repository, where the build generates both files and Git ignores them, which is what the sibling plugin repositories do. The switch belongs to the release work: it moves `index.js` and `client.js` out of Git and out of `package.json` → `files`, and replaces the reason to keep them with something a release produces instead.

Until then, every commit that touches `src/` or `host.ts` carries the matching rebuild. The removal condition is the first release, and nothing about this arrangement is a decision about the plugin's final packaging.

## Host side

### Configuration

The entry config lives in the profile patch (`cordis.patch.yml`, entry id `include:bili-danmaku-overlay`) and is read through `src/config.ts`. `/api/config` projects only the fields the page needs, together with `boot`.

`boot` is `${process.pid}-${Date.now()}`, computed once per Host process. It exists so the page can tell one `dsh` run from the next, which is what bounds the lifetime of a temporary room title.

### Credentials

Read from `~/.dsh/.credentials.yaml` through the reference names `BILIBILI_SESSDATA` and `BILIBILI_JCT`. `buildCookie` returns an empty string when no credential is configured, and the read paths treat that as non-fatal: a request without it still resolves a room and still reads history, and only sending requires the cookie. A logged in request is what the plugin normally runs, so a test that carries it measures the real behaviour; an anonymous one measures what a logged out visitor would get.

### Room resolution

`resolveRoom` asks `getRoomBaseInfo` first. That response carries `title` and `uname`, which is why the window can be titled correctly and why the summary can say who spoke.

`getRoomBaseInfo` is keyed by the **real** room id. Asked about a short id it answers `code: 0` with an empty `by_room_ids`, and an entry can also arrive with an empty title. `baseInfo` reports both cases as `null` rather than passing a blank up.

`room_init` never reports a title or a streamer name. Its job is only to map a short id to the real id, which `resolveRoom` then feeds back into `baseInfo`. Without that second call, a room added by its short id would keep the `#<room>` label forever, because nothing later re-resolves the title.

**An offline room still reports its title.** `live_status: 0` describes whether a stream is running, not whether the room exists, so the title and streamer name are present for it. A window labelled only with a number is therefore a resolution bug and never an expected state for a room that exists.

A room number the user types may be a short id; the resolver maps it to the real `room_id`, and the real id is what every later call uses.

### Request density

The upstream answers `-352` when a client asks too often. Two things combined caused it once: a signing bug, and firing requests too densely. Keep polling at or above 0.1 seconds, and do not burst several live endpoints at the same instant.

## Upstream protocols

### WBI signing

`getDanmuInfo` is WBI signed. The signature is **`md5(query + mixinKey)` in plain hex**, not base64url. The mixin key comes from a 64-entry reorder table applied to the two filenames in `nav`'s `wbi_img.img_url` and `sub_url`. `web_location` is `444.8`. Getting the encoding wrong produces `-352` rather than an auth error, which is why it reads like rate limiting.

### Comet WebSocket

- 16-byte header: `u32 total length`, `u16 header length` (16), `u16 protocol version`, `u32 operation`, `u32 sequence` (1).
- Version 2 means the body is zlib compressed and may nest another frame; decode recursively with a depth limit of 4.
- Operations: `2` heartbeat, `5` message, `7` auth, `8` auth reply.
- **Auth requires the real account uid** from `nav`. An anonymous uid of `0` is refused, and the socket then never reports live even though it stays connected.
- The auth reply (op `8`) is not a message, so `decodeFrame` has to surface it separately; it is what switches the state to live.
- The heartbeat is an interval that must be cleared in `stop()`. A leaked interval keeps the process alive.

### Message identity

Rows are deduplicated on the stable message id from upstream, not on text or time. History replay and a live frame can carry the same message, and both orderings occur.

## Client side

### State ownership

`overlay.tsx` owns the list of rooms and the persisted document; each `RoomStore` owns one room's volatile state and its own connection.

`useSyncExternalStore` requires a **referentially stable** `getSnapshot`. A `getSnapshot` that builds a fresh array on every call makes React re-render forever and the subtree never mounts; this is what once made the ball invisible. The container keeps a cache and returns the previous array when the entries are identical, and passes the same function as the third argument.

### Views

`RoomView` has three values and they are not interchangeable:

- `window`: the full window.
- `minimized`: a thin strip on the page.
- `hidden`: folded into the ball, still monitored.

**Only quitting a room from the ball's menu stops monitoring.** Closing a window must never tear down the stream.

### Persistence

The page keeps one document in localStorage: the room list, per-room view, alias and position, the ball size, the ball position, and the Host `boot` id it last saw.

- A **temporary room title** (the alias) survives a page reload and is dropped when the stored `boot` differs from the one `/api/config` reports, which is to say after a `dsh` restart. The first sighting only records the id.
- The legacy single-room shape (`room`, `enabled`, `collapsed`, `place`) is still read and folded into the list form, so an upgrade does not lose the room someone was watching. This is a bounded transition; see `AGENTS.md` section 5.
- `saveState` replaces the whole document rather than merging into it.

### Layout rules that are easy to break

These encode user-visible decisions, and each one was a reported defect before it was a rule:

- **The ball and its menu stay inside a 12px safe area.** The menu is `position: fixed` and clamped on all four sides rather than laid out in the ball's flex column. A flex column is as wide as its widest child, so putting a 268px menu in it widens the container, pushes the dot off its anchor, and on a phone pushes the panel past the edge.
- **The menu unfolds away from the nearest horizontal edge**, and hangs below a ball in the upper half of the viewport while rising above one in the lower half. It must never sit on top of the ball.
- **The dot sits on the edge nearest the screen border**, which is the same edge the pill is anchored by. The other arrangement puts the summary between the icon and the border and drags the icon halfway across the pill.
- **Dragging is rendered from state, never written straight to the DOM.** New danmaku arrive continuously, so a DOM-only position is overwritten by the next render and the ball snaps back mid-drag.
- **Both window forms drag from the same handlers.** The expanded window and the minimized one share `onPointerDown` and its siblings, because both render the same title bar. A moved window therefore keeps one position whichever form it is in.
- **A minimized window is its title bar, and nothing else.** It keeps the state dot, the title, the online count and the controls, and drops only the message list and the reply row. Collapsing to a bare dot hid the one thing the user needed to tell several rooms apart, which is which room the card belongs to.
- **A minimized window shows the newest line in place of its title, then returns to the title.** A new danmaku resets the idle timer, and after `IDLE_FADE_MS` of quiet the title comes back. The title is the resting state because it names the room; the preview is transient because it is only worth reading while it is current. The preview is drawn in the same slot with a lighter weight and colour, so the card never changes height as the two states swap.
- **A drag collapses the ball to a bare dot centred on the pointer**, with a 4px slop radius that separates a drag from a click. Release clamps the position to the safe area.
- **The default corner is the top-right**, tracked through a resize listener rather than read once at render time.
- **Button icons are inline SVG paths from `src/client/icons.tsx`, never characters.** A glyph such as `×`, `−` or `⟳` takes its shape, baseline and advance width from whatever font the page resolves, so the same button can sit off centre or change weight between machines. The paths are drawn on a fixed 16 unit grid and centred on it, size themselves from `1em`, and inherit `currentColor`, which is why a button only sets colour and font size.

### Copy

`CopyKey` is a closed union and every key exists in both dictionaries. A component gets its strings from `t()`, never from a literal. `locale/*.json` holds only the listing `meta`; a runtime string placed there would render as a raw key because nothing reads those files at runtime.

## Routes

Everything is mounted under `/bili-danmaku-overlay`.

| Route | Purpose |
| --- | --- |
| `GET /api/config` | The projected config plus `boot`. |
| `GET /api/credential` | Whether a login is available, never the credential itself. |
| `GET /api/events?room=` | The event stream for one room. Any room id is accepted. |
| `GET /api/history?room=` | Recent history for one room. |
| `GET /api/stats?room=` | The room's live stats. |
| `POST /api/send` | Sends a danmaku. **Never point this at a room that is not the maintainer's own.** |

Adding rooms needed no Host change: the poller already keys rooms by id and the event route already accepts any room.

## Development workflow

- The plugin is installed into the `web` profile as a **symlink** to this working copy, so `npm run build` is enough for the Host half; there is no copy step.
- Check whether the running process already has a Host change by comparing the mtime of `index.js` against the process start time, rather than assuming.
- A Client change needs the page reloaded. Ask the user; never reload it yourself.
- A live room can be observed safely. The only room a send may reach is the maintainer's own, and it has to be named by the maintainer rather than guessed.
