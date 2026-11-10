/**
 * The room instances the overlay manages.
 *
 * ── Why a host-independent store ───────────────────────────────────────────
 *
 * A room keeps its socket, its history merge and its reconnect state whether or
 * not the user can see its window. Hiding a window is a view choice, not a
 * lifecycle one, so the connection state cannot live in a component: unmounting
 * the window would drop the socket and the newest danmaku would be gone the
 * moment the window came back.
 *
 * Each `RoomInstance` therefore owns its own state and its own event source, and
 * exposes a subscription. The windows and the floating ball are pure views over
 * this store.
 *
 * ── Why polling follows the Host's interval ────────────────────────────────
 *
 * The Host runs one shared poller per room and knows whether it is healthy or
 * backing off. History pulls read that reported interval instead of a fixed one,
 * so a backed-off room is not pounded and a healthy one is not made to lag.
 */

import {
  fetchHistory,
  fetchStats,
  type Item,
  type RemoteConfig,
} from './api.ts'

/** Connection state as the status dot reports it. */
export type RoomState = 'idle' | 'connecting' | 'reconnecting' | 'live' | 'offline' | 'error'

/**
 * How a room is displayed right now.
 *
 * - `window`: the full danmaku window.
 * - `minimized`: a thin strip still visible on the page.
 * - `hidden`: folded into the ball, still monitored and still collecting danmaku.
 *
 * `hidden` is deliberately distinct from `minimized`: closing a window must not
 * stop monitoring (that is what the ball's menu "quit room" action does), so a
 * closed room keeps streaming and can be reopened from the ball.
 */
export type RoomView = 'window' | 'minimized' | 'hidden'

/** Fallback poll interval, used before the Host has reported its own. */
const DEFAULT_POLL_MS = 1_000

/** Base path of the Host routes. */
const BASE = '/bili-danmaku-overlay'

/** One managed live room. */
export interface RoomInstance {
  /** Stable local id, used as the key in storage and in React lists. */
  readonly key: string
  /** The room id as the user typed it. */
  readonly room: string
  /** Connection state for the status dot. */
  state: RoomState
  /** Whether a window shows this room or it sits inside the ball. */
  view: RoomView
  /** Newest danmaku, oldest first. */
  items: readonly Item[]
  /** A short message to show instead of an empty list. */
  notice: string
  /** Audience count, 0 when unknown. */
  online: number
  /** The room's own title as Bilibili reports it, empty until resolved. */
  liveTitle: string
  /** The streamer's display name, empty until resolved. */
  uname: string
  /**
   * A title the user typed for this window.
   *
   * Ephemeral by design: it is dropped when the Host process changes, so a
   * rename does not silently outlive the session that made it. An empty value
   * means "follow the room's own title".
   */
  alias: string
  /** Where the window sits, in viewport coordinates. */
  place: { x: number; y: number } | null
  /** Epoch milliseconds of the newest danmaku, 0 when none. */
  lastAt: number
  /**
   * Whether the list should follow the newest row.
   *
   * Part of the snapshot rather than private state: scrolling up to read is a
   * user action that must survive the next danmaku, so the view has to re-render
   * when it changes or the pin would win the race.
   */
  follow: boolean
}

/** What the ball's summary line needs from whichever room is most recent. */
export interface Summary {
  /** The room the summary belongs to. */
  readonly key: string
  /** The text to show, already truncated by the view. */
  readonly text: string
  /** The speaker, empty for system rows. */
  readonly user: string
}

type Listener = () => void

/**
 * Strip the transport framing from one server-sent event payload.
 *
 * @param event - the raw event data.
 * @returns the parsed payload, or undefined when it is not usable.
 */
function parseEvent<T>(event: string): T | undefined {
  try {
    const value: unknown = JSON.parse(event)
    return typeof value === 'object' && value !== null ? (value as T) : undefined
  } catch {
    return undefined
  }
}

/** A live room plus the machinery that keeps it current. */
export class RoomStore {
  private readonly listeners = new Set<Listener>()
  private instance: RoomInstance
  private source: EventSource | null = null
  private historyTimer = 0
  private statsTimer = 0
  private pollMs = 0
  private disposed = false
  private readonly config: () => RemoteConfig

  constructor(
    room: string,
    config: () => RemoteConfig,
    initial?: Partial<RoomInstance>,
  ) {
    this.config = config
    this.instance = {
      key: `room-${Math.random().toString(36).slice(2, 10)}`,
      room,
      state: 'idle',
      view: 'window',
      items: [],
      notice: '',
      online: 0,
      liveTitle: '',
      uname: '',
      alias: '',
      place: null,
      lastAt: 0,
      follow: true,
      ...initial,
    }
  }

  /**
   * @returns the current immutable snapshot, for `useSyncExternalStore`.
   */
  getSnapshot = (): RoomInstance => this.instance

  /**
   * @param listener - called after every committed change.
   * @returns the unsubscribe function.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Merge a patch into the snapshot and notify.
   *
   * @param patch - the fields to replace.
   */
  private set(patch: Partial<RoomInstance>): void {
    if (this.disposed) return
    this.instance = { ...this.instance, ...patch }
    for (const listener of this.listeners) listener()
  }

  /**
   * Record whether the reader is at the bottom.
   *
   * @param value - true when the list is pinned to the newest row.
   */
  setStickToBottom(value: boolean): void {
    if (this.instance.follow === value) return
    this.set({ follow: value })
  }

  /**
   * Resolve the room's own title once, so the window can label itself.
   *
   * A failure is not reported: the cached title, or else the room number, stays on
   * screen and the next connect tries again. An offline room still reports its
   * title upstream, so a refusal here is about the request, not about the room.
   */
  async loadTitle(): Promise<void> {
    try {
      const response = await fetch(`${BASE}/api/room?room=${encodeURIComponent(this.instance.room)}`)
      const data = (await response.json()) as {
        ok?: boolean
        title?: string
        uname?: string
      } | null
      if (data?.ok !== true) return
      const liveTitle = String(data.title ?? '').trim()
      const uname = String(data.uname ?? '').trim()
      // Both empty means the resolver had nothing to report; keeping the previous
      // value beats blanking a label that a cached restore already got right.
      if (liveTitle === '' && uname === '') return
      this.set({
        liveTitle: liveTitle === '' ? this.instance.liveTitle : liveTitle,
        uname: uname === '' ? this.instance.uname : uname,
      })
    } catch {
      /* keep the cached or room-number fallback */
    }
  }

  /** Open the live event stream and start the fallback poller. */
  connect(): void {
    if (this.disposed || this.source) return
    this.set({ state: 'connecting', notice: '' })
    void this.loadTitle()
    void this.pullHistory()

    const source = new window.EventSource(
      `${BASE}/api/events?room=${encodeURIComponent(this.instance.room)}`,
    )
    this.source = source

    source.addEventListener('status', (event) => {
      const data = parseEvent<{ state?: RoomState; message?: string }>((event as MessageEvent).data)
      if (!data?.state) return
      this.set({
        state: data.state,
        ...(data.message === undefined ? {} : { notice: data.message }),
      })
      // A stream that came back up means the next history pull should not wait
      // out the backoff interval the Host had reported while it was down.
      if (data.state === 'live') this.pollMs = 0
    })

    source.addEventListener('room', (event) => {
      const data = parseEvent<{ liveStatus?: number }>((event as MessageEvent).data)
      if (data?.liveStatus === undefined || data.liveStatus === 1) return
      this.set({ notice: '主播暂未开播' })
    })

    source.addEventListener('danmaku', (event) => {
      const item = parseEvent<Item>((event as MessageEvent).data)
      if (!item?.id) return
      if (this.instance.items.some((existing) => existing.id === item.id)) return
      this.append([item])
    })

    source.addEventListener('error', () => {
      // EventSource reconnects on its own; mirror that as a reconnecting state so
      // the dot does not keep claiming a healthy stream while it is down.
      if (this.source === source && this.instance.state !== 'error') {
        this.set({ state: 'reconnecting' })
      }
    })

    this.startHistoryPoll()
    this.startStatsPoll()
  }

  /**
   * Show this room as a window or fold it into the ball.
   *
   * @param view - the wanted view.
   */
  setView(view: RoomView): void {
    this.set({ view })
  }

  /**
   * Set the temporary title.
   *
   * @param alias - the title, empty to follow the room's own.
   */
  setAlias(alias: string): void {
    this.set({ alias })
  }

  /**
   * Record the dragged window position.
   *
   * @param place - the position, or null to return to the default corner.
   */
  setPlace(place: { x: number; y: number } | null): void {
    this.set({ place })
  }

  /**
   * Pull history now, for a caller that knows a change just happened.
   *
   * Used after a successful send: the socket never echoes your own message, so
   * the row has to come from history.
   */
  refreshHistory(): void {
    void this.pullHistory()
  }

  /** Tear the stream down but keep the collected danmaku. */
  disconnect(): void {
    this.source?.close()
    this.source = null
    window.clearTimeout(this.historyTimer)
    window.clearInterval(this.statsTimer)
    this.historyTimer = 0
    this.statsTimer = 0
    this.set({ state: 'idle' })
  }

  /** Tear everything down for good. */
  dispose(): void {
    this.disconnect()
    this.disposed = true
    this.listeners.clear()
  }

  /**
   * Append rows, keeping the newest `historyLimit` and de-duplicating by id.
   *
   * @param rows - the rows to append, oldest first.
   */
  private append(rows: readonly Item[]): void {
    const limit = Math.max(20, this.config().historyLimit)
    const byId = new Set(this.instance.items.map((item) => item.id))
    const fresh: Item[] = []
    for (const row of rows) {
      if (byId.has(row.id)) continue
      byId.add(row.id)
      fresh.push(row)
    }
    if (fresh.length === 0) return

    const merged = [...this.instance.items, ...fresh]
    const lastAt = fresh[fresh.length - 1]?.history === true ? this.instance.lastAt : Date.now()
    this.set({ items: merged.slice(-limit), lastAt })
  }

  /**
   * Fold one history window into the list without reordering what is shown.
   *
   * The window is the newest N rows in chronological order, so anything the list
   * holds that the window no longer covers is older and belongs in front.
   * Prepending only the unseen rows would look right on the first pull and invert
   * on the next, because the older rows would keep jumping ahead.
   *
   * @param fresh - the window, oldest first.
   */
  private mergeHistory(fresh: readonly Item[]): void {
    if (fresh.length === 0) return
    const freshIds = new Set(fresh.map((item) => item.id))
    const older = this.instance.items.filter((item) => !freshIds.has(item.id))
    const merged = [...older, ...fresh]
    const unchanged =
      merged.length === this.instance.items.length &&
      merged.every((item, index) => item.id === this.instance.items[index]?.id)
    if (unchanged) return
    const limit = Math.max(20, this.config().historyLimit)
    const newest = fresh[fresh.length - 1]
    this.set({
      items: merged.slice(-limit),
      lastAt: newest?.history === true ? this.instance.lastAt : Date.now(),
    })
  }

  /** Pull one history window. */
  private async pullHistory(): Promise<void> {
    if (this.disposed) return
    try {
      const snapshot = await fetchHistory(this.instance.room)
      if (this.disposed) return
      if (snapshot.intervalMs > 0) this.pollMs = snapshot.intervalMs
      this.mergeHistory(snapshot.items)
    } catch {
      /* the poller's own backoff covers a failed pull */
    }
  }

  /**
   * Poll history while the socket is not delivering.
   *
   * The upstream socket can be refused for reasons outside our control — a
   * throttled address, a room at capacity, a network that blocks the comet hosts.
   * History reads a different endpoint over plain HTTPS and keeps working when the
   * socket does not, which is exactly the case worth covering.
   *
   * A recursive timeout rather than an interval: the Host reports the rate its
   * shared poller is actually using, so a fixed interval would either lag a
   * healthy poller or pound a room that had backed off.
   */
  private startHistoryPoll(): void {
    const tick = (): void => {
      if (this.disposed) return
      const degraded =
        this.instance.state === 'error' ||
        this.instance.state === 'reconnecting' ||
        this.instance.state === 'connecting'
      if (!degraded) {
        // Healthy stream: nothing to cover, and the next tick only needs to check
        // again, not to fetch.
        this.historyTimer = window.setTimeout(tick, DEFAULT_POLL_MS)
        return
      }
      void this.pullHistory().finally(() => {
        if (this.disposed) return
        this.historyTimer = window.setTimeout(tick, this.pollMs > 0 ? this.pollMs : DEFAULT_POLL_MS)
      })
    }
    this.historyTimer = window.setTimeout(tick, DEFAULT_POLL_MS)
  }

  /** Poll the audience figure; nobody pushes it. */
  private startStatsPoll(): void {
    const load = (): void => {
      if (this.disposed) return
      void fetchStats(this.instance.room).then((count) => {
        if (count !== null && count !== this.instance.online) this.set({ online: count })
      })
    }
    load()
    this.statsTimer = window.setInterval(load, Math.max(5_000, this.config().statsIntervalMs))
  }
}

/**
 * Tone for one connection state.
 *
 * @param state - the room state.
 * @returns the CSS color.
 */
export function stateTone(state: RoomState): string {
  if (state === 'live') return 'var(--dsw-alias-state-success-primary, #22c55e)'
  if (state === 'connecting' || state === 'reconnecting') {
    return 'var(--dsw-alias-state-warn-primary, #f59e0b)'
  }
  if (state === 'error') return 'var(--dsw-alias-state-error-primary, #ef4444)'
  return 'var(--dsw-alias-state-idle-primary, #8b8b8b)'
}

/**
 * Reduce several room states to the one worth showing on the ball.
 *
 * A live room outranks a problem elsewhere: the ball answers "is anything
 * arriving", so one healthy stream is the answer even if another is retrying.
 * Only when nothing is live does the worst remaining state take over.
 *
 * @param states - one state per monitored room.
 * @returns the aggregate state.
 */
export function aggregateState(states: readonly RoomState[]): RoomState {
  if (states.length === 0) return 'idle'
  if (states.includes('live')) return 'live'
  if (states.includes('error')) return 'error'
  if (states.includes('reconnecting')) return 'reconnecting'
  if (states.includes('connecting')) return 'connecting'
  if (states.includes('offline')) return 'offline'
  return 'idle'
}
