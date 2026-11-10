# Bilibili Live Danmaku Overlay

Shows Bilibili live-room danmaku in a floating overlay inside the DSH Web UI. The overlay stays mounted across page changes, so you can watch a room while you work.

## Features

- Live danmaku with automatic reconnect, and a history fallback when the live socket is unavailable
- Multiple rooms at once, each in its own window
- A round Bilibili television entry that shows the overall state and the newest danmaku, and opens a menu that manages every room
- Windows are titled with the room's real title; double-click to rename one temporarily
- Minimize a window to its title bar, or fold it back into the ball without stopping its stream
- Viewer count, danmaku sending, and a plugin settings page for every option

## Install

```bash
dsh plugin --profile web add github:Mooling0602/dsh-bili-danmaku-overlay
```

Restart dsh after installing. The package carries its own `cordis.patch.yml`, so dsh inserts the plugin into the bundle by itself. It ships built JavaScript, so installation needs no compiler step.

Then open the plugin settings page and set `defaultRoom` to the room you want to watch.

To uninstall:

```bash
dsh plugin --profile web remove dsh-bili-danmaku-overlay
```

## Credentials

The plugin does not manage credentials. It reads `SESSDATA` and `bili_jct` from `~/.dsh/.credentials.yaml`, which you maintain.

```yaml
refs:
  BILIBILI_SESSDATA: <your SESSDATA>
  BILIBILI_JCT: <your bili_jct>
```

To get the values: log in to Bilibili in a browser, open developer tools, then Application, then Cookies for `https://www.bilibili.com`, and copy the two values.

Watching needs only `SESSDATA`. Sending danmaku also needs `bili_jct`.

## Settings

Every option is editable on the plugin settings page and applies immediately.

| Option | Default | Description |
| --- | --- | --- |
| `defaultRoom` | empty | Room to open with; empty means type one each time |
| `autoConnect` | `false` | Connect to the default room on load |
| `historyLimit` | `200` | Rows kept in a window |
| `historyFetch` | `50` | Items fetched per history request |
| `pollMinMs` | `100` | Fastest history poll interval; the poller backs off above it on errors |
| `statsIntervalMs` | `60000` | Viewer-count refresh interval |
| `heartbeatMs` | `30000` | Upstream socket heartbeat |
| `showEnterMessages` | `true` | Show "entered the room" notices |
| `showSuperChat` | `true` | Show super chat messages |
| `requestTimeoutMs` | `12000` | Request timeout |

## Notes

- Watching any room read-only is fine, but only send danmaku to your own room, never to someone else's.
- The viewer count is a real head count, not the popularity score some Bilibili endpoints report.

## Development

The sources are TypeScript. `index.js` and `client.js` are build output and are committed.

```bash
npm run build
npm run typecheck
```

Rebuild after editing `src/`. `client.js` reaches the page on a refresh; `index.js` is the Host half and needs `dsh` restarted.

## License

MIT
