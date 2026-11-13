/**
 * The Bilibili QR sign-in flow, Host side.
 *
 * The shape of it
 *
 * Ask for a key, draw the URL as a QR code, then poll the same key until it reports
 * success, refusal or expiry. Nothing is written to Bilibili and nothing is sent to a
 * room; the flow ends by handing a set of cookies to `store.ts`.
 *
 * Two traps the protocol sets
 *
 * The poll response carries an outer `code` that is always `0`, and the real verdict
 * in `data.code`. A reader that checks the outer field reports "success" from the very
 * first poll. The other trap is the encoding of `SESSDATA`: the cookie value itself
 * contains a literal `%2C`, and the URL returned at login encodes it a second time as
 * `%252C`, so exactly one decode is correct and both zero and two produce a value
 * Bilibili rejects. `searchParams.get` performs that one decode.
 *
 * Why the key is held in a session
 *
 * A key is good for about 180 seconds and a second scan must not interleave with the
 * first, so one session is kept per process and a new scan replaces it. That also
 * gives the poller a single place to write a result into.
 */

// The two deep imports are deliberate. The package entry pulls in a PNG encoder and a
// command line parser for its CLI, and this Host only ever draws an SVG, so taking the
// core and the SVG renderer directly keeps both out of the bundle.
import { create as createQr } from 'qrcode/lib/core/qrcode.js'
import { render as renderQrSvg } from 'qrcode/lib/renderer/svg-tag.js'

import { BiliError } from './credentials.ts'
import { writeLogin, type StoredLogin } from './store.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The file the poll trace is appended to.
 *
 * It sits beside the credential rather than beside the plugin, because both describe a
 * sign-in attempt and the directory already carries the right permissions. Each line is
 * one poll as JSON, so a half-written line at the end of a crash costs one record rather
 * than the whole file.
 */
const TRACE_FILE = join(homedir(), '.dsh', 'bili-danmaku-overlay', 'qr-trace.log')

/**
 * Append a diagnostic record for one poll.
 *
 * Written as one JSON line per poll and appended rather than rewritten, so the history
 * of a whole attempt survives even though the in-memory list is bounded. A failure to
 * write must not fail the sign-in: the trace exists to explain a failure, and turning
 * it into one would be the wrong trade.
 *
 * @param record - the attempt and the polls recorded so far.
 */
function writeTraceFile(record: {
  key: string
  url: string
  expiresInMs: number
  trace: readonly QrTraceEntry[]
}): void {
  try {
    mkdirSync(join(homedir(), '.dsh', 'bili-danmaku-overlay'), { recursive: true, mode: 0o700 })
    const last = record.trace[record.trace.length - 1]
    if (last === undefined) return
    appendFileSync(TRACE_FILE, `${JSON.stringify({ key: record.key, url: record.url, ...last })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    // A trace that cannot be written is a smaller problem than a sign-in that fails
    // over it, and the in-memory copy is still queryable.
  }
}

/** The endpoint that issues a key. */
const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'

/** The endpoint that reports a key's state. */
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'

/** User agent sent to the passport endpoints. */
const PASSPORT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** How long one key is polled before the session gives up, in milliseconds. */
const SESSION_TTL_MS = 180_000

/**
 * One sign-in attempt.
 *
 * `key` is the opaque value from Bilibili, `svg` is the drawn code and `url` is what
 * the code encodes. The deadline is computed once at creation so a poll cannot extend
 * the window by much: a key that outlives its issue by more than the protocol allows
 * is refused by Bilibili anyway, and extending it would only hide that.
 *
 * `trace` records what each poll actually answered, because a failure on the phone is
 * otherwise invisible from this side: the code is drawn, the reader scans, and the app
 * reports a refusal while every request the Host makes still says `86101`. The trace is
 * bounded so a page left polling cannot grow it without limit.
 */
interface QrSession {
  readonly key: string
  readonly url: string
  readonly svg: string
  readonly expiresAt: number
  readonly trace: QrTraceEntry[]
}

/** One recorded poll, kept for the diagnostic route. */
export interface QrTraceEntry {
  /** When the poll was sent, as an ISO timestamp. */
  readonly at: string
  /** The HTTP status, or 0 when the request never completed. */
  readonly status: number
  /** The outer `code`, which the protocol always sets to 0. */
  readonly outerCode: number | null
  /** The real verdict from `data.code`. */
  readonly innerCode: number | null
  /** `data.message` when the response carried one. */
  readonly message: string | null
  /** True when the response carried a `SESSDATA` cookie or a login URL. */
  readonly carriedCredential: boolean
}

/** How many polls the trace keeps before discarding the oldest. */
const TRACE_LIMIT = 40

/** The session currently being polled, or null when nothing is in progress. */
let session: QrSession | null = null

/** What the page draws for one sign-in attempt. */
export interface QrStart {
  /** The code as an inline SVG document. */
  readonly svg: string
  /** How long the code stays valid, in milliseconds. */
  readonly expiresInMs: number
}

/** What one poll reports. */
export interface QrPoll {
  /** Where the attempt stands. */
  readonly state: 'waiting' | 'scanned' | 'done' | 'expired' | 'error'
  /** The account name, present once the login was confirmed. */
  readonly uname?: string
  /** A human readable note for the states that carry no account name. */
  readonly message?: string
}

/**
 * Ask Bilibili for a key and draw it.
 *
 * A key that cannot be obtained is reported as a failure rather than retried here: the
 * page is an interactive surface, so it is better placed to say "try again" than this
 * function is to spend an unbounded number of requests guessing.
 *
 * @param timeoutMs - request budget for the key request.
 * @returns the drawn code and its lifetime.
 * @throws {BiliError} when the key cannot be obtained or drawn.
 */
export async function startQrLogin(timeoutMs: number): Promise<QrStart> {
  let payload: { code?: number; data?: { url?: string; qrcode_key?: string } } | null
  try {
    const response = await fetch(GENERATE_URL, {
      headers: { 'User-Agent': PASSPORT_UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    payload = (await response.json().catch(() => null)) as typeof payload
  } catch {
    throw new BiliError('无法连接 Bilibili 登录服务，请稍后重试', 'qr-generate')
  }
  const url = payload?.data?.url ?? ''
  const key = payload?.data?.qrcode_key ?? ''
  if (payload?.code !== 0 || url === '' || key === '') {
    throw new BiliError('无法获取登录二维码，请稍后重试', 'qr-generate')
  }

  // No `width` is passed, so the renderer emits only a `viewBox`. A fixed pixel size
  // would win over the container and crop the code, which is unrecoverable: a QR code
  // missing a finder pattern cannot be scanned at all.
  //
  // The margin is four modules, which is the quiet zone the specification asks for. A
  // tighter one still draws, but a scanner looking at a dimmed page from arm's length
  // needs the surrounding light band to find the code's edges.
  const markup = renderQrSvg(createQr(url, { errorCorrectionLevel: 'M' }), {
    margin: 4,
    type: 'svg',
  })
  // The explicit `width` and `height` here are percentages, not pixels. An inline SVG
  // without either attribute falls back to a 300 by 150 default replaced element box,
  // which would squash a square code into a rectangle and put it out of the parent's
  // reach. Percentages make the drawing follow the square the surface gives it.
  const svg = markup.replace(
    '<svg ',
    '<svg width="100%" height="100%" preserveAspectRatio="xMidYMid meet" ',
  )
  session = {
    key,
    url,
    svg,
    expiresAt: Date.now() + SESSION_TTL_MS,
    trace: [],
  }
  return { svg, expiresInMs: SESSION_TTL_MS }
}

/**
 * Poll the current attempt once.
 *
 * The caller drives the cadence, because the interval belongs to the page's own timer.
 * Polling again after `done` or `expired` answers from the stored outcome instead of
 * asking again, so a page that polls one time too many cannot turn a success into an
 * error.
 *
 * @param timeoutMs - request budget for this poll.
 * @returns where the attempt stands now.
 */
export async function pollQrLogin(timeoutMs: number): Promise<QrPoll> {
  const current = session
  if (current === null) return { state: 'error', message: '扫码会话已结束，请重新获取二维码' }
  if (Date.now() > current.expiresAt) {
    session = null
    return { state: 'expired' }
  }

  const target = `${POLL_URL}?qrcode_key=${encodeURIComponent(current.key)}`
  // The cookies arrive on the response headers, so the headers are needed as well as
  // the body. `getSetCookie` is the only way to read more than one from `fetch`.
  let response: Response
  try {
    response = await fetch(target, {
      headers: { 'User-Agent': PASSPORT_UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    recordTrace(current, { at: new Date().toISOString(), status: 0, outerCode: null, innerCode: null, message: null, carriedCredential: false })
    return { state: 'error', message: '轮询登录状态失败，请稍后重试' }
  }

  const payload = (await response.json().catch(() => null)) as {
    code?: number
    data?: { code?: number; message?: string; url?: string; refresh_token?: string; timestamp?: number }
  } | null
  const inner = payload?.data?.code
  const cookies = readCookies(response, payload?.data?.url ?? '')
  recordTrace(current, {
    at: new Date().toISOString(),
    status: response.status,
    outerCode: typeof payload?.code === 'number' ? payload.code : null,
    innerCode: typeof inner === 'number' ? inner : null,
    message: payload?.data?.message ?? null,
    carriedCredential: cookies.sessdata !== '',
  })
  if (typeof inner !== 'number') {
    return { state: 'error', message: '无法解析登录状态，请稍后重试' }
  }

  if (inner === 86101) return { state: 'waiting' }
  if (inner === 86090) return { state: 'scanned' }
  if (inner === 86038) {
    // An unknown key and an expired one answer identically, so the wording names
    // neither: claiming expiry would mislabel a key that was simply mistyped.
    session = null
    return { state: 'expired' }
  }
  if (inner !== 0) {
    return { state: 'error', message: payload?.data?.message ?? `登录状态异常（${inner}）` }
  }

  if (cookies.sessdata === '') {
    return { state: 'error', message: '登录成功但未取得会话凭据，请重试' }
  }

  const uname = await confirmAccount(cookies.sessdata, timeoutMs)
  const login: StoredLogin = {
    sessdata: cookies.sessdata,
    biliJct: cookies.biliJct,
    dedeUserId: cookies.dedeUserId === '' ? undefined : cookies.dedeUserId,
    uname,
    refreshToken: payload?.data?.refresh_token === '' ? undefined : payload?.data?.refresh_token,
    loggedInAt: new Date().toISOString(),
  }
  writeLogin(login)
  session = null
  return uname === undefined ? { state: 'done' } : { state: 'done', uname }
}

/**
 * Append one poll's outcome to the session trace, and to disk.
 *
 * The list is bounded because a page that polls a dead key for three minutes would
 * otherwise grow it once every two seconds, and the point of the trace is the last
 * handful of answers rather than a full log.
 *
 * It is also written to a file on every poll. A scan that the phone refuses cannot be
 * reported while it happens, because the reader is holding a phone rather than a
 * keyboard, so the evidence has to survive the attempt. A file is read afterwards
 * instead of memory being queried during it.
 *
 * @param current - the session the poll belongs to.
 * @param entry - what this poll answered.
 */
function recordTrace(current: QrSession, entry: QrTraceEntry): void {
  current.trace.push(entry)
  if (current.trace.length > TRACE_LIMIT) current.trace.shift()
  writeTraceFile({
    key: current.key,
    url: current.url,
    expiresInMs: Math.max(0, current.expiresAt - Date.now()),
    trace: current.trace,
  })
}

/** The state of the current sign-in attempt, for diagnosing a refused scan. */
export interface QrDiagnostics {
  /** True while a key is held. */
  readonly active: boolean
  /** The key itself, which the reader can compare against the app if needed. */
  readonly key: string | null
  /** The URL the drawn code encodes. */
  readonly url: string | null
  /** Milliseconds left before the key is abandoned, or 0 when no key is held. */
  readonly expiresInMs: number
  /** What each poll answered, oldest first. */
  readonly trace: readonly QrTraceEntry[]
}

/**
 * Report the current attempt without changing it.
 *
 * A scan that the phone refuses produces no request this side can see fail, so the only
 * evidence is what the poll endpoint keeps answering while the app says otherwise. This
 * exposes that evidence rather than adding an inference on top of it.
 *
 * @returns the live attempt, or an inactive report when none is in progress.
 */
export function qrDiagnostics(): QrDiagnostics {
  if (session === null) {
    return { active: false, key: null, url: null, expiresInMs: 0, trace: [] }
  }
  return {
    active: true,
    key: session.key,
    url: session.url,
    expiresInMs: Math.max(0, session.expiresAt - Date.now()),
    trace: session.trace,
  }
}

/** The cookie values a completed login hands over. */
interface LoginCookies {
  readonly sessdata: string
  readonly biliJct: string
  readonly dedeUserId: string
}

/**
 * Collect the cookies from a completed login.
 *
 * Both sources are read because neither carries everything: the response headers hold
 * `sid` and the URL does not, while the URL is present even when a proxy rewrote the
 * headers. The header value wins where the two overlap, since that is what the browser
 * would have stored.
 *
 * @param response - the poll response.
 * @param url - the `data.url` value, which carries the cookies as query parameters.
 * @returns the cookie values, with empty strings where one was absent.
 */
function readCookies(response: Response, url: string): LoginCookies {
  const fromHeaders = new Map<string, string>()
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    fromHeaders.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }

  let params: URLSearchParams | null = null
  if (url !== '') {
    try {
      params = new URL(url).searchParams
    } catch {
      params = null
    }
  }
  const read = (name: string): string => {
    const fromHeader = fromHeaders.get(name)
    if (fromHeader !== undefined && fromHeader !== '') return fromHeader
    // `searchParams.get` performs exactly the one decode the value needs. Running
    // `decodeURIComponent` on the result would take it a step too far and produce a
    // token Bilibili rejects.
    return params?.get(name) ?? ''
  }
  return { sessdata: read('SESSDATA'), biliJct: read('bili_jct'), dedeUserId: read('DedeUserID') }
}

/**
 * Ask Bilibili who the fresh session belongs to.
 *
 * The account name is what makes the finished state meaningful to a reader, and the
 * same call is what separates "the login worked" from "the login was accepted but the
 * token is already unusable". A failure here does not undo the login: the cookies were
 * issued, so the record is kept and the name is simply absent.
 *
 * @param sessdata - the session cookie just obtained.
 * @param timeoutMs - request budget.
 * @returns the account name, or undefined when it could not be confirmed.
 */
async function confirmAccount(sessdata: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': PASSPORT_UA,
        Referer: 'https://www.bilibili.com/',
        Cookie: `SESSDATA=${sessdata}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = (await response.json().catch(() => null)) as {
      code?: number
      data?: { isLogin?: boolean; uname?: string }
    } | null
    if (payload?.code !== 0 || payload.data?.isLogin !== true) return undefined
    const uname = String(payload.data.uname ?? '').trim()
    return uname === '' ? undefined : uname
  } catch {
    return undefined
  }
}
