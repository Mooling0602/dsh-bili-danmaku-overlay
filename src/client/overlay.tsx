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
import {
  FloatingBall,
  DEFAULT_BALL_SIZE,
  MIN_BALL_SIZE,
  MAX_BALL_SIZE,
  type MenuBox,
  type RoomCandidate,
} from './ball.tsx'
import { Dialog, type DialogSpec } from './dialog.tsx'
import { QrLoginDialog } from './qrdialog.tsx'
import { credentialNotice } from './notices.ts'
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
    checkCredentialOnLoad: true,
  })
  const [credential, setCredential] = useState<Credential | null>(null)
  /**
   * The notice currently raised over the page, or null when none is.
   *
   * A notice is raised by an action rather than by the credential's state alone.
   * Dimming the page the moment a session is found stale would interrupt a reader
   * who opened dsh to do something unrelated, so the menu row is what asks for the
   * explanation, and this holds the answer while it is open.
   */
  const [notice, setNotice] = useState<DialogSpec | null>(null)

  /**
   * Whether the sign-in surface is showing.
   *
   * Its two states are independent: the surface can be closed while the Host still
   * holds a live key, and the notice below can close while the surface stays open. That
   * is deliberate, because dismissing the explanation is not the same decision as
   * abandoning the scan.
   */
  const [qrOpen, setQrOpen] = useState(false)

  /**
   * Swap the notice for the sign-in surface.
   *
   * The notice closes here rather than in the action handler, because the action is
   * marked as replacing its own notice: the layer stands aside and leaves the swap in
   * one place.
   */
  const openQrLogin = useCallback((): void => {
    setNotice(null)
    setQrOpen(true)
  }, [])
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
  /**
   * The size the ball menu was dragged to, or null while it is untouched.
   *
   * This is deliberately not persisted. The menu is a transient surface the reader
   * opens to pick a room, and a size that survived a reload would leave it opening
   * at a shape nobody could explain, because the drag that produced it belongs to a
   * moment rather than to a preference. The danmaku windows keep their size because
   * they stay on screen; the menu does not.
   */
  const [menuBox, setMenuBox] = useState<MenuBox | null>(null)
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

  /**
   * Re-read the credential, and keep the menu's reading current.
   *
   * The check is a real upstream call, so it is not put on a timer: a session
   * does not expire between two breaths, and a background poll would cost a
   * request per interval for an answer that changes rarely. Opening the menu is
   * the moment the user is asking about it, so that is when it refreshes, along
   * with the once-per-load read that fills the reply box.
   */
  const refreshCredential = useCallback((): void => {
    void fetchCredential().then((next) => setCredential(next))
  }, [])

  /**
   * Re-read the credential after a completed sign-in.
   *
   * The surface has just replaced the stored login, so the menu's row and the reply box
   * have to see the new one; without this they keep reporting the condition that made
   * the reader reach for the sign-in in the first place.
   */
  const afterSignIn = useCallback((): void => {
    refreshCredential()
  }, [refreshCredential])

  /**
   * The load-time check, which is also the only place a notice is raised on its own.
   *
   * It waits for the Host's configuration before deciding, because the flag that
   * enables it arrives over the same fetch: raising the notice first and withdrawing
   * it once the settings say otherwise would flash a modal at a reader who turned the
   * behaviour off. Waiting for the flag also means a Host that never answers simply
   * never raises one, instead of the page guessing.
   *
   * It also requires `autoConnect`. This notice exists because an unusable credential
   * makes something the overlay does by itself fail with no visible cause, and with
   * automatic connection off the overlay does nothing on load: a reader who has not
   * opened a room has nothing failing in front of them, so interrupting them with a
   * modal asks them to fix a problem they did not encounter. The menu's credential row
   * still reports the same condition the moment they open it, so the report is waiting
   * rather than withheld.
   */
  useEffect(() => {
    if (config.checkCredentialOnLoad !== true) return
    if (config.autoConnect !== true) return
    let disposed = false
    void fetchCredential().then((next) => {
      if (disposed) return
      setCredential(next)
      // Only an unusable credential raises this. `unknown` means the check could not
      // reach Bilibili, which is not the reader's to fix and must not send them off
      // to replace a working token.
      const spec = credentialNotice({ credential: next, t, onQrLogin: openQrLogin })
      if (spec !== null) setNotice(spec)
    })
    return () => {
      disposed = true
    }
  }, [config.checkCredentialOnLoad, config.autoConnect, t])

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

  /**
   * Drop one room from the recent list.
   *
   * This cannot go through `persist`, because that function folds every monitored room
   * back into `recentRooms` as a side effect of saving the layout, which would undo the
   * removal for a room that is still monitored. The list it writes has to be the list
   * minus this room, whatever is currently open.
   *
   * @param room - the room id to forget.
   */
  const forgetRoom = useCallback((room: string) => {
    const saved = loadState()
    const next = (saved.recentRooms ?? []).filter((entry) => entry.room !== room)
    saveState({ ...saved, recentRooms: next })
    setRecent((previous) => previous.filter((entry) => entry.room !== room))
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
            // A left-edge drag moves the card as well as resizing it, so the place has
            // to be written back or the card would jump to its old x on the next render.
            if (size.place !== null && size.place !== instance.place) dragRoom(instance.key, size.place)
          }}
        />
      ))}
      <FloatingBall
        t={t}
        rooms={instances}
        candidates={candidates}
        configuredRoom={config.defaultRoom}
        credential={credential}
        menuBox={menuBox}
        onMenuResize={setMenuBox}
        size={ballSize}
        uiScale={front.uiScale}
        open={menuOpen}
        onToggleMenu={() => {
          // Opening the menu is the moment the user is asking about the login, so
          // the reading is refreshed then rather than left as it was at load.
          setMenuOpen((value) => {
            if (!value) refreshCredential()
            return !value
          })
        }}
        onShowWindow={(key) => setView(key, 'window')}
        onHideWindow={(key) => setView(key, 'hidden')}
        onRemove={removeRoom}
        onRename={renameRoom}
        onAddRoom={addRoom}
        onForgetRoom={forgetRoom}
        onShowAll={showAll}
        onHideAll={hideAll}
        place={ballPlace}
        onDragEnd={(place) => {
          placeRef.current = place
          setBallPlace(place)
          persist(order, ballSize)
        }}
        onCredentialClick={() => {
          // The menu already knows which condition it is describing, so the notice
          // is built from the same reading rather than re-fetching a second one.
          const spec = credentialNotice({ credential, t, onQrLogin: openQrLogin })
          if (spec !== null) setNotice(spec)
        }}
      />
      <Dialog
        spec={notice}
        onClose={() => setNotice(null)}
        uiScale={front.uiScale}
        t={t}
      />
      <QrLoginDialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        uiScale={front.uiScale}
        t={t}
        existingUname={credential?.scanned?.uname ?? credential?.uname}
        onSignedIn={afterSignIn}
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
