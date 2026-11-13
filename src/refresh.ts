/**
 * Renewing a session without asking the reader to scan again.
 *
 * The sequence
 *
 * Bilibili hands out a `refresh_token` when a login completes, and that token can be
 * exchanged for a fresh `SESSDATA` while the session is still alive. The exchange is four
 * calls and they are ordered: ask whether renewal is needed, derive a `CorrespondPath`,
 * read a `refresh_csrf` through it, post the exchange, then confirm it so the old token
 * stops working.
 *
 * The two traps
 *
 * `cookie/info` is an advisory check, not a gate: it reports what the server thinks about
 * renewal, and a `false` answer is not an error. Renewing anyway would rotate a token that
 * did not need rotating, which is why the check is consulted before anything is posted.
 *
 * The order of the exchange and the confirmation matters for recovery. A token that was
 * exchanged but not confirmed is still alive on the server side, so a crash between the
 * two leaves the new session valid and the old token merely unused. Confirming first would
 * leave the reader holding neither.
 *
 * Why the result is logged rather than thrown
 *
 * A renewal that fails is not a reason to discard a session that still works, and the
 * caller's next move is the same whether the token was refused or the network dropped:
 * keep using the current session and let the reader sign in when it does fail. The log is
 * what makes the difference recoverable afterwards.
 */

import { webcrypto } from 'node:crypto'

import { readLogin, writeLogin, type StoredLogin } from './store.ts'
import { recordRefreshEvent, type RefreshStep } from './refreshlog.ts'

/** The endpoint that reports whether renewal is needed. */
const INFO_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'

/** The endpoint a `refresh_csrf` is read through. */
const CORRESPOND_URL = 'https://www.bilibili.com/correspond/1'

/** The endpoint that exchanges a refresh token for a new session. */
const REFRESH_URL = 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh'

/** The endpoint that retires the token that was just exchanged. */
const CONFIRM_URL = 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh'

/** User agent sent to every endpoint in this flow. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * The public key `CorrespondPath` is encrypted to.
 *
 * It is the key Bilibili's own web client uses, published as a JWK in the API
 * documentation. RSA-OAEP with SHA-256 over the ASCII form of `refresh_<ms>`, then the
 * ciphertext as lowercase base16, is the whole of the derivation.
 */
const CORRESPOND_KEY: JsonWebKey = {
  kty: 'RSA',
  n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',
  e: 'AQAB',
}

/** What a renewal attempt concluded. */
export interface RefreshOutcome {
  /** Whether the stored session was replaced. */
  readonly renewed: boolean
  /** Whether the server said renewal was needed at all. */
  readonly needed: boolean
  /** A short sentence naming the result, for a caller that logs or displays it. */
  readonly note: string
}

/**
 * Work out the `CorrespondPath` for a moment in time.
 *
 * @param timestamp - milliseconds since the epoch, which the server compares against its
 * own clock, so a badly skewed clock fails here rather than later.
 * @returns the ciphertext as lowercase base16.
 */
async function correspondPath(timestamp: number): Promise<string> {
  const key = await webcrypto.subtle.importKey('jwk', CORRESPOND_KEY, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, [
    'encrypt',
  ])
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(`refresh_${timestamp}`)),
  )
  return [...ciphertext].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What one call answered, in the shape the log records. */
interface CallResult {
  readonly status: number
  readonly payload: { code?: number; message?: string; data?: Record<string, unknown> } | null
  /** The cookies the response set, as raw header values. */
  readonly cookies: readonly string[]
}

/**
 * Perform one request and parse whatever JSON it answered with.
 *
 * The `Set-Cookie` headers are copied out before the body is read, because the exchange
 * hands the new session over in them and a consumed body leaves no way back to them.
 *
 * @param url - the endpoint.
 * @param init - the request method, headers and body.
 * @param timeoutMs - budget for the call.
 * @returns the status, the parsed payload and the cookies.
 */
async function call(url: string, init: RequestInit, timeoutMs: number): Promise<CallResult> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const cookies = response.headers.getSetCookie?.() ?? []
  const payload = (await response.json().catch(() => null)) as CallResult['payload']
  return { status: response.status, payload, cookies }
}

/**
 * Renew the stored scanned login when Bilibili says it is due.
 *
 * Never throws. A refusal, a network failure and a session that needs no renewal all end
 * the same way for the caller: the stored login is what it was, and the log says why.
 *
 * @param timeoutMs - budget for each request in the flow.
 * @returns what the attempt concluded.
 */
export async function refreshLogin(timeoutMs = 10_000): Promise<RefreshOutcome> {
  const login = readLogin()
  if (login === null) return { renewed: false, needed: false, note: '没有扫码登录凭据' }
  if (login.refreshToken === undefined || login.refreshToken === '') {
    return { renewed: false, needed: false, note: '凭据中没有 refresh_token，无法续期' }
  }

  const cookie = login.biliJct === '' ? `SESSDATA=${login.sessdata}` : `SESSDATA=${login.sessdata}; bili_jct=${login.biliJct}`
  const headers = { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.bilibili.com/' }

  // The check is advisory, so a failure here is recorded and treated as "not due" rather
  // than as a reason to attempt an exchange that may not have been needed.
  let needs = false
  try {
    const info = await call(`${INFO_URL}?csrf=${encodeURIComponent(login.biliJct)}`, { headers }, timeoutMs)
    const data = info.payload?.data ?? {}
    needs = data.refresh === true
    recordEvent('check', info.status === 200 && needs ? 'ok' : 'skipped', info.status, info.payload?.code ?? null, `refresh=${String(data.refresh)}`, needs ? '服务端报告需要续期' : '服务端报告暂不需要续期')
    if (!needs) return { renewed: false, needed: false, note: '暂不需要续期' }
  } catch (error) {
    recordEvent('check', 'failed', 0, null, '', error instanceof Error ? error.message : '检查续期需求失败')
    return { renewed: false, needed: false, note: '检查续期需求失败' }
  }

  let path: string
  try {
    path = await correspondPath(Date.now())
  } catch (error) {
    recordEvent('correspond', 'failed', 0, null, '', error instanceof Error ? error.message : '生成 CorrespondPath 失败')
    return { renewed: false, needed: true, note: '生成 CorrespondPath 失败' }
  }

  let refreshCsrf = ''
  try {
    const response = await fetch(`${CORRESPOND_URL}/${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    const html = await response.text()
    // The token sits in the text of `div id="1-name"` on an SSR page, so the surrounding
    // markup is still present and has to be cut away.
    refreshCsrf = html.match(/id="1-name"[^>]*>([0-9a-fA-F]{32})</)?.[1] ?? ''
    recordEvent('correspond', response.status === 200 && refreshCsrf !== '' ? 'ok' : 'failed', response.status, null, refreshCsrf === '' ? '未取到 refresh_csrf' : '已取到 refresh_csrf', refreshCsrf === '' ? '读取 refresh_csrf 失败' : '已取得 refresh_csrf')
  } catch (error) {
    recordEvent('correspond', 'failed', 0, null, '', error instanceof Error ? error.message : '请求 CorrespondPath 失败')
    return { renewed: false, needed: true, note: '请求 CorrespondPath 失败' }
  }
  if (refreshCsrf === '') return { renewed: false, needed: true, note: '读取 refresh_csrf 失败' }

  // The exchange is the first step with a side effect: a success rotates the session.
  let exchanged: CallResult
  try {
    const body = new URLSearchParams({
      csrf: login.biliJct,
      refresh_csrf: refreshCsrf,
      source: 'main_web',
      refresh_token: login.refreshToken,
    })
    exchanged = await call(
      REFRESH_URL,
      { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      timeoutMs,
    )
  } catch (error) {
    recordEvent('refresh', 'failed', 0, null, '', error instanceof Error ? error.message : '请求续期失败')
    return { renewed: false, needed: true, note: '请求续期失败' }
  }

  const code = exchanged.payload?.code ?? null
  if (code !== 0) {
    recordEvent('refresh', 'failed', exchanged.status, code, String(exchanged.payload?.message ?? ''), '服务端拒绝续期')
    return { renewed: false, needed: true, note: `续期被拒绝（${String(code)}）` }
  }

  const url = typeof exchanged.payload?.data?.url === 'string' ? exchanged.payload.data.url : ''
  const nextToken = typeof exchanged.payload?.data?.refresh_token === 'string' ? exchanged.payload.data.refresh_token : ''
  const sessdata = readExchangedCookie(exchanged, url, 'SESSDATA')
  const biliJct = readExchangedCookie(exchanged, url, 'bili_jct')
  if (sessdata === '') {
    recordEvent('refresh', 'failed', exchanged.status, code, '响应中没有 SESSDATA', '续期响应缺少会话凭据')
    return { renewed: false, needed: true, note: '续期响应缺少会话凭据' }
  }

  // The new session is written before the old token is retired, so a crash in between
  // leaves a working session rather than a token that is no longer exchangeable.
  const next: StoredLogin = {
    sessdata,
    biliJct: biliJct === '' ? login.biliJct : biliJct,
    dedeUserId: login.dedeUserId,
    uname: login.uname,
    refreshToken: nextToken === '' ? login.refreshToken : nextToken,
    loggedInAt: login.loggedInAt,
  }
  try {
    writeLogin(next)
    recordEvent('store', 'ok', 0, null, `sessdata=${String(sessdata.length)}`, '新凭据已写入')
  } catch (error) {
    recordEvent('store', 'failed', 0, null, '', error instanceof Error ? error.message : '写入新凭据失败')
    return { renewed: false, needed: true, note: '写入新凭据失败' }
  }

  // The confirmation retires the token that was just spent. It uses the csrf from the new
  // cookie, and the old refresh token. A failure here is recorded and otherwise ignored:
  // the session works, and the only cost is a token that stays usable on the server.
  try {
    const body = new URLSearchParams({ csrf: next.biliJct, refresh_token: login.refreshToken })
    const confirmed = await call(
      CONFIRM_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Cookie: `SESSDATA=${next.sessdata}; bili_jct=${next.biliJct}`, Referer: 'https://www.bilibili.com/' },
        body,
      },
      timeoutMs,
    )
    const confirmCode = confirmed.payload?.code ?? null
    recordEvent('confirm', confirmCode === 0 ? 'ok' : 'failed', confirmed.status, confirmCode, String(confirmed.payload?.message ?? ''), confirmCode === 0 ? '旧 refresh_token 已失效' : '确认失败，旧 refresh_token 仍然有效')
  } catch (error) {
    recordEvent('confirm', 'failed', 0, null, '', error instanceof Error ? error.message : '确认续期失败')
  }

  return { renewed: true, needed: true, note: '续期成功' }
}

/**
 * Read one cookie the exchange handed back.
 *
 * The exchange answers with `Set-Cookie` headers and, for some clients, a redirect URL.
 * The header is authoritative because it is the only one that carries `sid`, so it is
 * tried first and the URL only fills in what the header left out.
 *
 * @param exchanged - the exchange result.
 * @param url - the redirect the payload reported.
 * @param name - the cookie to read.
 * @returns the cookie value, or an empty string when absent.
 */
function readExchangedCookie(exchanged: CallResult, url: string, name: string): string {
  for (const header of exchanged.cookies) {
    const match = header.match(new RegExp(`^\\s*${name}=([^;]*)`))
    if (match !== null && match[1] !== undefined && match[1].trim() !== '') return match[1].trim()
  }
  if (url === '') return ''
  try {
    return new URL(url).searchParams.get(name) ?? ''
  } catch {
    return ''
  }
}

/**
 * Record one step's outcome.
 *
 * @param step - which step.
 * @param outcome - its verdict.
 * @param status - HTTP status, or 0 when no response arrived.
 * @param code - the payload's outer code, or null.
 * @param detail - a short machine readable detail.
 * @param note - a sentence naming what the step concluded.
 */
function recordEvent(
  step: RefreshStep,
  outcome: 'ok' | 'failed' | 'skipped',
  status: number,
  code: number | null,
  detail: string,
  note: string,
): void {
  recordRefreshEvent({ at: new Date().toISOString(), step, outcome, status, code, detail, note })
}
