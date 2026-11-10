/**
 * Page-side state and transport helpers.
 *
 * The overlay talks to its own Host routes only, so every call here is
 * same-origin. Persistence is `localStorage` and holds layout preferences — a
 * room id, a position, whether it is open — never a credential.
 */

/** Where the overlay persists its layout choices. */
const STORAGE_KEY = 'dsh-bili-danmaku-overlay'

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

/** Layout choices that survive a reload. */
export interface SavedState {
  /** The room currently connected, if any. */
  readonly room?: string
  /** Whether the overlay should connect on load. */
  readonly enabled?: boolean
  /** Whether the body is collapsed to a title bar. */
  readonly collapsed?: boolean
  /** Last dragged position, in viewport coordinates. */
  readonly place?: { readonly x: number; readonly y: number } | null
}

/** Credential availability, as reported by the Host. */
export interface Credential {
  readonly ok: boolean
  readonly configured: boolean
  readonly hasSessdata?: boolean
  readonly hasCsrf?: boolean
  readonly error?: string
}

/** Server-side limits that shape rendering. */
export interface RemoteConfig {
  readonly historyLimit: number
  readonly statsIntervalMs: number
  readonly defaultRoom: string
  readonly autoConnect: boolean
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
 * Persist the layout.
 *
 * @param next - the state to store.
 */
export function saveState(next: SavedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* storage may be unavailable in a private window */
  }
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
    return { ok: false, configured: false }
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
 * @param value - the integer from the message.
 * @returns a `#rrggbb` string, or `null` when the colour is unset.
 */
export function colorOf(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return '#' + value.toString(16).padStart(6, '0')
}
