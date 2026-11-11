# Bilibili Live Danmaku Overlay

English | [简体中文](README.zh.md)

Shows Bilibili live-room danmaku in a floating overlay inside the DSH Web UI. The overlay stays mounted across page changes, so you can watch a room while you work.

## Features

- Live danmaku with automatic reconnect, and a history fallback when the live socket is unavailable
- Multiple rooms at once, each in its own window
- A round Bilibili television entry that shows the overall state and the newest danmaku, and opens a menu that manages every room
- Windows are titled with the room's real title; double-click to rename one temporarily
- Resize a window from its bottom right corner, or minimize it to its title bar, or fold it back into the ball, none of which stops its stream
- A room that is not streaming shows "not live" first; press View danmaku to reveal the list and unlock the input
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

## Front-end settings

The Front-end settings block on the configuration page is stored in the browser only and never written to the dsh configuration. A slider takes effect immediately.

| Option | Range | Default |
| --- | --- | --- |
| Ball diameter | 32-96px | 48px |
| Window zoom (DPI) | 50-300% | 100% |
| Window size | 240-720 by 180-760px | 320 by 300px |

A window is resized by dragging its bottom right corner. A minimized window is only its title bar, so its size is not adjustable.

The zoom changes the size of the text, spacing and buttons inside a danmaku window, and also the room list behind the floating ball, while leaving the window itself alone, so the two are adjusted separately. At 100% it follows the browser's own zoom for the page. A value far above or below the comfortable range is still accepted, and the settings row says so.

The reset button at the top right of the block restores the ball diameter, the window zoom and the window size. It stays disabled while nothing has been changed.

## Notes

- The viewer count is a real head count, not the popularity score some Bilibili endpoints report.
- Hover the status dot in a window's top left corner to read the exact state: not live, connection failed, reading history danmaku, or connected.

## Development

The sources are TypeScript. `index.js` and `client.js` are build output and are committed.

```bash
npm run build
npm run typecheck
```

Rebuild after editing `src/`. `client.js` reaches the page on a refresh; `index.js` is the Host half and needs `dsh` restarted.

## License

MIT
