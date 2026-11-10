/**
 * Overlay copy.
 *
 * Kept apart from the component so the two dictionaries sit next to each other
 * and a missing key is obvious. Keys are added to both at once; the overlay calls
 * `t()` with the literal union below, so TypeScript rejects an unknown key.
 */

/** Every key the overlay renders. */
export type CopyKey =
  | 'title'
  | 'roomPlaceholder'
  | 'connect'
  | 'disconnect'
  | 'collapse'
  | 'expand'
  | 'clear'
  | 'close'
  | 'live'
  | 'offline'
  | 'connecting'
  | 'reconnecting'
  | 'error'
  | 'idle'
  | 'empty'
  | 'hint'
  | 'reopen'
  | 'superchat'
  | 'enter'
  | 'sendPlaceholder'
  | 'send'
  | 'sending'
  | 'sent'
  | 'noCredential'
  | 'credentialHint'
  | 'hostNotReady'
  | 'sendFailed'
  | 'refresh'
  | 'online'

/** One complete dictionary. */
export type Dictionary = Readonly<Record<CopyKey, string>>

/** Chinese copy. */
export const zh: Dictionary = {
  title: '直播弹幕',
  roomPlaceholder: '直播间号',
  connect: '连接',
  disconnect: '断开',
  collapse: '收起',
  expand: '展开',
  clear: '清空',
  close: '关闭',
  live: '直播中',
  offline: '未开播',
  connecting: '连接中',
  reconnecting: '重连中',
  error: '连接异常',
  idle: '未连接',
  empty: '暂无弹幕，连接直播间后实时显示。',
  hint: '可拖动标题栏移动，点右上角 − 收起为悬浮球。',
  reopen: '显示弹幕浮层',
  superchat: '醒目留言',
  enter: '进入',
  sendPlaceholder: '发弹幕…',
  send: '发送',
  sending: '发送中',
  sent: '已发送',
  noCredential: '未配置登录凭据，无法发言',
  credentialHint: '凭据缺少 bili_jct，无法发言',
  hostNotReady: '插件后端未就绪，请重启 dsh 服务',
  sendFailed: '发送失败',
  refresh: '刷新弹幕',
  online: '在线人数',
}

/** English copy. */
export const en: Dictionary = {
  title: 'Live danmaku',
  roomPlaceholder: 'Room ID',
  connect: 'Connect',
  disconnect: 'Disconnect',
  collapse: 'Collapse',
  expand: 'Expand',
  clear: 'Clear',
  close: 'Close',
  live: 'Live',
  offline: 'Offline',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  error: 'Error',
  idle: 'Idle',
  empty: 'No danmaku yet. Connect a live room to stream it here.',
  hint: 'Drag the title bar to move; − collapses to a floating button.',
  reopen: 'Show danmaku overlay',
  superchat: 'Super chat',
  enter: 'entered',
  sendPlaceholder: 'Send a danmaku…',
  send: 'Send',
  sending: 'Sending',
  sent: 'Sent',
  noCredential: 'No login credential configured',
  credentialHint: 'Credential is missing bili_jct',
  hostNotReady: 'Plugin backend not ready, restart the dsh service',
  sendFailed: 'Send failed',
  refresh: 'Refresh danmaku',
  online: 'Viewers online',
}
