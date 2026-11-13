/**
 * Credential access for the Host half.
 *
 * ── Where the secrets live ─────────────────────────────────────────────────
 *
 * The plugin stores nothing. `SESSDATA` and `bili_jct` are read from the Harness
 * credential document (`~/.dsh/.credentials.yaml`, `refs` section) which the user
 * manages themselves through the Harness. This module only reads; there is no
 * write path, no cache on disk, and no route that returns a token value.
 *
 * ── Why the document is scanned rather than parsed ─────────────────────────
 *
 * The file can hold unrelated credentials. A whole-document YAML parse would pull
 * every other secret into memory and make an accidental log or crash dump far
 * more damaging. A line scan extracts the one requested key and discards the
 * rest, so the other refs never exist as objects in this process.
 *
 * ── What crosses the wire ──────────────────────────────────────────────────
 *
 * `credentialStatus()` reports whether a session and a csrf token are present,
 * and whether Bilibili still accepts them, never a prefix, a length, or a hash of
 * either. The account name is included once the session is confirmed, because the
 * page shows it as the evidence that the login works; nothing else about the token
 * is sent. The page needs to know if it may offer a send box and who it would send
 * as, and nothing more.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { refreshLogin } from './refresh.ts'

/**
 * How long one renewal attempt stands before another is considered, in milliseconds.
 *
 * The status route is polled by the page, so without this every poll would ask Bilibili
 * whether renewal is due. Six hours is longer than the advice the endpoint gives and short
 * enough that a session renewed on one visit is still fresh on the next.
 */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** When renewal was last attempted, so the check is not made on every poll. */
let lastRefreshAttempt = 0

import { CSRF_REF, SESSDATA_REF } from './config.ts'
import { readLogin } from './store.ts'

/**
 * User agent for the session check.
 *
 * Declared here rather than imported from `bili.ts`, which already imports this
 * module; the reverse edge would make the two cycle.
 */
const CHECK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** A failure the page should show verbatim instead of a generic 500. */
export class BiliError extends Error {
  /** Bilibili's numeric code, or a short string tag for local failures. */
  readonly code: number | string | undefined

  /**
   * @param message - operator-facing explanation, already localized.
   * @param code - Bilibili code or local tag, when one applies.
   */
  constructor(message: string, code?: number | string) {
    super(message)
    this.name = 'BiliError'
    this.code = code
  }
}

/** Location of the credential document the Harness owns. */
export const CREDENTIAL_FILE = join(homedir(), '.dsh', '.credentials.yaml')

/** What the page is told about credential availability; booleans only. */
export interface CredentialStatus {
  readonly ok: boolean
  /**
   * Whether a session token and a csrf token are both present in the file.
   *
   * This says the file is populated, not that the session works. Check `valid`
   * before treating the credential as usable.
   */
  readonly configured: boolean
  readonly hasSessdata: boolean
  readonly hasCsrf: boolean
  readonly csrfRef: string
  /**
   * Result of checking the stored session against Bilibili.
   *
   * `unknown` means the check could not run, which is not the same as a rejected
   * session: a network failure must not tell the user to replace a working token.
   */
  readonly valid: 'yes' | 'no' | 'unknown'
  /** Display name of the signed in account, present only when `valid` is `yes`. */
  readonly uname?: string
  /** Why the session was rejected, present only when `valid` is `no`. */
  readonly reason?: string
  /**
   * A stable name for the condition `reason` describes.
   *
   * The page needs to choose its own wording, and it cannot do that from a sentence:
   * an upstream message is written for a developer reading a log, not for a reader
   * deciding where to go next. The code is the contract between the two halves, so a
   * later login method can reject a session for its own reason and the page can word
   * an unhinted code by falling back to `reason` verbatim.
   *
   * Values are added, never renamed, because the page may be a version behind the
   * Host that is serving it.
   */
  readonly code?: CredentialCode
  /** A local failure, such as a missing or unreadable credential file. */
  readonly error?: string
  /**
   * Which store supplied the session that is in use.
   *
   * The two can hold different accounts, so the page has to say which one is in effect
   * rather than leave a reader guessing why the name it shows is not the one they
   * expected.
   */
  readonly source?: 'custom' | 'scanned'
}

/**
 * The conditions that can leave the stored session unusable.
 *
 * `expired` is the one a stored cookie reaches: Bilibili answers `-101` once the
 * session stops being accepted. `missing` is a file that never held a token, which is
 * a different instruction for the reader than a token that went stale. A method that
 * is added later, such as a scanned login, names its own code here and the page picks
 * up wording for it from the same dictionary.
 */
export type CredentialCode = 'expired' | 'missing' | 'unreadable' | 'no-csrf'

/**
 * Extract one `refs.<name>` scalar with a line scan.
 *
 * Only the requested key is materialized; the surrounding document is walked as
 * text and dropped. Handles the two shapes a stored ref takes in practice: a bare
 * value, and a quoted value, with an optional trailing comment.
 *
 * @param name - the ref key to read.
 * @returns the trimmed value.
 * @throws {BiliError} when the file is missing or the key is absent.
 */
function readCredentialRef(name: string): string {
  let text: string
  try {
    text = readFileSync(CREDENTIAL_FILE, 'utf8')
  } catch {
    throw new BiliError(`未找到凭据文件 ${CREDENTIAL_FILE}，请先在 DSH 中配置登录凭据`, 'no-credential')
  }

  const lines = text.split(/\r?\n/)
  let inRefs = false
  let refsIndent = -1

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trimStart()

    // A top-level key ends the previous section; `refs:` opens the one we want.
    if (!trimmed.startsWith(' ') && indent === 0) {
      inRefs = /^refs\s*:\s*$/.test(trimmed)
      refsIndent = inRefs ? 0 : -1
      continue
    }
    if (!inRefs) continue
    if (indent <= refsIndent) {
      inRefs = false
      continue
    }

    const match = new RegExp(`^${name}\\s*:\\s*(.*)$`).exec(trimmed)
    if (!match) continue

    let value = (match[1] ?? '').trim()
    const hash = value.search(/\s#/)
    if (hash >= 0) value = value.slice(0, hash).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    return value
  }

  throw new BiliError(`凭据文件缺少 refs.${name}`, 'no-credential')
}

/**
 * Extract one cookie value from a raw `a=1; b=2` header string.
 *
 * @param cookie - the Cookie header.
 * @param name - the cookie to read.
 * @returns the value, or an empty string when absent.
 */
export function cookieValue(cookie: string, name: string): string {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match ? (match[1] ?? '').trim() : ''
}

/**
 * Build the Cookie header used for outbound Bilibili calls.
 *
 * The stored `SESSDATA` ref may hold either the bare token or a full Cookie
 * header, because both are common ways to copy it out of a browser. A separate
 * `bili_jct` ref supplies the csrf token when only the session was stored.
 *
 * Two sources can hold a session: the refs the user maintains by hand, and the login
 * this plugin obtained by scanning a QR code. This function picks between them and
 * falls back to the other, so a reader whose hand-written credential went stale still
 * gets their scanned login used without having to change the setting first.
 *
 * @param preferCustomCredential - whether the refs credential wins when both exist.
 * @returns a Cookie header carrying at least `SESSDATA`.
 * @throws {BiliError} when neither source holds a session.
 */
export function buildCookie(preferCustomCredential = true): string {
  const custom = readCustomCookie()
  const scanned = readScannedCookie()
  // The setting says which is preferred, and the other is the fallback. Neither branch
  // is a compatibility shim: both sources are live, and the preference exists because
  // a hand-maintained credential and a scanned one can disagree about which account
  // the reader means to use right now.
  const ordered = preferCustomCredential ? [custom, scanned] : [scanned, custom]
  for (const attempt of ordered) {
    if (attempt.cookie !== '') return attempt.cookie
  }
  // Neither source yielded a session, so the reason comes from the one the setting
  // prefers, which is the one the reader meant to use.
  throw new BiliError(ordered[0]?.failure ?? '未配置登录凭据', 'no-credential')
}

/**
 * Build a Cookie header from the refs the user maintains.
 *
 * @returns the header and a failure note, one of which is always empty.
 */
function readCustomCookie(): { cookie: string; failure: string } {
  let stored: string
  try {
    stored = readCredentialRef(SESSDATA_REF).trim()
  } catch (error) {
    const message = error instanceof Error && error.message !== '' ? error.message : ''
    return { cookie: '', failure: message === '' ? `未找到 refs.${SESSDATA_REF}` : message }
  }
  if (stored === '') {
    return { cookie: '', failure: `凭据 refs.${SESSDATA_REF} 为空` }
  }

  const base = stored.includes('=') ? stored : `SESSDATA=${stored}`
  if (cookieValue(base, 'bili_jct') !== '') return { cookie: base, failure: '' }

  let csrfRef = ''
  try {
    csrfRef = readCredentialRef(CSRF_REF).trim()
  } catch {
    return { cookie: base, failure: '' }
  }
  if (csrfRef === '') return { cookie: base, failure: '' }

  const value = csrfRef.startsWith('bili_jct=') ? csrfRef.slice('bili_jct='.length) : csrfRef
  return { cookie: `${base}; bili_jct=${value}`, failure: '' }
}

/**
 * Build a Cookie header from the login obtained by scanning a QR code.
 *
 * @returns the header and a failure note, one of which is always empty.
 */
function readScannedCookie(): { cookie: string; failure: string } {
  const login = readLogin()
  if (login === null) return { cookie: '', failure: '扫码登录凭据不存在' }
  const base = `SESSDATA=${login.sessdata}`
  return {
    cookie: login.biliJct === '' ? base : `${base}; bili_jct=${login.biliJct}`,
    failure: '',
  }
}

/**
 * Report whether a usable login is configured, without sending anything.
 *
 * Never throws: a failure is itself an answer the page renders as "not
 * configured", which is more useful than a failed request.
 *
 * Presence and validity are separate answers. A file can hold a correctly shaped
 * token whose session has expired, and that case used to read as healthy here,
 * which made a dead login indistinguishable from a working one. The optional
 * check below is what separates them.
 *
 * @param timeoutMs - budget for the session check, or 0 to skip it entirely.
 * @returns the availability flags, plus the session verdict when checked.
 */
export async function credentialStatus(timeoutMs = 0, preferCustomCredential = true): Promise<CredentialStatus> {
  let cookie: string
  try {
    cookie = buildCookie(preferCustomCredential)
  } catch (error) {
    return {
      ok: true,
      configured: false,
      hasSessdata: false,
      hasCsrf: false,
      csrfRef: CSRF_REF,
      valid: 'no',
      error: error instanceof Error && error.message !== '' ? error.message : '未配置登录凭据',
      // A file that exists but cannot be read is a different fix for the reader than
      // one that was never written, so the two are kept apart rather than collapsed
      // into a single "not configured".
      code: error instanceof BiliError && error.code === 'no-credential' ? 'missing' : 'unreadable',
    }
  }

  const hasSess = cookieValue(cookie, 'SESSDATA') !== ''
  const hasCsrf = cookieValue(cookie, 'bili_jct') !== ''
  const base: CredentialStatus = {
    ok: true,
    configured: hasSess,
    hasSessdata: hasSess,
    hasCsrf,
    csrfRef: CSRF_REF,
    valid: 'unknown',
    source: whichSource(cookie, preferCustomCredential),
  }
  if (!hasSess) return { ...base, valid: 'no', code: 'missing' }
  if (timeoutMs <= 0) return base

  // A scanned login can be renewed without the reader, and a refs credential cannot,
  // because only the scanned store holds a refresh token. The attempt is made before the
  // session check so a session that was about to lapse is judged on its replacement
  // rather than on the token that is on its way out.
  if (base.source === 'scanned' && Date.now() - lastRefreshAttempt >= REFRESH_INTERVAL_MS) {
    lastRefreshAttempt = Date.now()
    const outcome = await refreshLogin(timeoutMs)
    if (outcome.renewed) {
      const renewed = buildCookie(preferCustomCredential)
      const session = await checkSession(renewed, timeoutMs)
      return { ...base, hasCsrf: cookieValue(renewed, 'bili_jct') !== '', ...session }
    }
  }

  const session = await checkSession(cookie, timeoutMs)
  return { ...base, ...session }
}

/**
 * Name the store a cookie came from.
 *
 * The cookie itself does not carry a marker, so the answer is worked out by asking each
 * store what it would produce. That is only a comparison of in-memory strings, so it
 * costs nothing and stays correct when a reader changes the setting.
 *
 * @param cookie - the header in use.
 * @param preferCustomCredential - which source was tried first.
 * @returns the source, or undefined when neither store produces this header.
 */
function whichSource(cookie: string, preferCustomCredential: boolean): 'custom' | 'scanned' | undefined {
  const ordered: ReadonlyArray<readonly ['custom' | 'scanned', () => { cookie: string }]> = [
    ['custom', readCustomCookie],
    ['scanned', readScannedCookie],
  ]
  const ordered2 = preferCustomCredential ? ordered : [...ordered].reverse()
  for (const [name, read] of ordered2) {
    if (read().cookie === cookie) return name
  }
  return undefined
}

/**
 * Ask Bilibili whether the stored cookie is still a live session.
 *
 * The `nav` endpoint is the cheapest honest answer available: it returns the
 * account name for a working session and `-101` for a token that has expired or
 * been revoked. Nothing is written and no room is touched.
 *
 * @param cookie - the Cookie header to test.
 * @param timeoutMs - request budget.
 * @returns the verdict, plus the account name or the rejection reason.
 */
async function checkSession(
  cookie: string,
  timeoutMs: number,
): Promise<Pick<CredentialStatus, 'valid' | 'uname' | 'reason' | 'code'>> {
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': CHECK_UA,
        Referer: 'https://www.bilibili.com/',
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = (await response.json().catch(() => null)) as {
      code?: number
      message?: string
      data?: { isLogin?: boolean; uname?: string }
    } | null

    // A response we cannot read is not evidence either way, so the token is left
    // neither confirmed nor condemned.
    if (!payload) return { valid: 'unknown' }
    if (payload.code === 0 && payload.data?.isLogin === true) {
      const uname = String(payload.data.uname ?? '').trim()
      return uname === '' ? { valid: 'yes' } : { valid: 'yes', uname }
    }
    if (payload.code === -101) {
      return { valid: 'no', code: 'expired', reason: '登录态已过期，请更新凭据中的 session token' }
    }
    return { valid: 'unknown' }
  } catch {
    return { valid: 'unknown' }
  }
}
