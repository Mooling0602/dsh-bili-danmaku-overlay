/**
 * Page-side state and transport helpers.
 *
 * The overlay talks to its own Host routes only, so every call here is
 * same-origin. Persistence is `localStorage` and holds layout preferences — a
 * room id, a position, whether it is open — never a credential.
 */

/** Where the overlay persists its layout choices. */
const STORAGE_KEY = 'dsh-bili-danmaku-overlay'

/**
 * Event raised in this document after a layout write.
 *
 * The DOM gives no notification for a write made by the document itself, so the
 * settings page and the overlay, which share one document, could not otherwise
 * see each other's changes.
 */
const STATE_EVENT = 'dsh-bili-danmaku-overlay:state'

/** Base path of the Host routes. */
const BASE = '/bili-danmaku-overlay'

/** One danmaku as the overlay renders it. */
export interface Item {
  readonly kind: 'danmaku' | 'superchat' | 'enter'
  readonly id: string
  readonly text: string
  readonly user: string
  readonly color: number
  readonly admin: boolean
  readonly medal: { readonly name: string; readonly level: number } | null
  readonly guard: number
  readonly price?: number
  readonly history?: boolean
}

/** One room as persistence stores it. */
export interface SavedRoom {
  /** The room id as the user typed it. */
  readonly room: string
  /** Whether a window shows it, a strip shows it, or it sits inside the ball. */
  readonly view?: 'window' | 'minimized' | 'hidden'
  /** A temporary title the user typed, empty to follow the room title. */
  readonly alias?: string
  /**
   * The room's own title, cached so a restored window labels itself before the
   * resolver answers. A cached title is a stale hint, never the source of truth:
   * the next connect overwrites it.
   */
  readonly liveTitle?: string
  /** The streamer's display name, cached alongside the title. */
  readonly uname?: string
  /** Last dragged position, in viewport coordinates. */
  readonly place?: { readonly x: number; readonly y: number } | null
}

/** Layout choices that survive a reload. */
export interface SavedState {
  /** The room currently connected, if any. Folded into `rooms` on read. */
  readonly room?: string
  /** Whether the overlay should connect on load. Folded into `rooms` on read. */
  readonly enabled?: boolean
  /** Whether the body is collapsed to a title bar. Folded into `rooms` on read. */
  readonly collapsed?: boolean
  /** Last dragged position of the single-window era. */
  readonly place?: { readonly x: number; readonly y: number } | null
  /** Every monitored room, in display order. */
  readonly rooms?: readonly SavedRoom[]
  /**
   * Rooms this browser has opened before, newest first.
   *
   * A history rather than a session: a room removed from monitoring stays here so
   * it can be reopened from the ball without typing its number again. Reconnecting
   * is a deliberate act, so a reload never resumes a room that was being watched.
   */
  readonly recentRooms?: readonly SavedRoom[]
  /** Ball diameter in pixels. */
  readonly ballSize?: number
  /** Window width in pixels. */
  readonly windowWidth?: number
  /** Window height in pixels; a minimized window ignores it. */
  readonly windowHeight?: number
  /** Where the ball sits, in viewport coordinates; null keeps the default corner. */
  readonly ballPlace?: { readonly x: number; readonly y: number } | null
  /**
   * Zoom applied to the contents of a window, as a percentage.
   *
   * It scales what is drawn inside the card, never the card itself: the window
   * size stays a dragged length, so the two settings stay independent. The
   * default of 100 draws at the size CSS declares, which is already multiplied by
   * the browser's own page zoom, and that is what keeps an untouched profile
   * following the page.
   */
  readonly uiScale?: number
  /**
   * Identifies the Host process that wrote the state.
   *
   * A temporary title is meant to last until dsh restarts, so it is dropped when
   * this differs from the running Host: the alias belongs to the session that
   * made it, not to the room. The value only has to change between processes,
   * which the Host's boot time does.
   */
  readonly host?: string
}

/** Credential availability, as reported by the Host. */
export interface Credential {
  readonly ok: boolean
  /** Whether the file holds both tokens; says nothing about whether they work. */
  readonly configured: boolean
  readonly hasSessdata?: boolean
  readonly hasCsrf?: boolean
  /**
   * Whether Bilibili accepted the stored session.
   *
   * A populated credential with an expired session reads `no` here while
   * `configured` stays true, which is the state worth warning about.
   */
  readonly valid?: 'yes' | 'no' | 'unknown'
  /** Account name, present only when the session was accepted. */
  readonly uname?: string
  /** Why the session was rejected, as the Host worded it. */
  readonly reason?: string
  /**
   * A stable name for that condition, which is what the page word its own text from.
   *
   * The page cannot word a notice from `reason`: that string is written for whoever
   * reads a log, and a login method added later will supply its own reasons. The code
   * is therefore the contract, and `reason` stays as the fallback for a code this
   * build does not know, so a page that is a version behind still says something true.
   */
  readonly code?: string
  readonly error?: string
}

/** Server-side limits that shape rendering. */
export interface RemoteConfig {
  readonly historyLimit: number
  readonly statsIntervalMs: number
  readonly defaultRoom: string
  readonly autoConnect: boolean
  /** Whether the page checks the stored login when it loads. */
  readonly checkCredentialOnLoad?: boolean
  /** Identifies the Host process, so a temporary title can expire with it. */
  readonly boot?: string
}

/**
 * Read the persisted layout.
 *
 * @returns the saved state, or an empty object when nothing usable is stored.
 */
export function loadState(): SavedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as SavedState) : {}
  } catch {
    return {}
  }
}

/**
 * Persist the layout and announce the write.
 *
 * `localStorage.setItem` raises a `storage` event in every other document of the
 * origin but never in the one that wrote it, and the settings page and the
 * overlay share one document. Dispatching our own event is what lets a slider
 * take effect on the running overlay without a reload.
 *
 * @param next - the state to store.
 */
export function saveState(next: SavedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* storage may be unavailable in a private window */
  }
  window.dispatchEvent(new Event(STATE_EVENT))
}

/**
 * Subscribe to layout writes made by this document or another one.
 *
 * @param listener - called after a write has landed in storage.
 * @returns the unsubscribe function.
 */
export function onStateChange(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === STORAGE_KEY) listener()
  }
  window.addEventListener(STATE_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(STATE_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** Window width a profile starts with before anyone resizes it. */
export const DEFAULT_WINDOW_WIDTH = 320

/**
 * How many past rooms the browser remembers.
 *
 * The menu is a shortlist, not an archive: beyond a dozen entries the list is
 * longer than the screen and the rooms a user actually returns to are buried
 * under ones they opened once.
 */
export const RECENT_ROOM_LIMIT = 12

/**
 * Fold one room into a recent-room list, newest first.
 *
 * @param recent - the current history.
 * @param entry - the room to move to the front.
 * @returns a new list with no duplicate ids, capped at `RECENT_ROOM_LIMIT`.
 */
export function withRecentRoom(
  recent: readonly SavedRoom[] | undefined,
  entry: SavedRoom,
): readonly SavedRoom[] {
  const room = entry.room.trim()
  if (room === '') return recent ?? []
  const rest = (recent ?? []).filter((item) => item.room !== room)
  return [entry, ...rest].slice(0, RECENT_ROOM_LIMIT)
}

/** Narrowest window that still fits a nickname, a badge and a message. */
export const MIN_WINDOW_WIDTH = 240

/** Widest window allowed, so one card cannot cover the whole viewport. */
export const MAX_WINDOW_WIDTH = 720

/** Window height a profile starts with before anyone resizes it. */
export const DEFAULT_WINDOW_HEIGHT = 300

/** Shortest window that still shows a few rows beside the reply row. */
export const MIN_WINDOW_HEIGHT = 180

/** Tallest window allowed, leaving room for the page around it. */
export const MAX_WINDOW_HEIGHT = 760

/** Zoom a profile starts with, which draws the contents at their declared size. */
export const DEFAULT_UI_SCALE = 100

/**
 * Smallest accepted zoom.
 *
 * The range is deliberately wider than the comfortable one. A small number is a
 * legitimate answer for a packed screen, so the slider allows it and the settings
 * page warns instead of refusing the value.
 */
export const MIN_UI_SCALE = 50

/** Largest accepted zoom, symmetric with {@link MIN_UI_SCALE}. */
export const MAX_UI_SCALE = 300

/** Above this zoom the settings page warns that rows become tall and rare. */
export const COMFORTABLE_UI_SCALE_MAX = 150

/** Below this zoom the settings page warns that text becomes hard to read. */
export const COMFORTABLE_UI_SCALE_MIN = 80

/**
 * Clamp a stored zoom into its allowed range.
 *
 * @param value - a possibly stored zoom, as a percentage.
 * @returns the zoom, rounded to a whole percent.
 */
export function clampScale(value: unknown): number {
  const scale = Number(value)
  if (!Number.isFinite(scale)) return DEFAULT_UI_SCALE
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Math.round(scale)))
}

/**
 * Clamp a stored pixel length into its allowed range.
 *
 * @param value - a possibly stored length.
 * @param fallback - the value to use when nothing usable is stored.
 * @param min - the smallest accepted length.
 * @param max - the largest accepted length.
 * @returns the length, rounded and clamped.
 */
export function clampLength(value: unknown, fallback: number, min: number, max: number): number {
  const size = Number(value)
  if (!Number.isFinite(size)) return fallback
  return Math.min(max, Math.max(min, Math.round(size)))
}

/**
 * Fetch the overlay's server-side limits.
 *
 * @returns the limits, with conservative defaults when the route is unavailable.
 */
export async function fetchConfig(): Promise<RemoteConfig> {
  try {
    const response = await fetch(`${BASE}/api/config`)
    const data = (await response.json()) as Partial<RemoteConfig> | null
    return {
      historyLimit: Number(data?.historyLimit) > 0 ? Number(data?.historyLimit) : 200,
      statsIntervalMs: Number(data?.statsIntervalMs) > 0 ? Number(data?.statsIntervalMs) : 60_000,
      defaultRoom: String(data?.defaultRoom ?? ''),
      autoConnect: Boolean(data?.autoConnect),
    }
  } catch {
    return { historyLimit: 200, statsIntervalMs: 60_000, defaultRoom: '', autoConnect: false }
  }
}

/**
 * Fetch credential availability.
 *
 * @returns the flags, or a "not ready" result when the Host route is missing.
 */
export async function fetchCredential(): Promise<Credential> {
  try {
    const response = await fetch(`${BASE}/api/credential`)
    return (await response.json()) as Credential
  } catch {
    // A failed request is not a missing credential. Reporting it as `configured:
    // false` would word a notice telling the reader to configure something they may
    // already have, so the code says the Host could not be asked and the notice layer
    // stays quiet instead of guessing.
    return { ok: false, configured: false, code: 'unreachable' }
  }
}

/**
 * Fetch the recent window of a room's danmaku.
 *
 * The Host also reports the interval its shared poller is currently using. The
 * page polls that often and no faster: the Host owns the upstream rate, so a
 * hardcoded page interval would either lag behind a healthy poller or keep
 * hammering a room whose poller has backed off.
 *
 * @param room - the room id.
 * @returns the items, oldest first, plus the interval to poll at.
 */
export async function fetchHistory(
  room: string,
): Promise<{ items: Item[]; intervalMs: number }> {
  try {
    const response = await fetch(`${BASE}/api/history?room=${encodeURIComponent(room)}`)
    const data = (await response.json()) as { items?: Item[]; intervalMs?: number } | null
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      intervalMs: Number(data?.intervalMs ?? 0),
    }
  } catch {
    return { items: [], intervalMs: 0 }
  }
}

/**
 * Fetch the current viewer count.
 *
 * @param room - the room id.
 * @returns the count, or `null` when it could not be read.
 */
export async function fetchStats(room: string): Promise<number | null> {
  try {
    const response = await fetch(`${BASE}/api/stats?room=${encodeURIComponent(room)}`)
    const data = (await response.json()) as { ok?: boolean; online?: number } | null
    if (!data || data.ok === false) return null
    const online = Number(data.online)
    return Number.isFinite(online) ? online : null
  } catch {
    return null
  }
}

/**
 * Send one danmaku.
 *
 * @param room - the room id.
 * @param text - the message body.
 * @returns whether it was accepted, and any error the Host reported.
 */
export async function sendReply(
  room: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, text }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    return { ok: Boolean(data.ok), error: data.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : undefined }
  }
}

/**
 * Convert a Bilibili RGB integer into a CSS colour.
 *
 * The live player draws danmaku on a dark video, so the default colour is pure
 * white. Rendered on the overlay's light card that colour is invisible, so a
 * colour too close to white falls back to `null`, which lets the row use the
 * theme's own text colour. Any darker colour the sender chose is kept.
 *
 * @param value - the integer from the message.
 * @returns a `#rrggbb` string, or `null` when the colour is unset or too light to read.
 */
export function colorOf(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const red = (value >> 16) & 0xff
  const green = (value >> 8) & 0xff
  const blue = value & 0xff
  // Rec. 601 luma: green dominates perceived brightness, so a plain channel
  // average would keep a saturated yellow that the eye reads as near white.
  const luma = (red * 299 + green * 587 + blue * 114) / 1000
  if (luma > 0.86 * 255) return null
  return '#' + value.toString(16).padStart(6, '0')
}
