/**
 * Bilibili API access for the Host half.
 *
 * ── Endpoints used, and why ────────────────────────────────────────────────
 *
 * `room_init` is the only endpoint that maps a short id to the real room id and
 * reports `live_status` plus the anchor `uid`, so every other call is built on
 * top of it.
 *
 * The audience figure comes from `getOnlineGoldRank`, whose `onlineNum` is the
 * actual number of people watching. `getRoomBaseInfo.online` is *not* used for
 * that: it is a popularity score that can exceed the follower count by an order
 * of magnitude.
 *
 * `getDanmuInfo` needs a WBI signature (`w_rid`), which is why the mixin-key
 * machinery below exists. Without it the endpoint answers `-352`.
 */

import { createHash } from 'node:crypto'

import { BiliError, buildCookie, cookieValue } from './credentials.ts'
import { CSRF_REF, MAX_DANMAKU_CHARS, SESSDATA_REF } from './config.ts'
import type { DanmuInfo, DanmuHost, ResolvedRoom } from './types.ts'

/** Browser-shaped agent; Bilibili rejects some anonymous clients outright. */
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * WBI mixin-key permutation table.
 *
 * Published by Bilibili's own web client: the 64 characters fetched from the nav
 * endpoint are reordered through this table and truncated to 32 to form the key.
 */
const MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
] as const

/**
 * @param text - the string to hash.
 * @returns the lowercase hex MD5 digest.
 */
const md5 = (text: string): string => createHash('md5').update(text).digest('hex')

/** One decoded JSON envelope from a Bilibili API. */
interface BiliEnvelope<T> {
  readonly code?: number
  readonly message?: string
  readonly msg?: string
  readonly data?: T
}

/** Options controlling how a Bilibili error code is treated. */
interface BiliJsonOptions {
  /** Codes to accept instead of throwing, for endpoints that answer non-zero while still being useful. */
  readonly allowCodes?: readonly number[]
  /** Per-request timeout override in milliseconds. */
  readonly timeoutMs?: number
}

/**
 * Fetch and unwrap one Bilibili JSON envelope.
 *
 * @param url - absolute endpoint URL.
 * @param referer - Referer header; Bilibili checks it on some endpoints.
 * @param options - allow-list of codes and a timeout override.
 * @returns the unwrapped `data` payload.
 * @throws {BiliError} on a network failure, an unparseable body, or a rejected code.
 */
async function biliJson<T>(
  url: string,
  referer: string,
  options: BiliJsonOptions = {},
): Promise<T | undefined> {
  const allowCodes = options.allowCodes ?? []
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: referer,
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }

  // Send the login whenever it is available. Anonymous calls do not merely lose
  // account-specific fields: some endpoints answer `code: 0` with empty arrays,
  // which is indistinguishable from "nothing happened" and costs a debugging
  // round every time. A missing credential stays non-fatal — public endpoints
  // still work — so the plugin remains usable before the user configures one.
  try {
    const cookie = buildCookie()
    if (cookie !== '') headers.Cookie = cookie
  } catch {
    /* no credential configured yet */
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
  })

  // 412 arrives as an HTML block page, not JSON, so parsing first would report
  // "unparseable response" and hide the real cause: the caller is being throttled.
  if (response.status === 412) {
    throw new BiliError('被 Bilibili 风控拦截（HTTP 412），请稍后重试', -412)
  }

  const payload = (await response.json().catch(() => null)) as BiliEnvelope<T> | null
  if (!payload) throw new BiliError('Bilibili 返回了无法解析的响应')

  const code = payload.code ?? 0
  if (code !== 0 && !allowCodes.includes(code)) {
    const message =
      code === -352
        ? '被 Bilibili 风控校验拦截，请稍后重试'
        : code === 60004
          ? '直播间不存在'
          : String(payload.message || payload.msg || `Bilibili 错误 ${code}`)
    throw new BiliError(message, code)
  }
  return payload.data
}

/**
 * Resolve a short room id to the real room id and live status.
 *
 * ── Why `getRoomBaseInfo` comes first ──────────────────────────────────────
 *
 * `room_init` answers 412 with an HTML block page once Bilibili decides to
 * throttle the caller, and it does so for every header combination including
 * anonymous ones — the block is per IP, not per credential. Since resolution is
 * the first call the overlay makes, a throttled `room_init` takes the whole
 * feature down even though the history endpoint still works fine.
 * `getRoomBaseInfo` was answering normally throughout, so it leads.
 *
 * ── Why `room_init` stays ──────────────────────────────────────────────────
 *
 * `getRoomBaseInfo` is keyed by *real* room ids: asking it about a short id
 * returns `code: 0` with an empty `by_room_ids`, which is indistinguishable from
 * a deleted room. Short ids still have to go through `room_init`, so it remains
 * as the fallback — reached only when the primary lookup came back empty.
 *
 * @param roomInput - a numeric room id or short id.
 * @param timeoutMs - request timeout in milliseconds.
 * @returns the resolved room.
 * @throws {BiliError} when the room cannot be resolved.
 */
export async function resolveRoom(roomInput: number, timeoutMs = 12_000): Promise<ResolvedRoom> {
  const primary = await biliJson<{
    by_room_ids?: Record<string, { room_id?: number; live_status?: number; uid?: number }>
  }>(
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo' +
      `?room_ids=${roomInput}&req_biz=web_room_componet`,
    'https://live.bilibili.com/',
    { timeoutMs },
  )

  const known = primary?.by_room_ids?.[String(roomInput)]
  if (known?.room_id) {
    return {
      roomId: Number(known.room_id),
      shortId: 0,
      liveStatus: Number(known.live_status ?? 0),
    }
  }

  const data = await biliJson<{
    room_id?: number
    short_id?: number
    live_status?: number
    uid?: number
  }>(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomInput}`, 'https://live.bilibili.com/', {
    timeoutMs,
  })

  const roomId = Number(data?.room_id ?? 0)
  if (roomId <= 0) throw new BiliError('直播间不存在', 60004)

  return {
    roomId,
    shortId: Number(data?.short_id ?? 0),
    liveStatus: Number(data?.live_status ?? 0),
  }
}

/** The audience figure plus the live status the header shows. */
export interface RoomStats {
  /** Real room id. */
  readonly roomId: number
  /** Actual number of people watching. */
  readonly online: number
  /** `1` while live, `2` when not. */
  readonly liveStatus: number
}

/**
 * Read the real online viewer count.
 *
 * The audience-rank endpoint is keyed by the anchor uid, which only `room_init`
 * carries, so this makes two calls. `onlineNum` is the head count; the popularity
 * figure other endpoints report is deliberately not used here.
 *
 * A throttled `room_init` (HTTP 412) must not sink the whole stats call: the
 * overlay would lose its viewer count for a reason unrelated to the count. When
 * the uid cannot be read the anchor's own uid is taken from the history-free
 * base-info payload instead, and failing that the ranking request is skipped and
 * zero is reported rather than throwing.
 *
 * @param roomId - the real room id.
 * @param timeoutMs - request timeout in milliseconds.
 * @returns the audience figure and live status.
 * @throws {BiliError} when the room cannot be resolved.
 */
export async function fetchRoomStats(roomId: number, timeoutMs = 12_000): Promise<RoomStats> {
  const resolved = await resolveRoom(roomId, timeoutMs)
  const liveStatus = resolved.liveStatus

  let uid = 0
  try {
    const init = await biliJson<{ uid?: number }>(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`,
      'https://live.bilibili.com/',
      { timeoutMs },
    )
    uid = Number(init?.uid ?? 0)
  } catch {
    const base = await biliJson<{
      by_room_ids?: Record<string, { uid?: number }>
    }>(
      'https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo' +
        `?room_ids=${roomId}&req_biz=web_room_componet`,
      'https://live.bilibili.com/',
      { timeoutMs },
    ).catch(() => undefined)
    uid = Number(base?.by_room_ids?.[String(roomId)]?.uid ?? 0)
  }

  // Without an anchor uid the ranking endpoint answers -400, so ask nothing.
  if (uid <= 0) return { roomId, online: 0, liveStatus }

  const url =
    'https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank' +
    `?ruid=${uid}&roomId=${roomId}&page=1&pageSize=1`

  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `https://live.bilibili.com/${roomId}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = (await response.json().catch(() => null)) as BiliEnvelope<{ onlineNum?: number }> | null
  const online = Number(payload?.data?.onlineNum ?? 0)

  return {
    roomId,
    online: Number.isFinite(online) && online >= 0 ? online : 0,
    liveStatus,
  }
}

/**
 * Build the WBI signing key from the nav endpoint's image keys.
 *
 * An anonymous visit answers `-101 账号未登录` yet still carries `wbi_img`, which
 * is why `-101` is accepted instead of treated as a failure.
 *
 * The same response carries the account's `mid`, so it is returned alongside the
 * key: the danmaku handshake authenticates as a specific user and cannot be
 * anonymous, and reading both here keeps that to one nav call per connection.
 *
 * @param timeoutMs - request timeout in milliseconds.
 * @returns the 32-character mixin key and the signed-in uid, 0 when anonymous.
 * @throws {BiliError} when the key cannot be derived.
 */
async function wbiIdentity(timeoutMs: number): Promise<{ mixinKey: string, uid: number }> {
  const data = await biliJson<{
    mid?: number
    wbi_img?: { img_url?: string; sub_url?: string }
  }>('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/', {
    allowCodes: [-101],
    timeoutMs,
  })

  const pick = (url: string | undefined): string =>
    String(url ?? '')
      .split('/')
      .pop()!
      .replace(/\.png.*$/, '')
  const raw = pick(data?.wbi_img?.img_url) + pick(data?.wbi_img?.sub_url)
  if (raw.length < 64) throw new BiliError('无法解析 Bilibili 的 WBI 密钥')

  const mixinKey = MIXIN_KEY_TABLE.map((index) => raw[index] ?? '')
    .join('')
    .slice(0, 32)
  const uid = Number(data?.mid ?? 0)

  return { mixinKey, uid: Number.isFinite(uid) && uid > 0 ? uid : 0 }
}

/**
 * Sign query parameters with the WBI algorithm.
 *
 * A caller that already holds the key passes it in, so a flow needing the key and
 * the uid together reads nav once instead of three times.
 *
 * @param params - parameters to sign, excluding `wts` and `w_rid`.
 * @param timeoutMs - request timeout for the key fetch.
 * @param knownKey - mixin key already derived by the caller.
 * @returns the signed query string.
 * @throws {BiliError} when the key cannot be derived.
 */
async function signedQuery(
  params: Readonly<Record<string, string | number>>,
  timeoutMs: number,
  knownKey?: string,
): Promise<string> {
  const mixinKey = knownKey ?? (await wbiIdentity(timeoutMs)).mixinKey
  const withTime: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(withTime)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(String(withTime[key]))}`)
    .join('&')
  return `${query}&w_rid=${md5(query + mixinKey)}`
}

/**
 * Fetch the danmaku token and the comet host list for a room.
 *
 * @param roomId - the real room id.
 * @param timeoutMs - request timeout in milliseconds.
 * @returns the token and candidate hosts.
 * @throws {BiliError} when the endpoint returns no usable host.
 */
export async function danmuInfo(roomId: number, timeoutMs = 12_000): Promise<DanmuInfo> {
  const { mixinKey, uid } = await wbiIdentity(timeoutMs)
  const query = await signedQuery({ id: roomId, type: 0, web_location: '444.8' }, timeoutMs, mixinKey)
  const data = await biliJson<{ token?: string; host_list?: DanmuHost[] }>(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
    `https://live.bilibili.com/${roomId}`,
    { timeoutMs },
  )

  const hosts = Array.isArray(data?.host_list) ? data.host_list : []
  if (hosts.length === 0) throw new BiliError('没有可用的弹幕服务器')
  return { token: String(data?.token ?? ''), hosts, uid }
}

/** Frames decoded from one comet packet, before they are narrowed to items. */
export interface RawDanmaku {
  readonly text: string
  readonly user: string
  readonly id: string
  readonly color: number
  readonly admin: boolean
  readonly medal: { readonly name: string; readonly level: number } | null
  readonly guard: number
  readonly price?: number
  readonly kind: 'danmaku' | 'superchat' | 'enter'
}

/**
 * Send one danmaku to a live room using the stored login cookie.
 *
 * @param roomInput - the room id or short id the user typed.
 * @param text - the message body.
 * @param timeoutMs - request timeout in milliseconds.
 * @returns the resolved room id and the text that was sent.
 * @throws {BiliError} when the room, the credential, or the send is rejected.
 */
export async function sendDanmaku(
  roomInput: number,
  text: string,
  timeoutMs = 12_000,
): Promise<{ roomId: number; text: string }> {
  const message = text.trim()
  if (message === '') throw new BiliError('弹幕内容不能为空')
  if (message.length > MAX_DANMAKU_CHARS) {
    throw new BiliError(`弹幕最多 ${MAX_DANMAKU_CHARS} 个字符`)
  }

  const cookie = buildCookie()
  const csrf = cookieValue(cookie, 'bili_jct')
  if (csrf === '') {
    throw new BiliError(
      `凭据缺少 bili_jct：请在 DSH 凭据中写入 refs.${CSRF_REF}，值等于浏览器 Cookie 里的 bili_jct`,
      'no-csrf',
    )
  }

  const resolved = await resolveRoom(roomInput, timeoutMs)
  const body = new URLSearchParams({
    bubble: '0',
    msg: message,
    color: '16777215',
    mode: '1',
    fontsize: '25',
    rnd: String(Math.floor(Date.now() / 1000)),
    roomid: String(resolved.roomId),
    csrf,
    csrf_token: csrf,
  })

  const response = await fetch('https://api.live.bilibili.com/msg/send', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `https://live.bilibili.com/${resolved.roomId}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = (await response.json().catch(() => null)) as BiliEnvelope<unknown> | null
  if (!payload) throw new BiliError('发弹幕返回了无法解析的响应')

  const code = payload.code ?? 0
  if (code !== 0) {
    const known: Readonly<Record<string, string>> = {
      '-101': `登录已失效，请更新 DSH 凭据中的 refs.${SESSDATA_REF}`,
      '-111': 'csrf 校验失败，请确认凭据里的 bili_jct 完整',
      '-400': '弹幕内容不合法',
      '-403': '你被禁言或该房间限制发言',
      '10030': '该房间开启了等级或粉丝勋章限制',
      '10031': '发送过于频繁，请稍后再试',
    }
    const reason =
      known[String(code)] ?? String(payload.message || payload.msg || `发送失败（${code}）`)
    throw new BiliError(reason, code)
  }

  return { roomId: resolved.roomId, text: message }
}

/**
 * Normalize what the user typed into a numeric room id.
 *
 * Accepts a bare id, a short id, or a full `live.bilibili.com` URL, which is what
 * copying a room link produces. A resolved id of `0` is rejected: it passes the
 * shape test but is not a room, and forwarding it would spend a request on a
 * guaranteed failure.
 *
 * @param input - the raw input.
 * @returns the numeric id, or `null` when it is not a room reference.
 */
export function normalizeRoomInput(input: unknown): number | null {
  const raw = String(input ?? '').trim()
  if (raw === '') return null

  const fromUrl = raw.match(/live\.bilibili\.com\/(?:h5\/)?(\d{1,12})/i)
  const bare = raw.match(/^\d{1,12}$/)
  const digits = fromUrl?.[1] ?? bare?.[0]
  if (digits === undefined) return null

  const roomId = Number(digits)
  return Number.isInteger(roomId) && roomId > 0 ? roomId : null
}
