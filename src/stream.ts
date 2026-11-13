/**
 * Server-sent events and history fetching.
 *
 * ── Why the Host owns the socket ───────────────────────────────────────────
 *
 * Bilibili's comet server validates the WebSocket `Origin`, and rejects one
 * opened from the Harness page. The Host therefore holds the upstream socket and
 * the page reads same-origin events instead, which also keeps the auth token out
 * of the browser entirely.
 *
 * ── Why history exists at all ──────────────────────────────────────────────
 *
 * A fresh socket only sees what is said after it attaches, and a background tab
 * throttles `EventSource` delivery. Both cases are covered by pulling the recent
 * window from `gethistory` and merging on the stable message id.
 */

import { BiliError, buildCookie } from './credentials.ts'
import { AUTH_REPLY_CMD, decodeFrame, authPacket, heartbeatPacket, toDanmaku } from './comet.ts'
import { UA, danmuInfo, resolveRoom } from './bili.ts'
import type { DanmakuItem } from './types.ts'

/** The slice of the HTTP response the event stream writes to. */
export interface EventSink {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): void
  end(): void
  readonly writableEnded: boolean
  destroy(): void
}

/** Callbacks the transport reports through. */
export interface StreamOptions {
  /** Real room id to attach to. */
  readonly roomId: number
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Comet heartbeat interval in milliseconds. */
  readonly heartbeatMs: number
  /** Keep-alive comment interval in milliseconds. */
  readonly keepaliveMs: number
  /** Whether enter-room notices are forwarded. */
  readonly showEnterMessages: boolean
  /** Whether super chats are forwarded. */
  readonly showSuperChat: boolean
  /** Whether the refs credential outranks the scanned login. */
  readonly preferCustomCredential: boolean
}

/**
 * Turn a refused handshake into the message the overlay shows.
 *
 * The server reports the reason as a bare number, and the numbers that matter are
 * few: an unauthenticated uid, an expired token, and the room refusing clients.
 *
 * @param code - the auth reply's `code`.
 * @returns the explanation, with the raw code kept for a report.
 */
function authError(code: number): string {
  if (code === -101) return '登录态无效，无法连接弹幕服务器（-101）'
  if (code === -352) return 'Bilibili 风控拦截了弹幕握手，请稍后重试（-352）'
  if (code === -400) return '弹幕握手参数被拒绝（-400）'
  if (code === -403) return '该直播间拒绝当前账号连接（-403）'
  if (code === -404) return '直播间不存在或已关闭（-404）'
  return `弹幕服务器拒绝了握手（${code}）`
}

/** How many live transports the process is holding at most, so the registry cannot grow without bound. */
const MAX_TRACKED_STREAMS = 32

/**
 * One live event stream, described for the debug tool.
 *
 * A stream outlives a single request only as long as its socket stays open, so the
 * registry that holds these is the only place a question about a stalled
 * connection can be answered.
 */
interface TrackedStream {
  /** Real room id the stream is attached to. */
  readonly roomId: number
  /** When the stream started, epoch ms. */
  readonly startedAt: number
  /** Current socket state, updated as the socket changes. */
  state: 'connecting' | 'open' | 'closed' | 'offline' | 'error'
  /** Whether the server answered the handshake on the current socket. */
  authenticated: boolean
  /** Comet messages forwarded to the page. */
  messages: number
  /** Danmaku items forwarded to the page. */
  items: number
  /** Completed reconnects. */
  reconnects: number
  /** Last status text sent to the page, empty when healthy. */
  lastStatus: string
  /** When the last message arrived, epoch ms; 0 when none has. */
  lastMessageAt: number
}

const streams = new Map<number, TrackedStream>()

/**
 * Describe every tracked stream.
 *
 * @returns one row per live stream, with its socket health and counters.
 */
export function describeSockets(): TrackedStream[] {
  return [...streams.values()].map((stream) => ({ ...stream }))
}

/**
 * Read the counters for one room's stream.
 *
 * @param roomId - real room id.
 * @returns the counters, or undefined when that room has no stream.
 */
export function readTransportStats(roomId: number): TrackedStream | undefined {
  const stream = streams.get(roomId)
  return stream ? { ...stream } : undefined
}

/**
 * Clear the counters on every tracked stream.
 *
 * The socket state and the room id survive, because they describe the connection
 * rather than the measurement window. Everything that accumulates is zeroed, so a
 * caller can take a report, reset, wait, and take a second report whose numbers
 * describe only the interval between the two.
 *
 * @returns how many streams were reset.
 */
export function resetTransportStats(): number {
  let count = 0
  for (const stream of streams.values()) {
    stream.messages = 0
    stream.items = 0
    stream.reconnects = 0
    stream.lastMessageAt = 0
    count += 1
  }
  return count
}

/**
 * Stream one room's danmaku to the page as server-sent events.
 *
 * Reconnects on its own with exponential backoff, rotating through the host list
 * so a single unhealthy comet node cannot pin the stream to a failure loop.
 *
 * @param response - the response to write to.
 * @param options - stream limits.
 * @returns a teardown callback.
 */
export function streamDanmaku(response: EventSink, options: StreamOptions): () => void {
  const { roomId } = options

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write(': connected\n\n')

  let closed = false
  let upstream: WebSocket | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  /**
   * Whether the current socket has been told its handshake succeeded.
   *
   * Reset to false for every new socket, so a reconnect reports itself live again
   * once the new handshake is answered rather than inheriting the old socket's
   * success.
   */
  let authenticated = false
  let hostIndex = 0
  let liveStatus: number | null = null

  // The tracked record is what the debug tool reads, and it is the same object the
  // handlers below mutate, so the two cannot disagree about a socket's health.
  const tracked: TrackedStream = {
    roomId,
    startedAt: Date.now(),
    state: 'connecting',
    authenticated: false,
    messages: 0,
    items: 0,
    reconnects: 0,
    lastStatus: '',
    lastMessageAt: 0,
  }
  // A room can only sensibly have one live stream at a time, and an old entry from
  // a page that already navigated away would otherwise answer for the new one.
  if (streams.size >= MAX_TRACKED_STREAMS) {
    const oldest = [...streams.entries()].sort((left, right) => left[1].startedAt - right[1].startedAt)[0]
    if (oldest) streams.delete(oldest[0])
  }
  streams.set(roomId, tracked)

  const send = (event: string, data: unknown): void => {
    if (event === 'status') {
      const record = data as { state?: string; message?: string }
      tracked.lastStatus = record.message ?? record.state ?? ''
    }
    if (closed || response.writableEnded) return
    try {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      stop()
    }
  }

  const stop = (): void => {
    if (closed) return
    closed = true
    tracked.state = 'closed'
    // Leaving a closed stream in the registry would let a later report describe a
    // connection that no longer exists.
    if (streams.get(roomId) === tracked) streams.delete(roomId)
    if (heartbeat) clearInterval(heartbeat)
    if (keepalive) clearInterval(keepalive)
    if (retryTimer) clearTimeout(retryTimer)
    try {
      upstream?.close()
    } catch {
      /* already closed */
    }
    if (!response.writableEnded) response.end()
  }

  keepalive = setInterval(() => {
    if (closed || response.writableEnded) return
    try {
      response.write(': ping\n\n')
    } catch {
      stop()
    }
  }, options.keepaliveMs)

  const scheduleRetry = (): void => {
    if (closed) return
    attempt += 1
    hostIndex += 1
    // Cap at 60s. The previous 15s ceiling kept a rejected session retrying four
    // times a minute, which is enough for Bilibili's throttle to notice; a minute
    // between attempts is still responsive for a live room.
    const delay = Math.min(1000 * 2 ** Math.min(attempt, 6), 60_000)
    send('status', { state: 'reconnecting', attempt, delay })
    retryTimer = setTimeout(() => {
      void connect()
    }, delay)
  }

  const connect = async (): Promise<void> => {
    if (closed) return
    try {
      if (liveStatus === null) {
        const resolved = await resolveRoom(roomId, options.timeoutMs)
        liveStatus = resolved.liveStatus
        send('room', { roomId: resolved.roomId, liveStatus: resolved.liveStatus })
      }
      if (liveStatus !== 1) {
        tracked.state = 'offline'
        send('status', { state: 'offline' })
        return
      }

      const info = await danmuInfo(roomId, options.timeoutMs)
      const host = info.hosts[hostIndex % info.hosts.length]
      if (!host) throw new BiliError('弹幕服务器列表为空')

      const socket = new WebSocket(`wss://${host.host}/sub`)
      upstream = socket
      socket.binaryType = 'arraybuffer'
      authenticated = false
      tracked.state = 'connecting'
      tracked.authenticated = false

      socket.addEventListener('open', () => {
        if (closed) {
          socket.close()
          return
        }
        tracked.state = 'open'
        socket.send(new Uint8Array(authPacket(roomId, info.token, info.uid)))
        heartbeat = setInterval(() => {
          if (socket.readyState === 1) socket.send(new Uint8Array(heartbeatPacket()))
        }, options.heartbeatMs)
      })

      socket.addEventListener('message', (event: MessageEvent) => {
        if (closed) return
        const data: unknown = event.data
        const buffer =
          data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data))
            : Buffer.from(String(data), 'utf8')

        const decoded = decodeFrame(buffer)
        if (decoded.length === 0) return
        tracked.messages += decoded.length
        tracked.lastMessageAt = Date.now()

        // A refused handshake is terminal for this attempt: retrying with the
        // same identity and token only burns the throttle that caused it. The
        // socket is closed by the server a moment later, so report the reason
        // now and let the close handler do the backoff.
        const refusal = decoded.find(
          (message) => message.cmd === AUTH_REPLY_CMD && (message.authCode ?? 0) !== 0,
        )
        if (refusal) {
          tracked.state = 'error'
          send('status', {
            state: 'error',
            message: authError(refusal.authCode ?? 0),
          })
          return
        }

        // Announce the session as live on the same proof the backoff resets on:
        // the server answered the handshake. The announcement cannot sit inside
        // the `attempt !== 0` guard — the first connection starts at attempt 0,
        // so a healthy first handshake would never report itself and the overlay
        // would stay on its connecting state forever.
        if (!authenticated) {
          authenticated = true
          tracked.authenticated = true
          attempt = 0
          send('status', { state: 'live' })
        }

        for (const message of decoded) {
          if (message.cmd === AUTH_REPLY_CMD) continue
          const item = toDanmaku(message, {
            showEnterMessages: options.showEnterMessages,
            showSuperChat: options.showSuperChat,
          })
          if (item) {
            tracked.items += 1
            send('danmaku', item)
          }
        }
      })

      socket.addEventListener('close', () => {
        if (heartbeat) {
          clearInterval(heartbeat)
          heartbeat = null
        }
        tracked.authenticated = false
        if (!closed) {
          tracked.state = 'closed'
          tracked.reconnects += 1
          scheduleRetry()
        }
      })

      socket.addEventListener('error', () => {
        try {
          socket.close()
        } catch {
          /* already closed */
        }
      })
    } catch (error) {
      if (closed) return
      const message = error instanceof Error && error.message !== '' ? error.message : '连接弹幕服务器失败'
      send('status', { state: 'error', message })
      scheduleRetry()
    }
  }

  void connect()
  return stop
}

/** One item returned by the history endpoint. */
export interface HistoryItem extends DanmakuItem {
  /** Always true; marks the item as replayed rather than live. */
  readonly history: true
}

/**
 * Fetch the recent danmaku the room already showed.
 *
 * ── Why the cookie is required ─────────────────────────────────────────────
 *
 * Anonymous callers get `code: 0` with empty `room` and `admin` arrays — a
 * successful-looking response that carries nothing. With the login cookie the
 * same URL returns real messages. That silent-empty shape is why an unauthenticated
 * request looks like "this room has no history" rather than an error.
 *
 * ── Why `admin` is read too ────────────────────────────────────────────────
 *
 * The endpoint splits moderators' messages into a separate `admin` array. Reading
 * only `room` drops them, which in a heavily moderated room can be most of the
 * visible conversation.
 *
 * @param roomId - the real room id.
 * @param fetchCount - how many items to keep, applied after merging and sorting.
 * @param timeoutMs - request timeout in milliseconds.
 * @returns the items, oldest first, or an empty array when unavailable.
 */
export async function fetchHistory(
  roomId: number,
  fetchCount: number,
  timeoutMs = 12_000,
  preferCustomCredential = true,
): Promise<HistoryItem[]> {
  const url =
    'https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory' +
    `?roomid=${roomId}&room_type=0`

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: `https://live.bilibili.com/${roomId}`,
  }

  // A missing or unreadable credential is not fatal here: history is a
  // convenience, and the live socket still works without it.
  try {
    const cookie = buildCookie(preferCustomCredential)
    if (cookie !== '') headers.Cookie = cookie
  } catch {
    /* fall through anonymously */
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })

  // A 412 block page is HTML, and parsing it as JSON yields the misleading
  // "unparseable response". Name the real problem instead.
  if (response.status === 412) {
    throw new BiliError('被 Bilibili 风控拦截（HTTP 412），请稍后重试', -412)
  }

  const payload = (await response.json().catch(() => null)) as {
    code?: number
    data?: { room?: unknown[]; admin?: unknown[] }
  } | null
  if (!payload) throw new BiliError('历史弹幕返回了无法解析的响应')

  const admin = Array.isArray(payload.data?.admin) ? payload.data.admin : []
  const room = Array.isArray(payload.data?.room) ? payload.data.room : []
  const merged = [...admin, ...room]

  // A rejected session does not fail here: `gethistory` answers `code: 0` with two
  // empty arrays, which is shaped exactly like a quiet room. Left alone that makes
  // a dead login look like a healthy one, and the poller keeps a 100ms interval
  // because every read "succeeds". Measured directly: a room carrying a danmaku a
  // second returned both arrays empty with and without a cookie, while the same
  // cookie was refused by `nav` with -101, so an empty pair is a degradation
  // signal rather than evidence of silence.
  if (payload.code === 0 && merged.length === 0) {
    throw new BiliError('历史弹幕为空：登录态可能已失效或被风控降级', -352)
  }

  /** One row of the history payload, as far as this module reads it. */
  interface HistoryRecord {
    readonly id_str?: unknown
    readonly timeline?: unknown
    readonly text?: unknown
    readonly nickname?: unknown
    readonly isadmin?: unknown
    readonly medal?: unknown
    readonly user_level?: unknown
  }

  const items: HistoryItem[] = []
  /** Timeline kept beside each item so the merge can be ordered in one pass. */
  const timelineOf = new Map<string, string>()
  const seen = new Set<string>()
  let index = 0

  for (const entry of merged) {
    const record = entry as HistoryRecord
    const text = String(record.text ?? '').trim()
    if (text === '') continue

    const id = String(record.id_str ?? `h-${String(record.timeline ?? '')}-${index}`)
    index += 1
    if (seen.has(id)) continue
    seen.add(id)
    timelineOf.set(id, String(record.timeline ?? ''))

    const medal = Array.isArray(record.medal)
      ? { name: String(record.medal[1] ?? ''), level: Number(record.medal[0] ?? 0) }
      : null

    items.push({
      kind: 'danmaku',
      id,
      // The history payload carries no danmaku colour, so the neutral white the
      // live path falls back to is the honest value here.
      text,
      user: String(record.nickname ?? ''),
      color: 16777215,
      admin: Number(record.isadmin ?? 0) === 1,
      medal,
      guard: Number(record.user_level ?? 0),
      history: true,
    })
  }

  // The two arrays are not interleaved by time, so sort before trimming;
  // otherwise `slice(-n)` keeps an arbitrary mixture rather than the newest rows.
  items.sort((left, right) =>
    (timelineOf.get(left.id) ?? '').localeCompare(timelineOf.get(right.id) ?? ''),
  )

  return items.slice(-fetchCount)
}
