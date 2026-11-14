# B站直播弹幕浮层

简体中文 | [English](README.en.md)

[![dsh-badge](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![license-mit-badge](https://img.shields.io/github/license/Mooling0602/dsh-bili-danmaku-overlay?style=flat-square)](https://github.com/Mooling0602/dsh-bili-danmaku-overlay/blob/main/LICENSE)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面（`dsh web`）里以常驻浮层显示 B 站直播间弹幕。浮层切换页面时不会卸载，可以一边干活一边看弹幕。

> [!TIP]
> 本插件是为 dsh 的 web 界面设计的，但也尽量支持其他不属于 [deepseek-ai](https://github.com/deepseek-ai) 和 dsh 的下游项目，比如 [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) 等。
>
> 你可以报告与基于 dsh 开发的下游项目的兼容性问题，在插件功能可以同时兼容官方 dsh 和该项目时，维护者会进行改进。插件不会进行任何针对于其他项目的兼容性声明，如果插件可以正常工作，请忽略与此相关的任何提示或警告信息。

## 功能

- 实时弹幕，断线自动重连；实时连接不可用时自动回退到历史拉取
- 同时监控多个直播间，每个房间一个独立浮窗
- B站小电视圆形入口，聚合显示整体连接状态和最新弹幕，点击展开菜单管理全部直播间，并可以直接重新打开这台浏览器连接过的直播间
- 浮窗标题显示直播间真实标题，双击可以临时改名
- 可以拖动浮窗右下角调整大小，也可以把浮窗最小化为标题栏或收回悬浮球，都不会中断监控
- 房间未开播时先显示「当前房间未开播」，点「查看弹幕」才展开内容并解锁输入框
- 显示在线人数，可以发弹幕，所有配置项都能在插件设置页里改

## 安装

```bash
dsh plugin --profile web add github:Mooling0602/dsh-bili-danmaku-overlay
```

通过图形化界面安装时，只需要输入 `github:Mooling0602/dsh-bili-danmaku-overlay` 并进行确认即可。

安装完成后重启 dsh。包内自带 `cordis.patch.yml`，dsh 会自己把插件插入 bundle。也带有构建好的 JavaScript，所以安装过程不需要编译。

之后点击小电视悬浮窗即可使用插件功能。打开插件配置页可以调整更多偏好设置。

卸载：

```bash
dsh plugin --profile web remove dsh-bili-danmaku-overlay
```

## 配置登录凭据

> [!WARNING]
> 登录凭据保存在 dsh 宿主机上，而不是浏览器本地缓存。
>
> 确保你所使用的 dsh 实例只属于你自己，否则不建议使用本插件！

有两种登录方式，任选其一即可。推荐直接扫码登录。

第一种是在插件里扫码登录。当插件没有可用的凭据时，悬浮球菜单会显示相关报错，点击后弹窗里可以扫码登录。获取的登录态将保存在 `~/.dsh/bili-danmaku-overlay/credential.json`，文件只有你自己可读，并且所有 profile 共用，因此只需扫一次而不是每个 profile 扫一次。扫码登录会自行续期，不需要你反复操作。

第二种是在 `~/.dsh/.credentials.yaml` 里放 `SESSDATA` 和 `bili_jct`，由你自己维护。

```yaml
refs:
  BILIBILI_SESSDATA: <你的 SESSDATA>
  BILIBILI_JCT: <你的 bili_jct>
```

取值方式：浏览器登录 B 站后打开开发者工具 -> Application -> Cookies -> `https://www.bilibili.com`，然后找到并复制这两个值。

只看弹幕只需 `SESSDATA`，发弹幕还需要 `bili_jct`。

> 这份凭据的有效期较短，且不续期，需要频繁维护。不想维护的话，用扫码登录更省事。

两种凭据都存在时由 `preferCustomCredential` 决定用哪个，默认开启表示优先用你手写的那份，扫码登录作为回退。关掉它则优先用扫码登录，例如手写的那份属于你已经不想再用的账号。

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
| `checkCredentialOnLoad` | `true` | 页面加载时检查登录凭据，不可用时弹窗说明；仅在自动连接开启时生效 |
| `preferCustomCredential` | `true` | 优先使用 dsh refs 中的凭据而不是扫码登录获得的登录态；首选不可用时改用另一个 |

## 前端设置

配置页里的「前端设置」只保存在当前浏览器，不写入 dsh 配置，拖动滑块即时生效。

> [!IMPORTANT]
> 只支持在官方 dsh web 页面内，通过插件配置页中显示的控件进行调整。

| 选项 | 范围 | 默认值 |
| --- | --- | --- |
| 悬浮球大小 | 32–96px | 48px |
| 窗口内缩放（DPI） | 50–300% | 100% |
| 弹幕窗口大小 | 240–720 × 180–760px | 320×300px |

弹幕窗口的大小直接拖动窗口右下角调整，最小化的窗口只显示标题栏，不受影响。

「窗口内缩放」改变弹幕窗口里文字、间距和按钮的大小，也作用于悬浮球点开后的「正在监控弹幕的直播间」列表，但不影响窗口本身的大小，两者可以分开调。100% 表示跟随当前页面的浏览器缩放；数值过大或过小时设置页会给出提示，但仍然可以保存。

「前端设置」右上角的重置按钮会把悬浮球大小、窗口内缩放和弹幕窗口大小一起还原成默认值，没有改动时该按钮不可用。

## 其他说明

- 直播间弹幕窗口标题栏上显示的数字是真实的实时观看人数。
- 鼠标移到窗口左上角的状态点上，可以看到未开播、连接失败、正在查看历史弹幕、已连接、未连接这些具体状态；未开播的房间在展开弹幕后显示的是「未开播（正在查看弹幕）”。
- 首次连接直播间后，如果不显示历史弹幕消息，可以尝试手动刷新。很久没开播并且没有新弹幕的直播间可能仍会显示「主播暂未开播」。

## 开发

源码是 TypeScript，`index.js` 和 `client.js` 是构建产物。

```bash
npm run build
npm run typecheck
```

改完 `src/` 后重新构建。`client.js` 刷新页面即可生效；`index.js` 是 Host 侧，需要重启 `dsh`。

在插件开始发布正式版本后，所有的 js 文件将从 git 仓库内移除，需要使用预构建或者允许本地编译（请自行处理）。

## 许可证

MIT

## 免责声明

本插件使用的所有接口均为[哔哩哔哩视频网站](https://www.bilibili.com)的公开接口，不会收集和上传任何信息到任何额外的服务器地址。如果发现安全问题，请视情况在 [Issues](https://github.com/Mooling0602/dsh-bili-danmaku-overlay/issues) 或通过维护者个人 GitHub 主页的邮箱进行反馈。

本插件**不会支持管理多个账号的凭据，以防止黑灰产滥用等情况**。在使用本插件的过程中，请妥善保存好你的个人凭据信息，如意外泄露请及时到账号后台退出登录异常设备。

本插件提供的弹幕信息发送功能仅设计为供人类用户通过操作前端图形界面的方式使用。通过外接其他插件或外部软件、修改源代码或载入自定义代码等方式滥用此功能的行为，应由使用者自负后果，维护者对此不承担任何责任。
