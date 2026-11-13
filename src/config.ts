/**
 * Validated configuration for the Bilibili danmaku overlay.
 *
 * ── Why there are no credential fields ────────────────────────────────────
 *
 * `SESSDATA` and `bili_jct` are secrets, and this plugin does not own them. They
 * belong to the Harness credential document (`~/.dsh/.credentials.yaml`) and are
 * read from there at request time. Keeping them out of this schema means a
 * settings export, a screenshot of the settings page, or a profile patch can
 * never carry a login token, and the user has exactly one place to rotate it.
 *
 * ── Why every field is volatile ───────────────────────────────────────────
 *
 * `SettingsForms` projects this schema into the plugin settings page and treats
 * a `.volatile()` field as editable without remounting the plugin. The values
 * are therefore read through `.get()` at the point of use: a saved page size or
 * poll interval applies to the next request instead of the next restart.
 */

import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Rows retained in the overlay list; older danmaku scroll out of memory. */
export const DEFAULT_HISTORY_LIMIT = 200

/** Items the history endpoint returns per request. */
export const DEFAULT_HISTORY_FETCH = 50

/**
 * Default floor for the history poll interval, in milliseconds.
 *
 * Measurement put the endpoint's comfortable rate at ten requests a second: 300
 * sequential calls at this spacing answered in a flat ~15ms with no failures, so
 * 100ms is used as the floor and never pushed below.
 */
export const DEFAULT_POLL_MIN_MS = 100

/** Audience-count poll interval, in milliseconds. */
export const DEFAULT_STATS_INTERVAL_MS = 60_000

/** Upstream comet heartbeat interval, in milliseconds. */
export const DEFAULT_HEARTBEAT_MS = 30_000

/** Keep-alive comment interval for the server-sent event stream. */
export const DEFAULT_KEEPALIVE_MS = 15_000

/** Request timeout for outbound Bilibili calls, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 12_000

/** Hard ceiling for one outgoing danmaku, in characters. Enforced by Bilibili. */
export const MAX_DANMAKU_CHARS = 20

/** Environment fallbacks, in the order the credential reader tries them. */
export const SESSDATA_REF = 'BILIBILI_SESSDATA'

/** Companion ref holding the csrf token Bilibili requires for a send. */
export const CSRF_REF = 'BILIBILI_JCT'

/**
 * Live configuration handed to `apply`.
 *
 * Cordis validates the schema before `apply` runs, so every field arrives
 * parsed. `Volatile<T>` is a live reference rather than a plain value, which is
 * why the accessors below exist instead of reading the field directly.
 */
export interface Config {
  /** Room id the overlay opens with; empty means the user types one. */
  defaultRoom: Volatile<string>
  /** Whether the overlay connects to `defaultRoom` on its own. */
  autoConnect: Volatile<boolean>
  /** Rows kept in the overlay list. */
  historyLimit: Volatile<number>
  /** Items requested from the history endpoint. */
  historyFetch: Volatile<number>
  pollMinMs: Volatile<number>
  /** Audience poll interval, in milliseconds. */
  statsIntervalMs: Volatile<number>
  /** Upstream comet heartbeat interval, in milliseconds. */
  heartbeatMs: Volatile<number>
  /** Whether `进入了直播间` notices are rendered. */
  showEnterMessages: Volatile<boolean>
  /** Whether super chat messages are rendered. */
  showSuperChat: Volatile<boolean>
  /** Request timeout for outbound Bilibili calls, in milliseconds. */
  requestTimeoutMs: Volatile<number>
  /**
   * Whether a stale login raises a notice as soon as the page loads.
   *
   * The check itself is a real upstream call, so a reader on a metered connection
   * or one who opens dsh for something unrelated may want it to stop happening on
   * its own. The credential row still reports the verdict when asked.
   */
  checkCredentialOnLoad: Volatile<boolean>
}

/**
 * The schema the Harness projects into the plugin settings page.
 *
 * Bounds are deliberate rather than decorative: a five-figure history limit
 * would make every append a full re-render, and a sub-second poll would turn a
 * third-party endpoint into a rate-limit generator. `defaultRoom` is matched
 * against Bilibili's own id shape so a pasted URL fails in the form instead of
 * at the first request.
 */
export const Config = Schema.object({
  defaultRoom: Schema.string()
    .default('')
    .volatile()
    .description('Room id to open the overlay with. Leave empty to type one each time.')
    .i18n({ zh: '浮层默认打开的直播间号，留空则每次手动输入。' }),
  autoConnect: Schema.boolean()
    .default(false)
    .volatile()
    .description('Connect to the default room as soon as the page loads.')
    .i18n({ zh: '页面加载后自动连接默认直播间。' }),
  historyLimit: Schema.natural()
    .min(20)
    .max(2000)
    .default(DEFAULT_HISTORY_LIMIT)
    .volatile()
    .description('Danmaku rows kept in the overlay before the oldest scroll away.')
    .i18n({ zh: '浮层最多保留的弹幕条数。' }),
  historyFetch: Schema.natural()
    .min(10)
    .max(200)
    .default(DEFAULT_HISTORY_FETCH)
    .volatile()
    .description('Items fetched from the history endpoint on connect and on refresh.')
    .i18n({ zh: '连接和刷新时从历史接口拉取的条数。' }),
  pollMinMs: Schema.natural()
    .min(100)
    .max(10_000)
    .step(100)
    .default(DEFAULT_POLL_MIN_MS)
    .volatile()
    .description('Fastest history poll interval in milliseconds; the poller backs off above it on errors.')
    .i18n({ zh: '历史轮询的最快间隔（毫秒），出错时会自动退避到更慢。' }),
  statsIntervalMs: Schema.natural()
    .min(10_000)
    .max(600_000)
    .step(1000)
    .default(DEFAULT_STATS_INTERVAL_MS)
    .volatile()
    .description('How often the viewer count is refreshed, in milliseconds.')
    .i18n({ zh: '在线人数刷新间隔（毫秒）。' }),
  heartbeatMs: Schema.natural()
    .min(10_000)
    .max(120_000)
    .step(1000)
    .default(DEFAULT_HEARTBEAT_MS)
    .volatile()
    .description('Heartbeat interval for the upstream danmaku socket, in milliseconds.')
    .i18n({ zh: '弹幕服务器心跳间隔（毫秒）。' }),
  showEnterMessages: Schema.boolean()
    .default(true)
    .volatile()
    .description('Show “entered the room” notices in the overlay.')
    .i18n({ zh: '在浮层显示“进入直播间”消息。' }),
  showSuperChat: Schema.boolean()
    .default(true)
    .volatile()
    .description('Show super chat messages in the overlay.')
    .i18n({ zh: '在浮层显示醒目留言。' }),
  requestTimeoutMs: Schema.natural()
    .min(3000)
    .max(60_000)
    .step(1000)
    .default(DEFAULT_REQUEST_TIMEOUT_MS)
    .volatile()
    .description('Timeout for one Bilibili API request, in milliseconds.')
    .i18n({ zh: '请求 Bilibili 接口的超时时间（毫秒）。' }),
  checkCredentialOnLoad: Schema.boolean()
    .default(true)
    .volatile()
    .description('Check the stored login when the page loads and raise a notice when it is unusable.')
    .i18n({ zh: '自动检查登录凭据有效性。页面加载时检查，凭据不可用时弹窗说明。' }),
})

/**
 * Read a live configuration value, falling back when the Host supplied nothing.
 *
 * A plugin mounted before a field existed, or a hand-edited profile patch, can
 * hand `undefined` here; the caller then gets the documented default instead of
 * failing on the first request.
 *
 * `Volatile<T>.get()` returns a `VolatileSnapshot<T>` — the same shape with every
 * property made readonly — so the cast only restores mutability. No field in this
 * schema is an object, so nothing observable is lost.
 *
 * @param field - one live schema field, possibly absent.
 * @param fallback - value to use when the field is absent.
 * @returns the live value, or the fallback.
 */
export function readField<T>(field: Volatile<T> | undefined, fallback: T): T {
  const value = field?.get()
  return (value === undefined ? fallback : value) as T
}

/**
 * Read a live numeric value as a usable positive integer.
 *
 * @param field - one live numeric schema field, possibly absent.
 * @param fallback - value to use when the field is absent or unusable.
 * @returns a positive integer.
 */
export function readNumber(field: Volatile<number> | undefined, fallback: number): number {
  const value = readField(field, fallback)
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

/** Values resolved once per request, so one request sees one consistent view. */
export interface Limits {
  /** Rows kept in the overlay list. */
  readonly historyLimit: number
  /** Items requested from the history endpoint. */
  readonly historyFetch: number
  readonly pollMinMs: number
  /** Upstream heartbeat interval, in milliseconds. */
  readonly heartbeatMs: number
  /** Request timeout, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Whether enter-room notices are rendered. */
  readonly showEnterMessages: boolean
  /** Whether super chat messages are rendered. */
  readonly showSuperChat: boolean
  /**
   * Whether the page checks the stored login when it loads.
   *
   * Turning this off leaves the credential row in the ball menu working on demand,
   * so a reader who does not want a notice on every load still has a way to ask.
   */
  readonly checkCredentialOnLoad: boolean
}

/**
 * Snapshot the live configuration for one request.
 *
 * @param config - the live plugin configuration, possibly undefined.
 * @returns the limits this request runs under.
 */
export function readLimits(config: Partial<Config> | undefined): Limits {
  return {
    historyLimit: readNumber(config?.historyLimit, DEFAULT_HISTORY_LIMIT),
    historyFetch: readNumber(config?.historyFetch, DEFAULT_HISTORY_FETCH),
    pollMinMs: readNumber(config?.pollMinMs, DEFAULT_POLL_MIN_MS),
    heartbeatMs: readNumber(config?.heartbeatMs, DEFAULT_HEARTBEAT_MS),
    requestTimeoutMs: readNumber(config?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    showEnterMessages: readField(config?.showEnterMessages, true),
    showSuperChat: readField(config?.showSuperChat, true),
    checkCredentialOnLoad: readField(config?.checkCredentialOnLoad, true),
  }
}
