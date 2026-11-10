# B站直播弹幕浮层

在 DSH Web 界面里以常驻浮层显示 B 站直播间弹幕。浮层挂在 `shell.overlay` 槽位上，切换页面时不会卸载，可以一边干活一边看弹幕。

## 功能

- 实时弹幕，通过 SSE 从 Host 推送到页面，断线自动重连
- **WS 连不上时自动降级**：轮询历史接口，仍能看到弹幕（历史走 HTTPS，和 WS 是两套风控）
- **每个房间只有一个拉取器**：无论开几个页面，对 B 站的请求量都固定为一个，不会随页面数翻倍
- **自动退避**：正常时最快 100ms 一轮；出现 412 或网络错误就逐步降频（上限 30 秒），连续成功后再平滑回升
- 显示当前在线人数（真实观看人数，非人气值）
- 可以发弹幕，从 DSH 凭据读取登录态
- 连接时拉取历史弹幕，补偿开窗前的消息
- 按稳定消息 id 去重，重放和重复投递都不会产生重复行
- **多直播间**：可以同时监控多个房间，每个房间一个独立浮窗，各自独立连接
- **B站小电视悬浮球**：常驻的圆形入口（默认停在右上角，可拖到任意位置），聚合显示连接状态和最新的弹幕，点击展开菜单管理全部直播间；大小可在插件设置页调
- 浮窗标题显示直播间真实标题，双击可以临时改名；临时标题只保留到下次 dsh 重启，之后回退到直播间标题
- 最小化后几秒内隐藏控件，只留状态圆点和最新一条弹幕；有新弹幕或点击时恢复
- 关闭窗口只是把窗口收回悬浮球，监控不会中断；要停止监控某个房间，在悬浮球菜单里退出
- 拖拽移动、最小化、改名、位置都会本地保存，刷新浏览器不丢
- 所有配置项都能在插件设置页里改，即时生效

## 安装

```bash
cd ~/Workspace/dsh-plugins/dsh-bili-danmaku-overlay
npm install          # 同时会跑一次 build
```

然后在 profile 里注册：

```json
{
  "dependencies": {
    "@local/bili-danmaku-overlay": "link:<本包的绝对路径>"
  }
}
```

包内自带 `cordis.patch.yml`，安装后由 bundle 自动插入插件。

## 配置登录凭据

**插件不管理凭据。** `SESSDATA` 和 `bili_jct` 从 DSH 的凭据文件 `~/.dsh/.credentials.yaml` 读取，由你自己维护。插件只读不写，也不会把凭据值返回给前端或写进日志。

在 `refs` 段下添加两项：

```yaml
refs:
  BILIBILI_SESSDATA: <你的 SESSDATA>
  BILIBILI_JCT: <你的 bili_jct>
```

取值方式：浏览器登录 B 站后打开开发者工具 → Application → Cookies → `https://www.bilibili.com`，复制 `SESSDATA` 和 `bili_jct` 两个值。

- 只填 `BILIBILI_SESSDATA` 也能看弹幕，但**不能发弹幕**（发送需要 csrf 校验）。
- `BILIBILI_SESSDATA` 允许直接粘贴整段 Cookie，插件会自动识别。
- 登录过期后发弹幕会报 `-101`，重新复制 Cookie 即可。
- **历史弹幕接口必须带登录态。** 匿名调用会返回 `code: 0` 但 `room` 和 `admin` 都是空数组，看起来像“这个直播间没有历史”，实际是没登录。插件在所有请求上默认带上凭据。
- **弹幕握手也必须有登录态。** op-7 包里带的是账号 uid，和签名用的 `nav` 是同一个请求取回来的。匿名 uid 会被服务端回一个错误帧然后断开，所以用 `uid: 0` 建立起来的连接收不到任何弹幕。握手被拒时按照错误码报错，不会闷头重连。

## 插件设置

配置项由 `Config` schema 定义，页面用 DSH 自己的设置组件渲染，字段样式、已修改标记、重置和保存流程都跟官方页面一致。改动先在本地暂存，一次保存统一写入（标了 `.volatile()` 的字段不需要重启）。

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `defaultRoom` | 空 | 默认直播间号，留空则每次手动输入 |
| `autoConnect` | `false` | 页面加载后自动连接默认直播间 |
| `historyLimit` | `200` | 浮层最多保留的弹幕条数（20–2000） |
| `historyFetch` | `50` | 每次拉取的历史条数（10–200） |
| `statsIntervalMs` | `60000` | 在线人数刷新间隔（10s–10min） |
| `heartbeatMs` | `30000` | 弹幕服务器心跳间隔（10s–2min） |
| `showEnterMessages` | `true` | 显示「进入直播间」消息 |
| `showSuperChat` | `true` | 显示醒目留言 |
| `requestTimeoutMs` | `12000` | B 站接口请求超时（3s–60s） |

## 开发

源码是 TypeScript，`index.js` 和 `client.js` 是构建产物，都在仓库里。

```bash
npm run build       # 构建两个产物
npm run typecheck   # 类型检查，不产出文件
```

目录结构：

```
host.ts             Host 入口：注册路由
src/config.ts       配置 schema 与读取
src/credentials.ts  凭据读取（只读 ~/.dsh/.credentials.yaml）
src/bili.ts         B 站接口、WBI 签名、发弹幕
src/comet.ts        comet 协议编解码
src/stream.ts       SSE 推流与历史拉取
src/routes.ts       HTTP 路由
src/client/         前端浮层
```

改完 `src/` 后重新构建。`client.js` 是纯前端，刷新页面即可生效；`index.js` 是 Host 侧，需要重启 dsh 服务。

## 说明

- 只读观察任意直播间是安全的，但**请只在自己的直播间发弹幕**，不要向别人的直播间发送。
- 在线人数来自 `getOnlineGoldRank` 的 `onlineNum`，是真实观看人数。B 站其他接口返回的 `online` 字段是人气值，可能是观看人数的几十倍，插件不用它。
- 弹幕服务器校验 WebSocket `Origin`，浏览器直连会被拒，所以由 Host 建立上游连接，页面只读同源 SSE，顺带把弹幕 token 留在了服务端。

## 许可证

MIT
