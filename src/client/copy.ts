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
  | 'credential'
  | 'credentialMissing'
  | 'credentialExpired'
  | 'credentialExpiredScanned'
  | 'credentialUnreadable'
  | 'credentialValid'
  | 'credentialUnknown'
  | 'credentialFromCustom'
  | 'credentialFromScanned'
  | 'credentialNoCsrf'
  | 'credentialExpiredTitle'
  | 'credentialExpiredBody'
  | 'credentialExpiredBodyRefs'
  | 'credentialExpiredBodyScanned'
  | 'credentialMissingTitle'
  | 'credentialMissingBody'
  | 'credentialMissingBodyRefs'
  | 'credentialUnreadableTitle'
  | 'credentialUnreadableBody'
  | 'credentialNoCsrfTitle'
  | 'credentialNoCsrfBody'
  | 'credentialNoticeTitle'
  | 'credentialNoticeBody'
  | 'qrLogin'
  | 'qrStarting'
  | 'qrWaiting'
  | 'qrScanned'
  | 'qrExpired'
  | 'qrFailed'
  | 'qrRefresh'
  | 'qrCode'
  | 'qrSignedInTitle'
  | 'qrSignedInBody'
  | 'qrSignedInAs'
  | 'confirm'
  | 'hostNotReady'
  | 'sendFailed'
  | 'refresh'
  | 'online'
  | 'manage'
  | 'rooms'
  | 'roomCount'
  | 'addRoom'
  | 'showWindow'
  | 'hideWindow'
  | 'removeRoom'
  | 'rename'
  | 'renameHint'
  | 'renameReset'
  | 'resizeHint'
  | 'offlineHint'
  | 'offlinePlaceholder'
  | 'viewDanmaku'
  | 'stateOffline'
  | 'stateOfflineViewing'
  | 'stateError'
  | 'stateLive'
  | 'stateHistory'
  | 'stateIdle'
  | 'noRooms'
  | 'recentRooms'
  | 'configuredRoom'
  | 'openRoom'
  | 'forgetRoom'
  | 'waitingNew'
  | 'minimizeWindow'
  | 'ungroupAll'
  | 'closeAll'

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
  hint: '可拖动标题栏移动，点右上角的最小化按钮收起为悬浮球。',
  reopen: '显示弹幕浮层',
  superchat: '醒目留言',
  enter: '进入',
  sendPlaceholder: '发弹幕…',
  send: '发送',
  sending: '发送中',
  sent: '已发送',
  noCredential: '未配置登录凭据，无法发言',
  credentialHint: '凭据缺少 bili_jct，无法发言',
  credential: '登录凭据',
  credentialMissing: '未配置',
  credentialExpired: '已失效，请更新',
  credentialExpiredScanned: '扫码登录已失效，请重新扫码',
  credentialUnreadable: '无法读取，请检查格式',
  credentialValid: '有效',
  credentialUnknown: '无法验证',
  credentialFromCustom: '来源：refs 凭据',
  credentialFromScanned: '来源：扫码登录',
  credentialNoCsrf: '缺少发言令牌',
  credentialExpiredTitle: '登录凭据失效',
  credentialExpiredBody:
    '您的哔哩哔哩账号登录态已过期，需要进行更新。你可以使用扫码登录重新授权，也可以手动更新凭据。',
  credentialExpiredBodyRefs:
    '您在 dsh refs 凭据中配置的 BILIBILI_SESSDATA 或 BILIBILI_JCT 已过期，需要进行更新。你可以使用扫码登录重新授权，也可以手动更新凭据。',
  credentialExpiredBodyScanned:
    '扫码登录获得的登录态已过期，需要重新授权。点击下方按钮重新扫码即可。',
  credentialMissingTitle: '未配置登录凭据',
  credentialMissingBody:
    '未找到可用的登录凭据，插件无法以您的账号发言或读取需要登录的内容。你可以使用扫码登录，也可以手动配置凭据。',
  credentialMissingBodyRefs:
    '在 dsh refs 凭据中未找到 BILIBILI_SESSDATA，插件无法以您的账号发言或读取需要登录的内容。你可以使用扫码登录，也可以手动配置凭据。',
  credentialUnreadableTitle: '无法读取登录凭据',
  credentialUnreadableBody:
    '凭据文件存在，但其中的登录凭据无法读取，请检查 dsh refs 凭据的格式与访问权限。',
  credentialNoCsrfTitle: '登录凭据缺少发言令牌',
  credentialNoCsrfBody:
    'dsh refs 凭据中的 BILIBILI_JCT 缺失，登录态可用但无法发送弹幕，请补充后重试。',
  credentialNoticeTitle: '登录凭据不可用',
  credentialNoticeBody: '登录凭据当前不可用，详情见悬浮球菜单中的登录凭据一行。',
  qrLogin: '扫码登录',
  qrStarting: '正在获取二维码…',
  qrWaiting: '请使用哔哩哔哩手机客户端扫码，剩余 ',
  qrScanned: '已扫码，请在手机上确认登录',
  qrExpired: '二维码已失效，请重新获取',
  qrFailed: '获取二维码失败，请稍后重试',
  qrRefresh: '重新获取',
  qrCode: '登录二维码',
  qrSignedInTitle: '登录成功',
  qrSignedInBody: '账号已登录。',
  qrSignedInAs: '已登录：',
  confirm: '确认',
  hostNotReady: '插件后端未就绪，请重启 dsh 服务',
  sendFailed: '发送失败',
  refresh: '刷新弹幕',
  online: '在线人数',
  manage: '管理直播间',
  rooms: '正在监控弹幕的直播间',
  /** Counted, so it carries no verb: "3 个直播间". */
  roomCount: '个直播间',
  addRoom: '添加',
  showWindow: '显示窗口',
  hideWindow: '收到悬浮窗',
  removeRoom: '退出监控',
  rename: '重命名',
  renameHint: '双击修改标题',
  renameReset: '恢复原标题',
  resizeHint: '拖动调整大小',
  offlineHint: '当前房间未开播',
  offlinePlaceholder: '当前房间未开播',
  viewDanmaku: '查看弹幕',
  stateOffline: '未开播',
  stateOfflineViewing: '未开播（正在查看弹幕）',
  stateError: '连接失败',
  stateLive: '已连接',
  stateHistory: '正在查看历史弹幕',
  stateIdle: '未连接',
  noRooms: '还没有监控中的直播间',
  recentRooms: '最近连接',
  configuredRoom: '默认直播间',
  openRoom: '打开',
  forgetRoom: '从最近连接移除',
  waitingNew: '等待新弹幕…',
  minimizeWindow: '最小化',
  ungroupAll: '全部收到悬浮窗',
  closeAll: '全部关闭',
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
  hint: 'Drag the title bar to move; the minimize button at the top right collapses it to a floating button.',
  reopen: 'Show danmaku overlay',
  superchat: 'Super chat',
  enter: 'entered',
  sendPlaceholder: 'Send a danmaku…',
  send: 'Send',
  sending: 'Sending',
  sent: 'Sent',
  noCredential: 'No login credential configured',
  credentialHint: 'Credential is missing bili_jct',
  credential: 'Login',
  credentialMissing: 'not configured',
  credentialExpired: 'expired, please update',
  credentialExpiredScanned: 'QR sign-in expired, scan again',
  credentialUnreadable: 'cannot read, check the format',
  credentialValid: 'valid',
  credentialUnknown: 'could not verify',
  credentialFromCustom: 'from refs credential',
  credentialFromScanned: 'from QR sign-in',
  credentialNoCsrf: 'missing send token',
  credentialExpiredTitle: 'Login credential expired',
  credentialExpiredBody:
    'The session for your Bilibili account has expired and has to be renewed. Sign in with a QR code to authorise again, or update the credential by hand.',
  credentialExpiredBodyRefs:
    'BILIBILI_SESSDATA or BILIBILI_JCT in the dsh refs credential has expired and has to be renewed. Sign in with a QR code to authorise again, or update the credential by hand.',
  credentialExpiredBodyScanned:
    'The session obtained by scanning a QR code has expired and has to be renewed. Scan a new code to authorise again.',
  credentialMissingTitle: 'No login credential',
  credentialMissingBody:
    'No usable login credential was found, so the plugin cannot post as your account or read anything that needs a login. Sign in with a QR code, or configure the credential by hand.',
  credentialMissingBodyRefs:
    'BILIBILI_SESSDATA is not present in the dsh refs credential, so the plugin cannot post as your account or read anything that needs a login. Sign in with a QR code, or configure the credential by hand.',
  credentialUnreadableTitle: 'Login credential cannot be read',
  credentialUnreadableBody:
    'The credential file exists, but the login inside it cannot be read. Check the shape and the permissions of the dsh refs credential.',
  credentialNoCsrfTitle: 'Login credential has no posting token',
  credentialNoCsrfBody:
    'BILIBILI_JCT is missing from the dsh refs credential. The session works, but nothing can be posted until it is added.',
  credentialNoticeTitle: 'Login credential is not usable',
  credentialNoticeBody:
    'The login credential is not usable right now. The credential row in the ball menu says why.',
  qrLogin: 'Scan QR code',
  qrStarting: 'Getting a code…',
  qrWaiting: 'Scan with the Bilibili mobile app. Time left: ',
  qrScanned: 'Scanned. Confirm the sign-in on your phone.',
  qrExpired: 'The code has expired. Get a new one.',
  qrFailed: 'Could not get a code. Try again in a moment.',
  qrRefresh: 'Get a new code',
  qrCode: 'Sign-in QR code',
  qrSignedInTitle: 'Signed in',
  qrSignedInBody: 'The account is signed in.',
  qrSignedInAs: 'Signed in as ',
  confirm: 'OK',
  hostNotReady: 'Plugin backend not ready, restart the dsh service',
  sendFailed: 'Send failed',
  refresh: 'Refresh danmaku',
  online: 'Viewers online',
  manage: 'Manage rooms',
  rooms: 'Monitored rooms',
  roomCount: 'rooms',
  addRoom: 'Add',
  showWindow: 'Show window',
  hideWindow: 'Put in the ball',
  removeRoom: 'Stop monitoring',
  rename: 'Rename',
  renameHint: 'Double-click to rename',
  renameReset: 'Use the room title',
  resizeHint: 'Drag to resize',
  offlineHint: 'This room is not live',
  offlinePlaceholder: 'This room is not live',
  viewDanmaku: 'View danmaku',
  stateOffline: 'Not live',
  stateOfflineViewing: 'Not live (viewing danmaku)',
  stateError: 'Connection failed',
  stateLive: 'Connected',
  stateHistory: 'Reading history danmaku',
  stateIdle: 'Not connected',
  noRooms: 'No rooms are being monitored',
  recentRooms: 'Recently connected',
  configuredRoom: 'Default room',
  openRoom: 'Open',
  forgetRoom: 'Remove from recently connected',
  waitingNew: 'Waiting for new danmaku…',
  minimizeWindow: 'Minimize',
  ungroupAll: 'Put all in the ball',
  closeAll: 'Close all',
}
