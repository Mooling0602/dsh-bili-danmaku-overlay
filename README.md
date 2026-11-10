# Bilibili Live Danmaku Overlay

Shows Bilibili live-room danmaku in a floating overlay inside the DSH Web UI. The overlay mounts on the `shell.overlay` slot, so it survives page changes and you can watch a room while you work.

## Features

- Live danmaku streamed from the Host to the page over SSE, with automatic reconnect
- **Falls back to polling when the socket cannot connect**: while the live stream is down the overlay reads history instead, so the room stays readable. History uses plain HTTPS and is throttled separately from the comet socket.
- **One poller per room**: the upstream request rate is fixed no matter how many pages are open, so extra tabs do not multiply the load on Bilibili.
- **Automatic backoff**: as fast as 100ms per round when healthy; a 412 or a network error halves the rate repeatedly (up to 30s) and clean responses walk it back down.
- Real viewer count in the header (actual head count, not the popularity score)
- Send danmaku, using the login already stored in DSH credentials
- Loads recent history on connect, so messages sent before the panel opened are not lost
- De-duplicates on the stable message id, so replays and overlapping sources never duplicate a row
- Drag to move, collapse, close; position and state persist locally
- Every option is editable in the plugin settings page and applies immediately

## Install

```bash
cd ~/Workspace/dsh-plugins/dsh-bili-danmaku-overlay
npm install          # also runs a build
```

Then register it in your profile:

```json
{
  "dependencies": {
    "@local/bili-danmaku-overlay": "link:<absolute path to this package>"
  }
}
```

The package ships its own `cordis.patch.yml`, so the bundle inserts the plugin on install.

## Credentials

**This plugin does not manage credentials.** `SESSDATA` and `bili_jct` are read from the DSH credential file `~/.dsh/.credentials.yaml`, which you maintain. The plugin only reads them: it never writes them, never returns a value to the page, and never logs them.

Add two entries under `refs`:

```yaml
refs:
  BILIBILI_SESSDATA: <your SESSDATA>
  BILIBILI_JCT: <your bili_jct>
```

To get the values: log in to Bilibili in a browser, open developer tools → Application → Cookies → `https://www.bilibili.com`, and copy `SESSDATA` and `bili_jct`.

- `BILIBILI_SESSDATA` alone is enough to watch danmaku, but **sending needs the csrf token** (`bili_jct`).
- `BILIBILI_SESSDATA` may also hold a whole Cookie header; the plugin detects that.
- An expired login answers `-101` when sending. Copy the cookie again to refresh it.
- **The history endpoint requires the login.** Anonymous callers get `code: 0` with empty `room` and `admin` arrays, which looks like “this room has no history” but is really “not authenticated”. Every request the plugin makes carries the credential.
- **The danmaku handshake requires the login too.** The op-7 packet carries the account uid, read from the same `nav` call that signs the token request. An anonymous uid is refused with an error frame and the socket is dropped, so a handshake sent as `uid: 0` yields a connection that never delivers a message. A refused handshake is reported as an error with its code rather than retried blindly.

## Settings

The options are defined by the `Config` schema and rendered through DSH's own settings primitives, so the page carries the platform's fields, overridden badges, reset controls and save flow. Edits stage locally and one save writes them together. A `.volatile()` field applies without a restart.

| Option | Default | Description |
| --- | --- | --- |
| `defaultRoom` | empty | Room id to open with; empty means type one each time |
| `autoConnect` | `false` | Connect to the default room on load |
| `historyLimit` | `200` | Rows kept in the overlay (20–2000) |
| `historyFetch` | `50` | Items fetched per history request (10–200) |
| `statsIntervalMs` | `60000` | Viewer-count refresh interval (10s–10min) |
| `heartbeatMs` | `30000` | Upstream socket heartbeat (10s–2min) |
| `showEnterMessages` | `true` | Show “entered the room” notices |
| `showSuperChat` | `true` | Show super chat messages |
| `requestTimeoutMs` | `12000` | Bilibili request timeout (3s–60s) |

## Development

The sources are TypeScript; `index.js` and `client.js` are build output and are committed.

```bash
npm run build       # build both halves
npm run typecheck   # type check without emitting
```

Layout:

```
host.ts             Host entry: registers the routes
src/config.ts       Config schema and readers
src/credentials.ts  Credential reading (read-only, ~/.dsh/.credentials.yaml)
src/bili.ts         Bilibili API, WBI signing, sending
src/comet.ts        Comet protocol encode/decode
src/stream.ts       SSE streaming and history
src/routes.ts       HTTP routes
src/client/         The browser overlay
```

Rebuild after editing `src/`. `client.js` is browser-only, so a page refresh is enough; `index.js` is the Host half and needs a dsh service restart.

## Notes

- Observing any room read-only is fine, but **only send danmaku to your own room**, never to someone else's.
- The viewer count comes from `getOnlineGoldRank`'s `onlineNum`, which is a real head count. The `online` field other Bilibili endpoints report is a popularity score that can be dozens of times larger; this plugin does not use it.
- Bilibili's comet server validates the WebSocket `Origin` and rejects a browser connection, so the Host holds the upstream socket and the page reads same-origin SSE — which also keeps the danmaku token server-side.

## License

MIT
