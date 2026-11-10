# B站直播弹幕浮层

[English](README.md) | 简体中文

在 DSH Web 界面里以常驻浮层显示 B 站直播间弹幕。浮层切换页面时不会卸载，可以一边干活一边看弹幕。

## 功能

- 实时弹幕，断线自动重连；实时连接不可用时自动回退到历史拉取
- 同时监控多个直播间，每个房间一个独立浮窗
- B站小电视圆形入口，聚合显示整体连接状态和最新弹幕，点击展开菜单管理全部直播间
- 浮窗标题显示直播间真实标题，双击可以临时改名
- 可以把浮窗最小化为标题栏，也可以收回悬浮球，两种方式都不会中断监控
- 显示在线人数，可以发弹幕，所有配置项都能在插件设置页里改

## 安装

```bash
dsh plugin --profile web add github:Mooling0602/dsh-bili-danmaku-overlay
```

安装完成后重启 dsh。包内自带 `cordis.patch.yml`，dsh 会自己把插件插入 bundle。包内已经带有构建好的 JavaScript，所以安装过程不需要编译。

之后打开插件设置页，把 `defaultRoom` 设成要看的直播间号即可。

卸载：

```bash
dsh plugin --profile web remove dsh-bili-danmaku-overlay
```

## 配置登录凭据

插件不管理凭据，`SESSDATA` 和 `bili_jct` 从 `~/.dsh/.credentials.yaml` 读取，由你自己维护。

```yaml
refs:
  BILIBILI_SESSDATA: <你的 SESSDATA>
  BILIBILI_JCT: <你的 bili_jct>
```

取值方式：浏览器登录 B 站后打开开发者工具 → Application → Cookies → `https://www.bilibili.com`，复制这两个值。

只看弹幕只需 `SESSDATA`，发弹幕还需要 `bili_jct`。

## 插件设置

所有配置项都能在插件设置页里改，修改后即时生效。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultRoom` | 空 | 默认直播间号，留空则每次手动输入 |
| `autoConnect` | `false` | 页面加载后自动连接默认直播间 |
| `historyLimit` | `200` | 浮窗最多保留的弹幕条数 |
| `historyFetch` | `50` | 每次拉取的历史条数 |
| `pollMinMs` | `100` | 历史轮询的最快间隔，出错时自动退避到更慢 |
| `statsIntervalMs` | `60000` | 在线人数刷新间隔 |
| `heartbeatMs` | `30000` | 弹幕服务器心跳间隔 |
| `showEnterMessages` | `true` | 显示「进入直播间」消息 |
| `showSuperChat` | `true` | 显示醒目留言 |
| `requestTimeoutMs` | `12000` | 接口请求超时 |

## 说明

- 只读观察任意直播间是安全的，但请只在自己的直播间发弹幕，不要向别人的直播间发送。
- 在线人数是真实观看人数，不是 B 站某些接口返回的人气值。

## 开发

源码是 TypeScript，`index.js` 和 `client.js` 是构建产物。

```bash
npm run build
npm run typecheck
```

改完 `src/` 后重新构建。`client.js` 刷新页面即可生效；`index.js` 是 Host 侧，需要重启 `dsh`。

## 许可证

MIT
