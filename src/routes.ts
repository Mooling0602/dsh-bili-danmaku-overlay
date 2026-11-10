/**
 * HTTP routes for the overlay.
 *
 * Everything lives under one prefix so the Host mounts a single route and the
 * page has one base to talk to. Every handler validates its own input: the page
 * is the only client, but a query string is user input regardless of who sends
 * it, and an unvalidated room id would reach Bilibili verbatim.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { credentialStatus, BiliError } from './credentials.ts'
import { fetchRoomStats, normalizeRoomInput, resolveRoom, sendDanmaku } from './bili.ts'
import { streamDanmaku } from './stream.ts'
import { readHistory, watchHistory } from './poller.ts'
import {
  DEFAULT_STATS_INTERVAL_MS,
  readField,
  readLimits,
  readNumber,
  type Config,
} from './config.ts'

/** Path prefix every route below is mounted under. */
export const ROUTE_PREFIX = '/bili-danmaku-overlay'

/**
 * Identifies this Host process for the page.
 *
 * Boot time rather than a random value: it is stable for the life of the process
 * and changes on the next start, which is the exact lifetime a temporary room
 * title is supposed to have.
 */
const BOOT_ID = `${process.pid}-${Date.now()}`

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Write one JSON response.
 *
 * @param response - the response to write.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Read one small JSON request body.
 *
 * The cap is enforced while reading rather than after, so an oversized upload
 * cannot be buffered in full first.
 *
 * @param request - the incoming request.
 * @returns the parsed body, or an empty object when there is none.
 * @throws {BiliError} on an oversized or malformed body.
 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BiliError('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new BiliError('请求体不是合法 JSON')
  }
}

/**
 * Read one query parameter.
 *
 * @param url - the request URL.
 * @param name - parameter name.
 * @returns the value, or an empty string when absent.
 */
function queryParam(url: URL, name: string): string {
  return url.searchParams.get(name) ?? ''
}

/**
 * Require a valid room id from the query string.
 *
 * @param url - the request URL.
 * @returns the numeric room id.
 * @throws {BiliError} when the parameter is missing or malformed.
 */
function requireRoom(url: URL): number {
  const room = normalizeRoomInput(queryParam(url, 'room'))
  if (room === null) throw new BiliError('房间号无效')
  return room
}

/**
 * Dispatch one request to its handler.
 *
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param config - the live plugin configuration.
 * @returns a promise that settles when the response is done or handed off.
 */
export async function route(
  request: IncomingMessage,
  response: ServerResponse,
  config: Partial<Config> | undefined,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  const limits = readLimits(config)

  if (path === '/api/credential' && request.method === 'GET') {
    sendJson(response, 200, credentialStatus())
    return
  }

  if (path === '/api/config' && request.method === 'GET') {
    // The overlay runs in the page, so the limits that shape its rendering are
    // read here rather than shipped in the client bundle: one source of truth,
    // and a settings edit applies on the next page load without a rebuild.
    sendJson(response, 200, {
      ok: true,
      historyLimit: limits.historyLimit,
      statsIntervalMs: readNumber(config?.statsIntervalMs, DEFAULT_STATS_INTERVAL_MS),
      defaultRoom: readField(config?.defaultRoom, ''),
      autoConnect: readField(config?.autoConnect, false),
      // Identifies this Host process. A page keeps a temporary room title while
      // this value is unchanged and drops it when it differs, which is what makes
      // a rename last exactly one dsh run instead of accumulating forever.
      boot: BOOT_ID,
    })
    return
  }

  if (path === '/api/room' && request.method === 'GET') {
    const roomId = requireRoom(url)
    const resolved = await resolveRoom(roomId, limits.requestTimeoutMs)
    sendJson(response, 200, { ok: true, ...resolved })
    return
  }

  if (path === '/api/stats' && request.method === 'GET') {
    const roomId = requireRoom(url)
    try {
      const stats = await fetchRoomStats(roomId, limits.requestTimeoutMs)
      sendJson(response, 200, { ok: true, ...stats })
    } catch (error) {
      // The header count is decoration: a room that cannot be resolved should
      // leave the figure at zero rather than surface an error banner.
      const message = error instanceof Error ? error.message : '获取在线人数失败'
      sendJson(response, 200, { ok: false, online: 0, liveStatus: 0, error: message })
    }
    return
  }

  if (path === '/api/history' && request.method === 'GET') {
    const roomId = requireRoom(url)
    const resolved = await resolveRoom(roomId, limits.requestTimeoutMs)

    // Read from the room's shared poller rather than calling Bilibili here. The
    // page polls this route far more often than the upstream endpoint should be
    // touched, and forwarding every call would multiply the upstream rate by the
    // number of open pages.
    const poller = watchHistory(resolved.roomId, {
      fetchCount: limits.historyFetch,
      timeoutMs: limits.requestTimeoutMs,
      minMs: limits.pollMinMs,
    })
    // The loop outlives this request; its idle timer stops it once the page goes
    // quiet, so the returned release is only used when the handler unwinds early.
    void poller

    const snapshot = readHistory(resolved.roomId)
    sendJson(response, 200, {
      ok: true,
      roomId: resolved.roomId,
      degraded: snapshot.error !== '',
      intervalMs: snapshot.intervalMs,
      ageMs: snapshot.ageMs,
      items: snapshot.items,
    })
    return
  }

  if (path === '/api/events' && request.method === 'GET') {
    const roomId = requireRoom(url)
    const resolved = await resolveRoom(roomId, limits.requestTimeoutMs)
    streamDanmaku(response, {
      roomId: resolved.roomId,
      timeoutMs: limits.requestTimeoutMs,
      heartbeatMs: limits.heartbeatMs,
      keepaliveMs: 15_000,
      showEnterMessages: limits.showEnterMessages,
      showSuperChat: limits.showSuperChat,
    })
    // The stream owns the response from here; returning without ending it is
    // what keeps the connection open.
    return
  }

  if (path === '/api/send' && request.method === 'POST') {
    const body = await readJsonBody(request)
    const room = normalizeRoomInput(body.room)
    if (room === null) throw new BiliError('房间号无效')
    const result = await sendDanmaku(room, String(body.text ?? ''), limits.requestTimeoutMs)
    sendJson(response, 200, { ok: true, ...result })
    return
  }

  sendJson(response, 404, { ok: false, error: 'Not found' })
}
