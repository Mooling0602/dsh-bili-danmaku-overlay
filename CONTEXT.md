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
| `src/debug.ts` | The `bili_danmaku_status` tool: a read-only snapshot of every tracked transport and history loop, plus a diagnosis line naming the single condition that best explains why danmaku are not arriving. |
| `src/types.ts` | Shared types, including the message row the page renders. |
| `src/client/api.ts` | The page's typed wrappers over those routes, the localStorage state format, the window size bounds and `clampLength`, and the `saveState` / `onStateChange` event pair that carries a write to the running overlay. |
| `src/client/rooms.ts` | `RoomStore`: one room's page-side state, its own connection, history merge, dedup, title, alias, view, position. Also holds `stateTone` and `aggregateState`. |
| `src/client/overlay.tsx` | The container: reads the room history, creates stores, persists state, renders every window and the ball. |
| `src/client/window.tsx` | One floating danmaku window: title bar, message list, reply row, the offline veil, the resize regions and the status dot tooltip. |
| `src/client/ball.tsx` | The Bilibili TV ball and its room-management menu. |
| `src/client/dialog.tsx` | The notice layer: a centred card over a dimmed page, with a title, a left aligned message and one or more actions. Raised by an action and dismissed when it closes, so it owns no stored state. |
| `src/client/notices.ts` | Turns a credential condition into the notice that describes it. Words each Host reported code from the dictionaries and falls back to the Host's own sentence for a code this build does not know. |
| `src/client/config-page.tsx` | The plugin settings page, including the 前端设置 block at the end of its form that edits the browser-owned ball size. |
| `src/client/copy.ts` | The `zh` and `en` dictionaries and the `CopyKey` union. |
| `src/client/index.tsx` | Registers the overlay into `shell.overlay` and the settings page into `plugins.bundle.config`. |
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

### No `prepare` script while the output is committed

`package.json` declares only `build` and `typecheck`. It must not declare `prepare`, because the package ships its own `index.js` and `client.js` and has nothing to build at install time.

A `prepare` script is not merely redundant here, it breaks installation. pnpm treats it as a build script on a git-hosted dependency and refuses to run it without an entry in `allowBuilds`, so the install stops to ask the user to trust the package. The prompt is the thing a user sees first, and it appears for a plugin that needs no code generation at all. Granting it does not help either: pnpm does not install `devDependencies` for a git dependency, `build.mjs` imports `esbuild`, and the script therefore fails with `ERR_MODULE_NOT_FOUND`. Approving turns a successful install into a failed one.

The siblings that do carry `prepare` are source-only repositories, where the script is how `dist` comes into existence. This repository is not one of them while its output stays in Git, so the script has no work to do. Adding it belongs to the same release work that flips the repository to source-only: at that point it becomes necessary, and it arrives together with the `dist` entry that replaces the committed files.

## Host side

### Configuration

The entry config lives in the profile patch (`cordis.patch.yml`, entry id `include:bili-danmaku-overlay`) and is read through `src/config.ts`. `/api/config` projects only the fields the page needs, together with `boot`.

`boot` is `${process.pid}-${Date.now()}`, computed once per Host process. It exists so the page can tell one `dsh` run from the next, which is what bounds the lifetime of a temporary room title.

### Credentials

Read from `~/.dsh/.credentials.yaml` through the reference names `BILIBILI_SESSDATA` and `BILIBILI_JCT`. `buildCookie` returns an empty string when no credential is configured, and the read paths treat that as non-fatal: a request without it still resolves a room and still reads history, and only sending requires the cookie. A logged in request is what the plugin normally runs, so a test that carries it measures the real behaviour; an anonymous one measures what a logged out visitor would get.

Presence and validity are separate facts. `credentialStatus` reports the flags from the file, then spends one request on `x/web-interface/nav` to learn whether Bilibili still accepts the session. A correctly shaped token whose session has expired sat in the file while every call that needed it failed, and the local flags alone could not tell that apart from a healthy login. The verdict is `yes`, `no` or `unknown`, and `unknown` is the deliberate third state: a check that could not reach the network is not evidence against the token, so it must not send the user off to replace one that works. The overlay reports this verdict in the ball menu rather than in a toast, because a menu is where a user looks when sending or history misbehaves, and it rechecks each time that menu opens instead of on a timer.

**A verdict arrives with a code, and the code is what the page words from.** `CredentialStatus.code` names the condition (`expired`, `missing`, `unreadable`, `no-csrf`) with a value that never changes meaning, because the page is a bundle rebuilt independently of the process serving it and the two are not guaranteed to be the same version. A code this build has never heard of is therefore a normal state and not a defect: `notices.ts` words each code it knows from the dictionaries and falls back to the Host's own `reason` or `error` sentence for anything else. That split is also what lets a later login method, such as a scanned one, reject a session on its own terms without the page learning a new string. Wording a notice from `reason` alone would not work, because that sentence is written for whoever reads a log rather than for a reader deciding what to do next.

**A credential problem raises a notice on load only while `checkCredentialOnLoad` is on.** That setting defaults to true, and it is the one place a notice appears without the reader asking for it, because a login that has quietly stopped working is what makes sending fail with no explanation. Turning it off leaves the ball menu's credential row, which is pressable while the credential is unusable and inert while it is healthy or merely unverified, so the report stays available on demand. The load-time check waits for `/api/config` before deciding, because the flag arrives over the same fetch: raising the notice first and withdrawing it once the settings said otherwise would flash a modal at a reader who turned the behaviour off.

**The credential notice reserves a QR sign-in button that has no flow behind it yet.** Pressing it swaps the notice for one that says so. The entry is reserved before the flow is built because the alternative is a notice that tells the reader to edit a credential file by hand with no hint that a better path is coming, and reserving it keeps the wording and the placement stable while the flow is written. `DialogAction.replaces` exists for this swap: the notice layer otherwise closes after any action, which would discard the notice the callback had just put in its place.

**Only an unusable credential raises a notice, and "unusable" is narrower than "not valid".** `unknown` means the check could not reach Bilibili, and a request that never reached the Host is reported as `unreachable`; neither is the reader's to fix, and telling them to replace a working token is worse than saying nothing. Both stay visible as the neutral row in the menu.

### Room resolution

`resolveRoom` asks `getRoomBaseInfo` first. That response carries `title` and `uname`, which is why the window can be titled correctly and why the summary can say who spoke.

`getRoomBaseInfo` is keyed by the **real** room id. Asked about a short id it answers `code: 0` with an empty `by_room_ids`, and an entry can also arrive with an empty title. `baseInfo` reports both cases as `null` rather than passing a blank up.

`room_init` never reports a title or a streamer name. Its job is only to map a short id to the real id, which `resolveRoom` then feeds back into `baseInfo`. Without that second call, a room added by its short id would keep the `#<room>` label forever, because nothing later re-resolves the title.

**An offline room still reports its title.** `live_status: 0` describes whether a stream is running, not whether the room exists, so the title and streamer name are present for it. A window labelled only with a number is therefore a resolution bug and never an expected state for a room that exists.

A room number the user types may be a short id; the resolver maps it to the real `room_id`, and the real id is what every later call uses.

### Request density

The upstream answers `-352` when a client asks too often. Two things combined caused it once: a signing bug, and firing requests too densely. Keep polling at or above 0.1 seconds, and do not burst several live endpoints at the same instant.

The poller starts at `pollMinMs` (100ms by default), halves the interval on a 412 or a network error, and walks it back up on clean responses, capped at `MAX_POLL_MS` in `src/poller.ts` (30 seconds). History is plain HTTPS and is throttled separately from the comet socket.

### Viewer count and sending

The viewer count is `getOnlineGoldRank`'s `onlineNum`, a real head count. The `online` field other endpoints report is a popularity score that can be dozens of times larger, so the plugin does not read it.

Sending needs the csrf token: `bili_jct` becomes the request's `csrf_token`, and a missing one is a hard error rather than an anonymous attempt. An expired login answers `-101` and a bad csrf answers `-111`, and both are reported with that code instead of being retried.

Bilibili's comet server validates the WebSocket `Origin` and rejects a browser connection. That is why the Host holds the upstream socket and the page reads same-origin SSE, and it also keeps the danmaku token server-side.

The history endpoint is misleading: it answers `code: 0` with empty `room` and `admin` arrays, which reads as "this room has no history" but can mean "not authenticated" or "throttled". Carrying the credential is necessary and not sufficient. Measured on a room delivering a danmaku a second, the call returned both arrays empty with a cookie and without one, while `nav` refused that same cookie with `-101`, so an empty pair is a degradation signal rather than proof of silence. `fetchHistory` therefore throws on an empty pair instead of returning zero items. Left as a silent success it defeated the poller: every read succeeded, so the interval stayed pinned at its 100ms floor, which is the opposite of the backoff the poller exists to apply.

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

The page keeps one document in localStorage: the room list, per-room view, alias and position, the ball size, the window size, the ball position, and the Host `boot` id it last saw.

- A **temporary room title** (the alias) survives a page reload and is dropped when the stored `boot` differs from the one `/api/config` reports, which is to say after a `dsh` restart. The first sighting only records the id.
- The legacy single-room shape (`room`, `enabled`, `collapsed`, `place`) is still read and folded into the list form, so an upgrade does not lose the room someone was watching. This is a bounded transition; see `AGENTS.md` section 5.
- `saveState` replaces the whole document rather than merging into it, so a caller that only means to change one field reads the document, spreads it, and writes it back. **A field that a write forgets is a field it erases**, which is why `persist` spreads the stored document instead of rebuilding it field by field: a rebuild silently dropped `uiScale` on every drag and reset the zoom to its default. The spread is not unconditional, because the single-room save shape (`room`, `enabled`, `collapsed`, `place`) is read once and must not be written back: `enabled` is what folds that room in, so keeping it alive would bring a removed room back on the next load. `persist` omits those four while keeping everything else.
- `persist` reads the settings it does not own from storage rather than from its own render scope for the same reason the spread exists: the settings page writes those fields directly, and a stale copy in the overlay would overwrite a slider the user had just moved.
- **A reload never resumes a room.** `rooms` records what was monitored, and that is all it records: it feeds the menu's shortlist together with `recentRooms`, and connecting is a deliberate act. The only room that opens on load is the one dsh is configured with, and only when `autoConnect` is on. Reconnecting a stream the user did not ask for would spend a socket and an upstream poll on a room nobody is reading.
- `recentRooms` is the browser's own history of rooms it has opened, newest first, capped by `RECENT_ROOM_LIMIT`. A room that is stopped stays in it, because the point of the list is reopening one after it was stopped. `persist` folds a live room into the list only when the list does not already hold it, so a window that merely moved does not reorder the menu on every write.
- `saveState` also dispatches `dsh-bili-danmaku-overlay:state` on `window`. `localStorage.setItem` raises a `storage` event in every other document but never in the one that wrote it, and the settings page and the overlay share one document, so the write has to announce itself. `onStateChange` subscribes to that event and to `storage`, which is what makes a front-end setting take effect on the running overlay without a reload.

### Presentation settings the browser owns

The ball diameter is not in the Host schema. It is a taste setting that belongs to the screen the overlay sits on, it needs no server round trip, and a per-browser value is the honest model, because the same account on a small laptop and on a large monitor wants different values. It lives under `ballSize` in the same document as the layout, and the plugin page renders it in a **前端设置** block at the end of the configuration form rather than as one of the form's own rows, because the form's save button and revision fence would misdescribe a value the Host never stores.

The block is part of `ConfigPage`, which is registered on `plugins.bundle.config`. That slot renders above the "包含的组件" list, which is what puts 前端设置 before it. `plugins.detail.section` would have placed a section after the source block instead, and it has no key domain, so every entry there renders on every package's page and has to filter on the `subject` itself.

The window size has no control in the section: it is dragged from the window's edges and corners and stored as `windowWidth` and `windowHeight` next to `ballSize`. It still appears in the section as a read-only 弹幕窗口大小 row, because the reset has to cover it and a value the reset changes must be visible somewhere.

**The reset button restores every front-end value at once**, which is the ball size, both window dimensions and the window's internal zoom. It is disabled while all of them already equal their defaults, so the control doubles as the answer to whether this section has been touched. A reset that restored the ball but left a hand-dragged window would not restore the shipped layout, which is the only thing the button promises.

The bounds are `MIN_WINDOW_WIDTH` 240 to `MAX_WINDOW_WIDTH` 720 and `MIN_WINDOW_HEIGHT` 180 to `MAX_WINDOW_HEIGHT` 760, with defaults of 320 by 300. `clampLength` rounds and clamps every stored or dragged value, so a hand-edited localStorage entry cannot produce an unusable card.

### The window's internal zoom

`uiScale` is a percentage, 50 to 300, defaulting to `DEFAULT_UI_SCALE` 100. It scales the contents of a danmaku window and nothing else: fonts, gaps, padding, the status dot, the icon buttons, the grips and the row line height are all multiplied by it, while the card's own width and height keep obeying the drag. The two settings are separate on purpose, so a reader can enlarge the text without the window covering more of the page. The ball's menu applies the same ratio, so the room list and the windows always agree on text size.

The scaling multiplies each interior length rather than putting a CSS `zoom` or a `transform` on the card. A zoom on the card would rescale its own `position: fixed` offsets, so a drag would report one position and the stored layout would mean another, and the resize grip would measure a length the user did not ask for. `px` keeps every scaled value a whole pixel with a floor of one, so a hairline gap never collapses at a small zoom.

At 100 the contents draw at the size CSS declares, which the browser's own page zoom already multiplies, so an untouched profile follows the page. The range is wider than the comfortable one on purpose: `COMFORTABLE_UI_SCALE_MIN` 80 and `COMFORTABLE_UI_SCALE_MAX` 150 only choose which hint the settings row prints, and an extreme value warns rather than being refused.

Two parts of the card cannot scale freely, because the two settings are independent and a 240px window at 300% cannot fit chrome drawn at three times its size. The icon buttons shrink to about a third of their drawn width rather than overflowing the hidden edge, which keeps the close button reachable in a narrow card, and the list carries a percentage `minHeight` rather than a scaled pixel floor, so a short card never pushes the reply row out of view. The minimization step scales with the title bar it has to clear.

**The ball's menu offers rooms that are not monitored.** It pins the room dsh is configured with under its own heading, lists the monitored rooms below it, and then lists the rest of `recentRooms` under 最近连接 so a room can be reopened without typing its number again. The configured room is filtered out of the history section, because a room shown twice under two headings reads as two rooms. A room that is only in the history carries a neutral dot rather than a connection colour, since it is a candidate and not a stream. Each entry carries a close button that drops it from `recentRooms`. That removal writes the stored list directly instead of going through `persist`, because `persist` folds every monitored room back into the history as a side effect of saving the layout, which would resurrect a room that had only just been removed.

**The ball's menu follows `uiScale`, not the ball diameter.** The menu lists the same rooms the windows show, so a reader who enlarged one text expects the other to match, and a menu drawn at 100% beside a 300% window would read as a bug rather than as a setting. Its width, height cap, padding, row gaps, status dots and buttons all go through the same ratio. The width and height cap are still clamped by the viewport and the safe area afterwards, so a 300% menu on a phone scrolls inside the screen rather than growing off it.

**The menu travels with the ball while it is dragged.** Positions come from the ball's live anchor, so the menu is recomputed on every pointer move rather than closed and reopened at the new spot. It is drawn during the drag with `pointerEvents: none`: the press belongs to the drag, and a menu that kept taking clicks would swallow the gesture it sits on top of.

**The menu is resizable, and its size is not persisted.** The drag lives in component state and a reload returns the menu to its default size. The menu is a transient surface that is opened to pick a room and closed again, so a size that outlived the page would have the menu opening at a shape the reader never chose in that session. The danmaku windows keep their size because they stay on screen and their size is a layout the reader builds up; the menu does not. A profile with many monitored rooms still needs a taller menu than the default, which is what the height drag exists for. **An untouched menu sizes itself to its content and only obeys a cap**, so it opens short for a profile with one room instead of leaving a tall empty panel; a height the reader dragged is pinned, because that gesture chose a size rather than a limit. Exactly one grip is drawn rather than four, and it sits on the corner that actually moves. The menu is anchored to the ball, so the two edges nearest the ball are pinned and the two far edges are free: a menu unfolding leftwards hangs its right edge on the ball, and one unfolding rightwards hangs its left edge there, while a menu below the ball pins its top edge and one above pins its bottom. The grip therefore moves between the four corners as the ball is dragged around the page, and **each axis grows towards the drag**: moving the pointer left widens a leftwards menu and narrows a rightwards one, and moving it down deepens a menu below the ball while shortening one above it. Getting this wrong is not cosmetic, because a grip on a pinned corner would resize the menu in the opposite direction to the pointer. A dragged height is a size rather than a ceiling, so it follows the pointer past the default cap and the room list scrolls inside it instead of the menu collapsing back to its content; `minHeight: 0` on that list is what lets it shrink below its content at all. A gesture starts from the box measured off the DOM rather than from the stored box, because the stored box is the height the menu may reach and an untouched menu is usually shorter than it, so starting there would snap the menu taller on the press. The measurement is in CSS pixels while the box is a logical size that `ds` scales, so it is divided by the zoom on the way in and the pointer displacement is divided on the way out; without both halves a scaled profile would resize the menu at the wrong rate.

The ball's own expanded summary is the opposite case and scales with `size` instead. The dot is sized by its own diameter slider, and a summary drawn at the zoom of the windows would leave a 96px dot carrying 12px text, which reads as two objects rather than one control. So `bs` follows the diameter and `ds` follows the zoom, and the two are deliberately separate.

### Resizing

**A window resizes from every edge except the top one, and the drawn strokes are a hint rather than the extent of it.** The left and right strips resize sideways, the bottom strip resizes the height alone so that a slightly diagonal drag cannot change two sizes at once, and both bottom corners take a two-axis drag. Exactly one corner draws the two strokes, which is purely cosmetic: the other corner and the plain edges respond the same way, and a reader who grabs an unmarked edge expects it to work. **The top edge is never resizable and carries no region at all**, so a window is moved only by its title bar and resized only from below, and the two gestures never write the same coordinate, which is what would otherwise make a card jump. The height therefore only ever grows downwards. The visible strokes gather into the corner they sit in, which is why the left corner uses the opposite gradient angle rather than a mirrored one, and the marked corner is chosen by available room and frozen for the duration of a gesture so that reaching the opposite edge mid-drag cannot move the strokes out from under the pointer. A resize of the left side owns the card's left coordinate and holds the right edge still, so it reports the place as well as the size; a card that has never been placed has no stored place to move and keeps its ball anchor, where the size change already produces the same motion on screen. Growth stops at the screen edge rather than at the card's own maximum, so a card floating in the middle of the page cannot be pulled past the edge, and one already against the opposite edge can still be resized by dragging the free side. The gesture is held in state for the same reason the drag position is: a new danmaku re-renders the card continuously, and a size written only to the DOM would be reset from the props on the next render. The gesture reports only the release, because a per-frame callback would write to storage on every pointer move.

- **The size is shared by every room window.** One size rather than one per room, because the windows are read at a glance and a different size per room would make the stack look accidental.
- **A minimized window ignores the stored height.** It is its title bar, so a stored height would leave an empty card hanging below it. It keeps the stored width, and it cannot be resized at all.

### The offline veil

**A room that is not streaming shows a veil instead of its danmaku.** The message list is replaced by the room's own notice and a 查看弹幕 button, and the reply input carries the same text as its placeholder and is disabled. Pressing the button reveals the list and releases the input; sending is not restricted further once it is released, because an offline room still accepts a danmaku. The revealed state is component state and is deliberately not persisted, so a reload puts the veil back.

The veil reads `instance.state === 'offline'`, the same value the status dot uses, so the two can never disagree about one room.

### The status dot

The dot's `<span>` carries a `title`, which is the browser's own tooltip. The colour is the state's tone and the text says which of the five situations the room is in, because two of them share a tone.

| Situation | `state` | Dot | Tooltip |
| --- | --- | --- | --- |
| Not streaming, veil up | `offline` | grey | 未开播 |
| Not streaming, danmaku revealed | `offline` | grey | 未开播（正在查看弹幕） |
| Connection failed | `error` | red | 连接失败 |
| Reading history, socket not up yet | `connecting`, `reconnecting` | orange | 正在查看历史弹幕 |
| Streaming and connected | `live` | green | 已连接 |
| No room connected | `idle` | grey | 未连接 |

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
| `GET /api/credential` | Whether a login is configured and whether Bilibili still accepts it, never the credential itself. |
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
