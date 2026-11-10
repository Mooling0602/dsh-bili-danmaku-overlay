/**
 * A shared, self-throttling history poller, one per room.
 *
 * ── Why the Host owns the polling ──────────────────────────────────────────
 *
 * The page asks the Host for history. If the Host forwarded each request
 * upstream, the load on Bilibili would scale with the number of open pages: three
 * tabs polling at 100ms is 30 requests a second, and nothing would bound it. Here
 * every room has exactly one upstream loop no matter how many pages watch it, so
 * the request rate is a property of the plugin rather than of the user's window
 * count.
 *
 * ── Why it backs off instead of just retrying ──────────────────────────────
 *
 * Bilibili answers a throttle with HTTP 412, and hammering through it deepens the
 * block. The interval therefore doubles on failure and only halves again after a
 * run of clean responses, so a single hiccup cannot bounce the rate between its
 * floor and its ceiling.
 */

import { BiliError } from './credentials.ts'
import { fetchHistory, type HistoryItem } from './stream.ts'

/**
 * Fastest interval the built-in poller will use, in milliseconds.
 *
 * Established by measurement: this endpoint answered 300 sequential requests at
 * this spacing with a flat ~15ms latency and no failures. It is a floor, never a
 * target — the loop starts slower and only falls to it after a clean run.
 */
export const MIN_POLL_MS = 100

/** Slowest interval the loop will back off to, in milliseconds. */
export const MAX_POLL_MS = 30_000

/**
 * Clean responses in a row before the interval halves again.
 *
 * Small on purpose. At the 1s starting interval ten clean reads already show the
 * endpoint is healthy, and at the 100ms floor ten reads is one second of proof —
 * waiting longer would leave a working room stuck slow for a minute. The gradual
 * halving is what protects the rate; the threshold only decides how quickly the
 * floor is reached.
 */
const RECOVER_AFTER = 10

/** One room's polling state. */
interface RoomLoop {
  /** Items from the most recent successful read, oldest first. */
  items: HistoryItem[]
  /** When the last successful read finished, epoch ms. */
  fetchedAt: number
  /** Current interval, milliseconds. */
  intervalMs: number
  /** Consecutive clean responses. */
  streak: number
  /** Pending read timer, if any. */
  timer: ReturnType<typeof setTimeout> | null
  /** Pending idle-stop timer, if any. */
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Set once the loop is stopped so an in-flight read cannot reschedule. */
  stopped: boolean
  /** Last error text, empty when healthy. */
  error: string
}

/** Snapshot handed to the page. */
export interface HistorySnapshot {
  /** Items, oldest first. */
  readonly items: HistoryItem[]
  /** Current poll interval, so the page knows how fresh the data can be. */
  readonly intervalMs: number
  /** Age of `items` in milliseconds. */
  readonly ageMs: number
  /** Error text when the last read failed, otherwise empty. */
  readonly error: string
}

/** Options the poller needs from Config. */
export interface PollerOptions {
  /** How many items a single read keeps. */
  readonly fetchCount: number
  /** Per-request timeout. */
  readonly timeoutMs: number
  /**
   * Effective fastest interval, from Config.
   *
   * Clamped to {@link MIN_POLL_MS} so a bad config value cannot push the loop
   * below the rate that was actually measured as safe.
   */
  readonly minMs: number
}

/**
 * How long a loop keeps polling after the last page request, in milliseconds.
 *
 * A route is a plain request and response, so there is no connection to hang a
 * lifetime on. Idling out instead keeps a room from polling forever once the user
 * navigates away, while still bridging the seconds between one page poll and the
 * next — the gap a watcher count cannot see.
 */
const IDLE_STOP_MS = 60_000

const loops = new Map<number, RoomLoop>()

/**
 * Read one room's loop, creating it if this is the first request.
 *
 * @param roomId - real room id.
 * @param options - supplies the configured interval floor.
 * @returns the live loop record.
 */
function ensureLoop(roomId: number, options: PollerOptions): RoomLoop {
  const existing = loops.get(roomId)
  if (existing) return existing

  const loop: RoomLoop = {
    items: [],
    fetchedAt: 0,
    // Start conservatively and let recovery walk it down: at startup we have no
    // evidence the endpoint is willing to serve us quickly.
    intervalMs: Math.max(options.minMs, 1_000),
    streak: 0,
    timer: null,
    idleTimer: null,
    stopped: false,
    error: '',
  }
  loops.set(roomId, loop)
  return loop
}

/**
 * Run one upstream read and fold the result into the loop's state.
 *
 * @param roomId - real room id.
 * @param loop - the loop to update.
 * @param options - fetch count and timeout.
 */
async function tick(roomId: number, loop: RoomLoop, options: PollerOptions): Promise<void> {
  try {
    const items = await fetchHistory(roomId, options.fetchCount, options.timeoutMs)
    loop.items = items
    loop.fetchedAt = Date.now()
    loop.error = ''
    loop.streak += 1

    // Recover one step at a time. Halving on every success would jump back to the
    // floor in a couple of rounds and lose the protective margin the backoff just
    // earned.
    const floor = Math.max(MIN_POLL_MS, options.minMs)
    if (loop.streak >= RECOVER_AFTER && loop.intervalMs > floor) {
      loop.intervalMs = Math.max(floor, Math.floor(loop.intervalMs / 2))
      loop.streak = 0
    }
  } catch (error) {
    loop.streak = 0
    loop.error = error instanceof Error && error.message !== '' ? error.message : '历史拉取失败'

    // A 412 means the caller is being throttled; doubling is the whole point.
    // Other errors still back off, but they are allowed to climb from a lower base
    // so a briefly flaky network does not leave the overlay on a 30s interval.
    const throttled = error instanceof BiliError && error.code === -412
    const next = loop.intervalMs * (throttled ? 2 : 1.5)
    loop.intervalMs = Math.min(MAX_POLL_MS, Math.round(next))
  }
}

/**
 * Schedule the next read.
 *
 * @param roomId - real room id.
 * @param loop - the loop to advance.
 * @param options - fetch count and timeout.
 */
function schedule(roomId: number, loop: RoomLoop, options: PollerOptions): void {
  if (loop.stopped) return
  loop.timer = setTimeout(() => {
    loop.timer = null
    void tick(roomId, loop, options).then(() => schedule(roomId, loop, options))
  }, loop.intervalMs)
  // A pending poll must not hold the process open on shutdown.
  loop.timer.unref?.()
}

/**
 * Keep a room's loop alive on behalf of one page request.
 *
 * Called on every `/api/history` hit. The first call starts the loop; later calls
 * only push the idle deadline back. Because the loop is per room and not per
 * request, ten pages polling a thousand times a minute still cost one upstream
 * read per interval.
 *
 * @param roomId - real room id.
 * @param options - fetch count and timeout.
 * @returns a function that removes this watcher.
 */
export function watchHistory(roomId: number, options: PollerOptions): () => void {
  const fresh = !loops.has(roomId)
  const loop = ensureLoop(roomId, options)

  // Any request counts as interest: push the idle deadline out.
  if (loop.idleTimer) clearTimeout(loop.idleTimer)
  loop.idleTimer = setTimeout(() => {
    loop.stopped = true
    if (loop.timer) {
      clearTimeout(loop.timer)
      loop.timer = null
    }
    loop.idleTimer = null
    loops.delete(roomId)
  }, IDLE_STOP_MS)
  loop.idleTimer.unref?.()

  // Kick an immediate read when the loop is new: waiting a full interval would
  // show an empty list on open for no reason.
  if (fresh) {
    loop.stopped = false
    void tick(roomId, loop, options).then(() => schedule(roomId, loop, options))
  }

  return () => {
    loop.stopped = true
    if (loop.timer) {
      clearTimeout(loop.timer)
      loop.timer = null
    }
    if (loop.idleTimer) {
      clearTimeout(loop.idleTimer)
      loop.idleTimer = null
    }
    loops.delete(roomId)
  }
}

/**
 * Read the current snapshot for a room without touching the network.
 *
 * @param roomId - real room id.
 * @returns the newest known items and the loop's health, or an empty snapshot.
 */
export function readHistory(roomId: number): HistorySnapshot {
  const loop = loops.get(roomId)
  if (!loop) return { items: [], intervalMs: 0, ageMs: 0, error: '' }
  return {
    items: loop.items,
    intervalMs: loop.intervalMs,
    ageMs: loop.fetchedAt === 0 ? 0 : Date.now() - loop.fetchedAt,
    error: loop.error,
  }
}

/**
 * Stop every loop, for shutdown or a config change.
 */
export function stopAllPollers(): void {
  for (const loop of loops.values()) {
    loop.stopped = true
    if (loop.timer) {
      clearTimeout(loop.timer)
      loop.timer = null
    }
  }
  loops.clear()
}
