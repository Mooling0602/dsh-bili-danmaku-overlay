/**
 * The overlay container.
 *
 * ── Structure ──────────────────────────────────────────────────────────────
 *
 * `shell.overlay` renders in a layer that ignores pointer events, so each card
 * re-enables them on itself. Without that every click passes through to the page
 * underneath and none of the controls work.
 *
 * This component owns no room state. Every room lives in a `RoomStore`, which
 * holds its socket, its history merge and its reconnect state independently of
 * what is on screen. What this file does is the lifecycle: which rooms exist, how
 * the persisted layout maps onto them, and which of them are on screen.
 *
 * That split is what makes the window and the ball safe to treat as views. A
 * window closing does not stop a room; only "stop monitoring" from the ball's
 * menu does, which is why the two actions are separate controls.
 *
 * ── Why the reply path re-reads history ────────────────────────────────────
 *
 * The live socket never echoes your own message back, so a successful send would
 * otherwise be invisible until someone else spoke. The Host cannot mint the real
 * message id, so the page re-reads history a moment later and merges on the id
 * the same way the initial load does.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { CopyKey, Dictionary } from './copy.ts'
import {
  clampLength,
  clampScale,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  fetchConfig,
  fetchCredential,
  loadState,
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  onStateChange,
  RECENT_ROOM_LIMIT,
  saveState,
  sendReply,
  type Credential,
  type RemoteConfig,
  type SavedRoom,
  type SavedState,
  withRecentRoom,
} from './api.ts'
import { FloatingBall, DEFAULT_BALL_SIZE, MIN_BALL_SIZE, MAX_BALL_SIZE, type RoomCandidate } from './ball.tsx'
import { RoomStore, type RoomInstance, type RoomView } from './rooms.ts'
import { DanmakuWindow } from './window.tsx'

/** Props the slot injects. */
export interface OverlayProps {
  readonly t: (key: CopyKey) => string
}

/** How often to re-read the Host boot id, in milliseconds. */
const BOOT_POLL_MS = 30_000

/**
 * Normalise a stored view value.
 *
 * Storage is user-editable and may predate the `hidden` state, so anything
 * unrecognised falls back to a visible window rather than losing the room.
 *
 * @param view - the stored value.
 * @returns a valid view.
 */
function asView(view: unknown): RoomView {
  if (view === 'hidden' || view === 'minimized' || view === 'window') return view
  return 'window'
}

/**
 * Every room the menu can offer, newest first.
 *
 * The list merges the rooms that were being monitored and the rooms this browser
 * opened before, because from the menu's point of view they are the same thing: a
 * room id worth reopening. Ordering puts currently monitored rooms first, then
 * the history, and the `recentRooms` list is authoritative for recency.
 *
 * @param saved - the raw stored state.
 * @returns the rooms to list, without duplicates.
 */
function loadRecent(saved: SavedState): readonly SavedRoom[] {
  const recent: SavedRoom[] = []
  const seen = new Set<string>()
  const push = (entry: SavedRoom): void => {
    const room = entry.room.trim()
    if (room === '' || seen.has(room)) return
    seen.add(room)
    recent.push({ ...entry, room })
  }

  for (const entry of saved.recentRooms ?? []) {
    if (typeof entry?.room === 'string') push(entry)
  }
  for (const entry of restoreRooms(saved)) push(entry)

  return recent.slice(0, RECENT_ROOM_LIMIT)
}

/**
 * Read the stored layout as a room list.
 *
 * Older saves hold a single `room` and a `collapsed` flag; they are folded into
 * the list form so an upgrade does not lose a room the user opened before.
 *
 * @param saved - the raw stored state.
 * @returns the rooms, without duplicates.
 */
function restoreRooms(saved: SavedState): SavedRoom[] {
  const rooms: SavedRoom[] = []
  const seen = new Set<string>()
  const push = (entry: SavedRoom): void => {
    const room = entry.room.trim()
    if (room === '' || seen.has(room)) return
    seen.add(room)
    rooms.push({ ...entry, room })
  }

  if (Array.isArray(saved.rooms)) {
    for (const entry of saved.rooms) {
      if (typeof entry?.room !== 'string') continue
      push({
        room: entry.room,
        view: asView(entry.view),
        alias: typeof entry.alias === 'string' ? entry.alias : '',
        liveTitle: typeof entry.liveTitle === 'string' ? entry.liveTitle : '',
        uname: typeof entry.uname === 'string' ? entry.uname : '',
        place: entry.place ?? null,
      })
    }
  }

  // Single-window saves: adopt the room, honouring the old collapse flag.
  if (typeof saved.room === 'string' && saved.room.trim() !== '' && saved.enabled === true) {
    push({
      room: saved.room,
      view: saved.collapsed === true ? 'minimized' : 'window',
      alias: '',
      place: saved.place ?? null,
    })
  }

  return rooms
}

/**
 * The overlay.
 *
 * @param props - the bound translator.
 * @returns the room windows plus the floating ball.
 */
export function Overlay(props: OverlayProps) {
  const { t } = props
  const saved = useRef(loadState()).current

  const [config, setConfig] = useState<RemoteConfig>({
    historyLimit: 200,
    statsIntervalMs: 60_000,
    defaultRoom: '',
    autoConnect: false,
  })
  const [credential, setCredential] = useState<Credential | null>(null)
  /**
   * Browser-owned presentation settings.
   *
   * Read from storage and re-read whenever it changes, because the settings page
   * writes these directly. Keeping them in state rather than reading on render
   * gives the overlay a value that is stable between writes and lets a slider
   * take effect without a reload.
   */
  const [front, setFront] = useState(() => readFront(saved))

  useEffect(
    () =>
      onStateChange(() => {
        const stored = loadState()
        const next = readFront(stored)
        // Returning the previous object when nothing relevant moved keeps the
        // overlay from re-rendering on the many writes that only touch rooms.
        setFront((previous) =>
          previous.ballSize === next.ballSize &&
          previous.width === next.width &&
          previous.height === next.height &&
          previous.uiScale === next.uiScale
            ? previous
            : next,
        )
        // The history lives in the same document, so it is re-read here rather than
        // kept in step by hand at every call site that saves a room.
        const reopened = loadRecent(stored)
        setRecent((previous) =>
          previous.length === reopened.length &&
          previous.every((entry, index) => entry.room === reopened[index]?.room)
            ? previous
            : reopened,
        )
      }),
    [],
  )

  const ballSize = front.ballSize
  const windowSize = { width: front.width, height: front.height }
  const [ballPlace, setBallPlace] = useState<{ x: number; y: number } | null>(
    saved.ballPlace ?? null,
  )
  /**
   * Every room this browser can reopen, newest first.
   *
   * Re-read whenever the stored layout changes, because `persist` owns the write:
   * the overlay records a room by saving it, so the menu's copy has to follow the
   * store rather than be maintained beside it.
   */
  const [recent, setRecent] = useState<readonly SavedRoom[]>(() => loadRecent(saved))
  const [menuOpen, setMenuOpen] = useState(false)

  /**
   * The live stores, keyed by their stable local key.
   *
   * A ref rather than state: the stores outlive renders and are subscribed to
   * individually, so re-rendering this component must not recreate them.
   */
  /**
   * The limits the stores read.
   *
   * A ref, not the state value: a store is built once and keeps running across
   * renders, so it has to read through a getter, and the ref has to exist before
   * the first store is created or that store reads undefined.
   */
  const configRef = useRef(config)
  const stores = useRef(new Map<string, RoomStore>())
  const [order, setOrder] = useState<readonly string[]>([])
  const restored = useRef(false)
  const bootSeen = useRef<string>(String(saved.host ?? ''))
  /** The ball's current position, read by `persist` without a stale closure. */
  const placeRef = useRef<{ x: number; y: number } | null>(saved.ballPlace ?? null)

  /**
   * Learn which Host process is serving the page, and expire stale titles.
   *
   * The first sighting only records the id. A later difference means dsh
   * restarted, which is exactly when a temporary title is supposed to lapse: the
   * alias belonged to the process that made it, so every window falls back to the
   * room's own title instead of carrying a name nobody can explain.
   *
   * @param boot - the id the Host reports now.
   */
  const adoptBoot = useCallback((boot: string): void => {
    if (bootSeen.current === boot) return
    const first = bootSeen.current === ''
    bootSeen.current = boot
    if (first) return
    for (const store of stores.current.values()) store.setAlias('')
  }, [])

  // Read the Host's limits once. Opening the configured room is a separate effect
  // because it needs `createRoom`, which is declared after this one.
  useEffect(() => {
    let disposed = false
    void fetchConfig().then((next) => {
      if (disposed) return
      setConfig(next)
      if (next.boot !== undefined) adoptBoot(next.boot)
    })
    return () => {
      disposed = true
    }
  }, [adoptBoot])

  useEffect(() => {
    let disposed = false
    void fetchCredential().then((next) => {
      if (!disposed) setCredential(next)
    })
    return () => {
      disposed = true
    }
  }, [])

  /**
   * Create a store for a room and connect it.
   *
   * @param room - the room id.
   * @param initial - the restored view state.
   * @returns the store, or null when this room is already monitored.
   */
  const createRoom = useCallback(
    (room: string, initial?: Partial<RoomInstance>): RoomStore | null => {
      for (const existing of stores.current.values()) {
        if (existing.getSnapshot().room === room) return null
      }
      // The config is read through a getter so a store always sees the current
      // limits without being rebuilt when a setting changes.
      const store = new RoomStore(room, () => configRef.current, initial)
      stores.current.set(store.getSnapshot().key, store)
      store.connect()
      return store
    },
    [],
  )

  // Nothing is restored to the screen. The stored rooms and the saved history are
  // both candidates the menu offers, and only `autoConnect` opens a room on load,
  // so a reload never resumes a stream the user did not ask for.
  //
  // The flag is set only once the Host's configuration has actually arrived. The
  // first render runs this effect with the placeholder config, whose room is empty,
  // so claiming the one attempt there would make `autoConnect` a setting that never
  // fires.
  useEffect(() => {
    if (restored.current) return
    if (config.defaultRoom === '' && config.autoConnect === false) return
    restored.current = true
    if (config.defaultRoom === '' || !config.autoConnect) return
    const store = createRoom(config.defaultRoom, { view: 'window' })
    if (!store) return
    setOrder((current) => [...current, store.getSnapshot().key])
    // `persist` writes the room into `recentRooms` with the layout, so the menu picks
    // it up through the same state subscription as every other entry.
  }, [config, createRoom])

  // A temporary title belongs to one Host run. When the process behind the page
  // changes, the aliases made in the old run stop applying and every window falls
  // back to the room's own title instead of keeping a stale name forever.
  useEffect(() => {
    const check = async (): Promise<void> => {
      const next = await fetchConfig()
      if (next.boot !== undefined) adoptBoot(next.boot)
    }
    const timer = window.setInterval(() => void check(), BOOT_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  // Persist the live rooms as history, not as a session. A reload never resumes a
  // room that was being watched: connecting is a deliberate act, so the stored
  // rooms become the menu's shortlist and only `autoConnect` opens anything.
  // Reads go through each store's snapshot so the saved list matches what is on
  // screen. `recentRooms` keeps rooms that are no longer monitored, because the
  // point of the list is reopening one after it was stopped.
  const persist = useCallback((nextOrder: readonly string[], nextSize: number) => {
    const rooms: SavedRoom[] = []
    for (const key of nextOrder) {
      const store = stores.current.get(key)
      if (!store) continue
      const snapshot = store.getSnapshot()
      rooms.push({
        room: snapshot.room,
        view: snapshot.view,
        alias: snapshot.alias,
        liveTitle: snapshot.liveTitle,
        uname: snapshot.uname,
        place: snapshot.place,
      })
    }
    // Spread the stored document rather than rebuilding it field by field, because
    // `saveState` replaces the whole document and a field this function forgot would
    // be erased. The settings page owns several of those fields, and reading them
    // back also beats holding a copy here, because a stale copy would overwrite a
    // slider the user has just moved.
    //
    // The four leading properties are the single-room save shape, which is read once
    // and must not be written back: `enabled` is what folds that room in, so keeping
    // it alive would bring a removed room back on the next load. Dropping it here is
    // what ends the transition.
    const { room: _room, enabled: _enabled, collapsed: _collapsed, place: _place, ...kept } = loadState()
    // A live room that the history has not listed yet is new, so it joins at the
    // front. One that is already listed keeps the position it had: re-adding a room
    // on every write would reorder the menu each time a window merely moved.
    let recent = kept.recentRooms
    const listed = new Set((recent ?? []).map((entry) => entry.room))
    for (const entry of rooms) {
      if (listed.has(entry.room)) continue
      listed.add(entry.room)
      recent = withRecentRoom(recent, entry)
    }
    saveState({
      ...kept,
      rooms,
      recentRooms: recent,
      ballSize: nextSize,
      ballPlace: placeRef.current,
      host: bootSeen.current,
    } satisfies SavedState)
  }, [])

  // Rooms notify individually, so the list of keys and the per-room snapshots are
  // joined into one value the render can map over.
  //
  // The cache is not an optimisation: `getSnapshot` must return a referentially
  // stable value, and mapping over the keys builds a fresh array every call. React
  // compares with `Object.is`, so an unstable snapshot makes it re-render forever
  // and the whole overlay fails to mount. Storing the last value and returning it
  // until a room actually notifies keeps the array stable between calls.
  const cache = useRef<readonly RoomInstance[]>([])
  const joinRooms = useCallback((): readonly RoomInstance[] => {
    const next: RoomInstance[] = []
    for (const key of order) {
      const store = stores.current.get(key)
      if (store) next.push(store.getSnapshot())
    }
    const previous = cache.current
    const same =
      previous.length === next.length &&
      previous.every((room, index) => room === next[index])
    if (same) return previous
    cache.current = next
    return next
  }, [order])

  const instances = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const unsubscribes: (() => void)[] = []
        for (const key of order) {
          const store = stores.current.get(key)
          if (store) unsubscribes.push(store.subscribe(listener))
        }
        return () => {
          for (const off of unsubscribes) off()
        }
      },
      [order],
    ),
    joinRooms,
    joinRooms,
  )

  // The room title arrives asynchronously, after the first persist. Without this
  // the cache would stay empty until the user happened to move something, and a
  // reload would fall back to the room number again. Comparing the joined titles
  // keeps every danmaku from writing to storage: the signature only changes when
  // a title or streamer name actually changed.
  const titleSignature = instances
    .map((room) => `${room.room}\u0000${room.liveTitle}\u0000${room.uname}`)
    .join('\u0001')
  useEffect(() => {
    persist(order, ballSize)
  }, [titleSignature, order, ballSize, persist])

  const addRoom = useCallback(
    (room: string) => {
      const value = room.trim()
      if (value === '') return
      const store = createRoom(value, { view: 'window' })
      if (!store) return
      setOrder((current) => {
        const next = [...current, store.getSnapshot().key]
        // `persist` folds the new room into `recentRooms` as part of the same write,
        // so the menu and the stored history cannot disagree about it.
        persist(next, ballSize)
        return next
      })
    },
    [createRoom, persist, ballSize],
  )

  const removeRoom = useCallback(
    (key: string) => {
      const store = stores.current.get(key)
      if (store) {
        store.dispose()
        stores.current.delete(key)
      }
      setOrder((current) => {
        const next = current.filter((entry) => entry !== key)
        persist(next, ballSize)
        return next
      })
    },
    [persist, ballSize],
  )

  const setView = useCallback(
    (key: string, view: RoomView) => {
      const store = stores.current.get(key)
      if (!store) return
      store.setView(view)
      persist(order, ballSize)
    },
    [order, persist, ballSize],
  )

  const renameRoom = useCallback(
    (key: string, alias: string) => {
      const store = stores.current.get(key)
      if (!store) return
      store.setAlias(alias.slice(0, 40))
      persist(order, ballSize)
    },
    [order, persist, ballSize],
  )

  const dragRoom = useCallback(
    (key: string, place: { x: number; y: number }) => {
      const store = stores.current.get(key)
      if (!store) return
      store.setPlace(place)
      persist(order, ballSize)
    },
    [order, persist, ballSize],
  )

  const showAll = useCallback(() => {
    for (const key of order) stores.current.get(key)?.setView('window')
    persist(order, ballSize)
  }, [order, persist, ballSize])

  const hideAll = useCallback(() => {
    // Folds every room into the ball, matching the menu wording ("all into the ball").
    for (const key of order) stores.current.get(key)?.setView('hidden')
    persist(order, ballSize)
  }, [order, persist, ballSize])

  const refreshRoom = useCallback((key: string) => {
    const store = stores.current.get(key)
    if (!store) return
    store.disconnect()
    store.connect()
  }, [])

  const canReply = Boolean(credential?.configured && credential.hasCsrf)
  const replyReason = !credential
    ? ''
    : credential.ok === false
      ? t('hostNotReady')
      : !credential.configured
        ? (credential.error ?? t('noCredential'))
        : !credential.hasCsrf
          ? t('credentialHint')
          : ''

  const sendTo = useCallback(
    async (room: string, text: string) => {
      const result = await sendReply(room, text)
      if (!result.ok) return result
      // The socket does not echo your own message, so re-read history after a beat
      // to render it with the real nickname instead of leaving it invisible.
      for (const store of stores.current.values()) {
        if (store.getSnapshot().room === room) store.refreshHistory()
      }
      return result
    },
    [],
  )

  // Minimized windows that were never dragged take successive slots above the
  // ball; the count resets per render so closing one closes its gap.
  let slot = 0

  // The menu lists what can be reopened. A live room is labelled with what its
  // window shows, a room only known from history with what was cached, and a room
  // known only by its id falls back to the number.
  const candidates: RoomCandidate[] = []
  const listed = new Set<string>()
  for (const instance of instances) {
    listed.add(instance.room)
    candidates.push({
      room: instance.room,
      label: instance.alias || instance.liveTitle || instance.uname || '',
      live: true,
    })
  }
  for (const entry of recent) {
    if (listed.has(entry.room)) continue
    listed.add(entry.room)
    candidates.push({
      room: entry.room,
      label: entry.alias || entry.liveTitle || entry.uname || '',
      live: false,
    })
  }

  return (
    <>
      {/* A hidden room is folded into the ball: no window, no strip, but still live. */}
      {instances.filter((instance) => instance.view !== 'hidden').map((instance) => (
        <DanmakuWindow
          key={instance.key}
          t={t}
          instance={instance}
          canReply={canReply && instance.room !== ''}
          replyReason={replyReason}
          onSend={(text) => sendTo(instance.room, text)}
          onClose={() => setView(instance.key, 'hidden')}
          onMinimize={() => setView(instance.key, 'minimized')}
          onRestore={() => setView(instance.key, 'window')}
          onRefresh={() => refreshRoom(instance.key)}
          onRename={(alias) => renameRoom(instance.key, alias)}
          onDragEnd={(place) => dragRoom(instance.key, place)}
          onScrolled={(atBottom) => {
            stores.current.get(instance.key)?.setStickToBottom(atBottom)
          }}
          follow={instance.follow}
          slot={instance.place === null && instance.view === 'minimized' ? slot++ : 0}
          ballSize={ballSize}
          width={windowSize.width}
          height={windowSize.height}
          uiScale={front.uiScale}
          onResizeEnd={(size) => {
            saveState({ ...loadState(), windowWidth: size.width, windowHeight: size.height })
          }}
        />
      ))}
      <FloatingBall
        t={t}
        rooms={instances}
        candidates={candidates}
        configuredRoom={config.defaultRoom}
        size={ballSize}
        uiScale={front.uiScale}
        open={menuOpen}
        onToggleMenu={() => setMenuOpen((value) => !value)}
        onShowWindow={(key) => setView(key, 'window')}
        onHideWindow={(key) => setView(key, 'hidden')}
        onRemove={removeRoom}
        onRename={renameRoom}
        onAddRoom={addRoom}
        onShowAll={showAll}
        onHideAll={hideAll}
        place={ballPlace}
        onDragEnd={(place) => {
          placeRef.current = place
          setBallPlace(place)
          persist(order, ballSize)
        }}
      />
    </>
  )
}

/**
 * @param value - a possibly stored ball size.
 * @returns the size, clamped into the allowed range.
 */
function clampBall(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BALL_SIZE
  return Math.min(MAX_BALL_SIZE, Math.max(MIN_BALL_SIZE, Math.round(value)))
}

/** Presentation settings the browser owns, already clamped. */
interface FrontSettings {
  readonly ballSize: number
  readonly width: number
  readonly height: number
  readonly uiScale: number
}

/**
 * Read the browser-owned presentation settings out of a stored state.
 *
 * @param saved - the stored state.
 * @returns the settings, with every value clamped into its allowed range.
 */
function readFront(saved: SavedState): FrontSettings {
  return {
    ballSize: clampBall(saved.ballSize),
    width: clampLength(saved.windowWidth, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
    height: clampLength(saved.windowHeight, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT),
    uiScale: clampScale(saved.uiScale),
  }
}

/** Dictionary shape the slot expects. */
export type { Dictionary }
