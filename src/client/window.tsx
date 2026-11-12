/**
 * One room's floating window.
 *
 * ── What a window is ───────────────────────────────────────────────────────
 *
 * The window is a view over a `RoomStore`, never the owner of its state: closing
 * the window, or putting it into the ball, keeps the store and its socket alive.
 * Only "stop monitoring" from the ball's menu disposes a room, which is what
 * makes closing a window safe to do casually.
 *
 * ── Why minimized keeps a line of text ─────────────────────────────────────
 *
 * A minimized window still answers "is this room alive and what is it saying".
 * The dot carries the connection state and the newest line carries the content,
 * so a glance is enough. The title bar returns when new danmaku arrives or the
 * window is touched, which is why the idle threshold is a few seconds rather than
 * a minute: live danmaku goes stale fast.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { CopyKey } from './copy.ts'
import {
  clampLength,
  colorOf,
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type Item,
} from './api.ts'
import { CloseIcon, MinimizeIcon, RefreshIcon, RestoreIcon } from './icons.tsx'
import { stateTone } from './rooms.ts'
import type { RoomInstance, RoomState } from './rooms.ts'

/** How long a minimized window keeps showing the newest line before its title returns. */
const IDLE_FADE_MS = 5_000

/**
 * Vertical distance between two stacked minimized windows, in pixels.
 *
 * A minimized window is exactly its title bar, so the step is that bar's height plus
 * a small gap. It keeps the stack reading as separate cards instead of one merged
 * block, and keeps every bar reachable with the pointer.
 */
const MINIMIZED_STEP = 42

/** Longest title accepted from the user. */
const MAX_TITLE = 40

/** Pointer travel, in pixels, that separates a drag from a press that only selects. */
const DRAG_SLOP = 4

/** Largest gap between two still presses on the title that counts as a double click. */
const DOUBLE_CLICK_MS = 400

/**
 * Smallest gap kept between a card and the edge of the screen.
 *
 * A drag already leaves this much, and a resize obeys the same number so a card cannot
 * be widened until it touches the edge and then be unable to be dragged back.
 */
const EDGE_MARGIN = 4

/**
 * The two strokes drawn in the resize grip.
 *
 * The strokes gather towards the corner the grip sits in, so a grip that has swapped
 * sides has them drawn into its own corner rather than up into the middle of the card.
 * A gradient angle points at the end of its line and the strokes sit past the halfway
 * stop, which is why the left corner needs the opposite angle rather than a mirrored one.
 *
 * @param leftwards - whether the grip sits in the left corner.
 * @returns a CSS `background` value for the grip.
 */
function grips(leftwards: boolean): string {
  const color = 'var(--dsw-alias-label-tertiary, #bbb)'
  const angle = leftwards ? '225deg' : '135deg'
  return `linear-gradient(${angle}, transparent 45%, ${color} 45%, ${color} 55%, transparent 55%), linear-gradient(${angle}, transparent 68%, ${color} 68%, ${color} 78%, transparent 78%)`
}

/** Longest summary line in a minimized window, in characters. */
const MIN_SUMMARY_CHARS = 48

/**
 * Longest nickname that keeps its full width.
 *
 * A name up to this many characters is shown in full and never competes with the
 * message for room. Only a longer one starts to shrink, which is what keeps an
 * ordinary nickname reading as a name rather than as an ellipsis.
 */
const MAX_NAME_CHARS = 8

/** How much of a row a shrinking nickname may take. */
const MAX_NAME_FRACTION = '40%'

/** Props for one window. */
export interface WindowProps {
  readonly t: (key: CopyKey) => string
  readonly instance: RoomInstance
  readonly canReply: boolean
  readonly replyReason: string
  readonly onSend: (text: string) => Promise<{ ok: boolean; error?: string }>
  readonly onClose: () => void
  readonly onMinimize: () => void
  readonly onRestore: () => void
  readonly onRefresh: () => void
  readonly onRename: (alias: string) => void
  readonly onDragEnd: (place: { x: number; y: number }) => void
  readonly onScrolled: (atBottom: boolean) => void
  /** Whether the list should follow the newest row. */
  readonly follow: boolean
  /**
   * How many minimized windows sit between this one and the corner.
   *
   * Minimized windows that were never dragged would otherwise all land on the
   * same corner, hiding each other and the ball. The container hands out a slot so
   * they stack instead.
   */
  readonly slot: number
  /** Height the ball occupies, so the stack clears it. */
  readonly ballSize: number
  /** Card width in pixels. */
  readonly width: number
  /** Card height in pixels. */
  readonly height: number
  /**
   * Zoom for the card's contents, as a percentage of their declared size.
   *
   * It scales what is drawn inside the card and never the card itself, so the two
   * sizes stay independent: a user can enlarge the text without the window
   * covering more of the page. At 100 the contents draw at their declared size,
   * which CSS already multiplies by the browser's page zoom.
   */
  readonly uiScale: number
  /**
   * Called when a resize gesture ends.
   *
   * Only the release is reported: a per-frame callback would write to storage on
   * every pointer move and make the drag stutter. The place is part of the result
   * because dragging the left or right edge moves that edge, so a size alone would
   * make the card jump sideways on the next render.
   */
  readonly onResizeEnd: (size: { width: number; height: number; place: { x: number; y: number } | null }) => void
}

/**
 * Multiply one interior length by the zoom and keep it a whole pixel.
 *
 * A zoomed value is rounded and held at a minimum of one pixel so a hairline gap
 * or a border radius never collapses into nothing at a small zoom, and never
 * arrives as a fractional length that two browsers would round differently.
 *
 * @param value - the length as written for a zoom of 100.
 * @param scale - the zoom as a factor, where 1 draws the length as written.
 * @returns the length to render.
 */
function px(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale))
}

/**
 * One danmaku row.
 *
 * @param props - the item, the localized super-chat label and the zoom factor.
 * @returns the row.
 */
function Row(props: { readonly item: Item; readonly superChatLabel: string; readonly scale: number }) {
  const { item } = props
  const sp = (value: number): number => px(value, props.scale)
  const color = item.kind === 'enter' ? null : colorOf(item.color)
  // A Bilibili nickname may reach 20 characters, which is most of a 320px window
  // before a medal or a message is considered. Only a name past the limit is
  // allowed to shrink, so an ordinary one keeps its full width and reads as a name.
  const longName = [...item.user].length > MAX_NAME_CHARS
  // The three parts of a row share one line box, so the badges, the nickname and
  // the message all take the same scaled line height. A row that scaled its font
  // but not its line height would clip a descender at a large zoom.
  const lineHeight = `${sp(15)}px`

  return (
    // A wrapped message makes the row taller than its badges, and a flex row
    // stretches every other child to that height by default, which drags a badge
    // border down the whole row. Aligning to the top keeps each chip its own size.
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: sp(6), padding: `${sp(2)}px 0` }}>
      {item.medal ? (
        <span
          style={{
            flex: '0 0 auto',
            maxWidth: '35%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            padding: `0 ${sp(4)}px`,
            borderRadius: sp(3),
            fontSize: sp(10),
            lineHeight,
            border: '1px solid currentColor',
            color: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
          }}
          title={`${item.medal.name}${item.medal.level}`}
        >
          {item.medal.name}
          {item.medal.level}
        </span>
      ) : null}
      {item.kind === 'superchat' && item.price ? (
        <span
          style={{
            flex: '0 0 auto',
            padding: `0 ${sp(4)}px`,
            borderRadius: sp(3),
            fontSize: sp(10),
            lineHeight,
            background: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
            color: '#fff',
          }}
        >
          ¥{item.price}
        </span>
      ) : null}
      <span
        style={{
          // A short name holds its natural width, because it never competes with the
          // message. Only a long one becomes shrinkable, and then only down to the
          // cap, so the text beside it always keeps a readable column.
          flex: longName ? '0 1 auto' : '0 0 auto',
          ...(longName
            ? {
                minWidth: 0,
                maxWidth: MAX_NAME_FRACTION,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap' as const,
              }
            : {}),
          lineHeight,
          color: 'var(--dsw-alias-label-secondary, #888)',
        }}
        title={item.user}
      >
        {item.user}
        {'：'}
      </span>
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          // Pinned so the first text line and the badges beside it share one
          // baseline; a browser default line height is fractional and drifts.
          lineHeight,
          // A danmaku may carry an unbroken run such as a URL, and this column is
          // the only one allowed to wrap. Without it the row overflows the window.
          overflowWrap: 'anywhere',
          color:
            item.kind === 'enter'
              ? 'var(--dsw-alias-label-tertiary, #999)'
              : (color ?? 'var(--dsw-alias-label-primary, #222)'),
        }}
      >
        {item.text}
      </span>
    </div>
  )
}

/**
 * The tooltip the status dot carries.
 *
 * The dot's colour already says roughly how the room is doing; the text says
 * exactly why, which is what the reader needs when the colour is the same for
 * two different situations, such as a room that is off air and one that is off
 * air while its danmaku is being read anyway.
 *
 * @param t - the translator.
 * @param state - the connection state.
 * @param veiled - whether the offline veil is still up.
 * @returns the localized tooltip.
 */
function stateTitle(t: (key: CopyKey) => string, state: RoomState, veiled: boolean): string {
  if (state === 'offline') return veiled ? t('stateOffline') : t('stateOfflineViewing')
  if (state === 'error') return t('stateError')
  if (state === 'live') return t('stateLive')
  if (state === 'connecting' || state === 'reconnecting') return t('stateHistory')
  return t('stateIdle')
}

/**
 * The label a window shows.
 *
 * A user alias wins over the room's own title, and the room id is the last
 * resort: the id is always correct, so the window is never unlabelled.
 *
 * @param instance - the room.
 * @returns the label to render.
 */
export function windowLabel(instance: RoomInstance): string {
  const alias = instance.alias.trim()
  if (alias !== '') return alias
  const title = instance.liveTitle.trim()
  if (title !== '') return title
  return `#${instance.room}`
}

/**
 * One room's window.
 *
 * @param props - the room snapshot and the actions the window offers.
 * @returns the expanded window, or its minimized form.
 */
export function DanmakuWindow(props: WindowProps) {
  const { t, instance } = props
  const [reply, setReply] = useState('')
  const [replyState, setReplyState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(instance.alias)
  const [idle, setIdle] = useState(false)

  const listRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  /**
   * The position while a drag is in flight, before it is committed on release.
   *
   * Dragging writes straight to the DOM so the window follows the pointer without
   * a render per frame. React would otherwise reset `left`/`top` from the store on
   * the next render — and a new danmaku arrives constantly — snapping the window
   * back mid-drag. Holding the in-flight position in state keeps the rendered
   * style and the dragged node in agreement.
   */
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null)
  /** Latest dragged position, so release can commit without re-measuring. */
  const latestRef = useRef<{ x: number; y: number } | null>(null)
  /** Pointer position at pointerdown, used to tell a drag from a click. */
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)
  /**
   * Whether the gesture that just ended actually moved the window. A drag ends
   * with a click event too, and without this the release would be read as a
   * click on whatever the pointer happened to land on.
   */
  const draggedRef = useRef(false)
  /**
   * What the pointer went down on. Pointer capture retargets the click that
   * ends the gesture to the capturing element, so the element under the
   * pointer has to be remembered here rather than read from the click.
   */
  const pressTargetRef = useRef<HTMLElement | null>(null)
  /** Time of the last still press on the title, for recognising a double click. */
  const lastTitlePressRef = useRef(0)
  const idleTimer = useRef(0)

  /**
   * The size a resize gesture has reached so far, or null when not resizing.
   *
   * Held in state for the same reason the drag position is: a new danmaku
   * re-renders the card constantly, and a size written only to the DOM would be
   * reset from `props.width`/`props.height` on the next render. The left coordinate is
   * carried alongside it because a gesture that drags the bottom left grip moves the
   * card as well as resizing it, so both have to land on the same render.
   */
  const [resizing, setResizing] = useState<{
    width: number
    height: number
    left: number | null
  } | null>(null)
  /** Size, fixed edge and the on-screen box at pointerdown. */
  const resizeStartRef = useRef<{
    width: number
    height: number
    x: number
    y: number
    left: number
    top: number
    edge: 'left' | 'right' | 'none'
  } | null>(null)

  /**
   * Whether the reader has opened the danmaku of an offline room.
   *
   * Local on purpose: it is not persisted, so a reload puts the veil back and the
   * window keeps announcing that the room is not streaming.
   */
  const [showOffline, setShowOffline] = useState(false)

  const minimized = instance.view === 'minimized'
  const newest = instance.items[instance.items.length - 1]
  /**
   * Whether the room is known to be off air.
   *
   * The Host reports `offline` on the status event, which is what gives the dot
   * its idle tone. The veil is driven by the same value so the two can never say
   * different things about the same room.
   */
  const offline = instance.state === 'offline'
  /** The veil hides the list and the reply row until the reader asks for them. */
  const veiled = offline && !showOffline

  // A minimized window shows the newest line in place of its title, then falls back
  // to the title once nothing has arrived for a while. The title is the resting state
  // because it names the room; the preview is the transient one because it is only
  // worth reading while it is current.
  useEffect(() => {
    window.clearTimeout(idleTimer.current)
    if (!minimized) {
      setIdle(false)
      return undefined
    }
    setIdle(false)
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_FADE_MS)
    return () => window.clearTimeout(idleTimer.current)
  }, [minimized, instance.lastAt])

  // Stick to the newest row unless the reader scrolled up to read something. The
  // store owns that decision: only it knows whether the last scroll was the user's
  // or the pin's own.
  useEffect(() => {
    const node = listRef.current
    if (!node || !props.follow) return
    node.scrollTop = node.scrollHeight
  }, [instance.items, minimized, props.follow])

  const onScroll = useCallback(() => {
    const node = listRef.current
    if (!node) return
    props.onScrolled(node.scrollHeight - node.scrollTop - node.clientHeight < 48)
  }, [props])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    dragOriginRef.current = { x: event.clientX, y: event.clientY }
    draggedRef.current = false
    pressTargetRef.current = event.target as HTMLElement
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const node = cardRef.current
    if (!node) return
    const origin = dragOriginRef.current
    if (origin === null) return
    const travel = Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y)
    // Below the slop the pointer has not really travelled, so the press still
    // reads as a click on whatever it landed on, such as the title.
    if (travel < DRAG_SLOP) return
    draggedRef.current = true
    const width = node.offsetWidth
    const height = node.offsetHeight
    const x = Math.max(4, Math.min(window.innerWidth - width - 4, event.clientX - dragRef.current.dx))
    const y = Math.max(4, Math.min(window.innerHeight - height - 4, event.clientY - dragRef.current.dy))
    latestRef.current = { x, y }
    setDragging({ x, y })
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    dragOriginRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    // Commit the in-flight position rather than re-measuring the node: the
    // measurement would race the state update that clears the drag.
    const landed = latestRef.current
    latestRef.current = null
    const target = pressTargetRef.current
    pressTargetRef.current = null
    const moved = draggedRef.current
    draggedRef.current = false
    setDragging(null)
    if (landed !== null) props.onDragEnd(landed)
    // A title press that never moved counts toward a double click, which opens
    // the rename input. Reading the gesture here rather than from a click
    // handler keeps it working through pointer capture.
    if (!moved && target !== null && target.closest('[data-rename]') !== null) {
      const now = event.timeStamp
      if (now - lastTitlePressRef.current < DOUBLE_CLICK_MS) {
        lastTitlePressRef.current = 0
        setTitleDraft(instance.alias)
        setEditing(true)
      } else {
        lastTitlePressRef.current = now
      }
    } else {
      lastTitlePressRef.current = 0
    }
  }, [props, instance.alias])

  /**
   * Start a resize from an edge or a corner.
   *
   * Every edge except the top one is draggable, and both bottom corners are too. Only one
   * corner draws the visible strokes, but that is a matter of looks: the other corner and
   * the two side strips resize just the same when grabbed. The top edge is left out
   * because growing upwards would have to move the card's `top` while a title-bar drag
   * also writes it, and two gestures owning one coordinate is what makes a card jump.
   *
   * @param edge - the edge or corner being dragged.
   * @returns the pointerdown handler for that region.
   */
  const onResizeDown = useCallback(
    (edge: 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right') =>
      (event: React.PointerEvent<HTMLDivElement>) => {
        event.stopPropagation()
        const rect = cardRef.current?.getBoundingClientRect()
        resizeStartRef.current = {
          width: props.width,
          height: props.height,
          x: event.clientX,
          y: event.clientY,
          // A card pinned by `right` has no left edge in state, so the on-screen box
          // is measured once here rather than assumed.
          left: rect?.left ?? 0,
          top: rect?.top ?? 0,
          edge: edge === 'left' || edge === 'bottom-left' ? 'left' : edge === 'right' || edge === 'bottom-right' ? 'right' : 'none',
        }
        setResizing({ width: props.width, height: props.height, left: null })
        event.currentTarget.setPointerCapture?.(event.pointerId)
      },
    [props.width, props.height],
  )

  /**
   * Track the pointer during a resize.
   *
   * Dragging the left side grows the card leftwards and moves its left edge, so the size
   * and the place change together; the right side keeps the place and only resizes. The
   * bottom strip changes the height alone. The top edge never moves in any of them, which
   * is why it carries no region: only the height that grows downwards is adjustable there.
   */
  const onResizeMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start) return
    // The card grows until the dragged corner reaches the far side of the screen,
    // whatever its own maximum allows. A card floating in the middle of the page
    // therefore stops at the edge instead of being pulled past it, and a card already
    // against the opposite edge still grows because the corner it drags is the free one.
    //
    // Each corner keeps its opposite edge: growing right holds the left edge, and growing
    // left holds the right edge. The width it may reach is therefore all the room between
    // that fixed edge and the screen.
    // The bottom strip leaves the width alone: grabbing the bottom edge must not also
    // resize sideways, or a slightly diagonal drag would change two sizes at once.
    const sideways = start.edge !== 'none'
    const fixedLeft = start.edge === 'right'
    const roomWidth = fixedLeft
      ? window.innerWidth - start.left - EDGE_MARGIN
      : start.left + start.width - EDGE_MARGIN
    const deltaX = start.edge === 'right' ? event.clientX - start.x : start.x - event.clientX
    const width = sideways
      ? clampLength(
          start.width + deltaX,
          start.width,
          MIN_WINDOW_WIDTH,
          Math.max(MIN_WINDOW_WIDTH, Math.min(MAX_WINDOW_WIDTH, roomWidth)),
        )
      : start.width
    // The top edge stays put, so the height only ever grows downwards and the room it may
    // take is what is left between the card's top and the bottom of the screen.
    const roomHeight = window.innerHeight - start.top - EDGE_MARGIN
    const height = clampLength(
      start.height + (event.clientY - start.y),
      start.height,
      MIN_WINDOW_HEIGHT,
      Math.max(MIN_WINDOW_HEIGHT, Math.min(MAX_WINDOW_HEIGHT, roomHeight)),
    )
    setResizing({
      width,
      height,
      // The edge that stays put is the one the gesture does not touch, so the moving
      // coordinate is derived from the size that was actually applied. Deriving it from
      // the pointer instead would let a clamped size keep drifting past the edge.
      left: start.edge !== 'left' ? null : start.left + start.width - width,
    })
  }, [])

  const onResizeUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = resizeStartRef.current
      if (!start) return
      resizeStartRef.current = null
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      const size = resizing
      setResizing(null)
      if (size === null) return
      // Only a left corner moves the card, and only a card that has been placed has a
      // place to move. A card still on its ball anchor keeps it, because the size change
      // already produces the same motion on screen and pinning a place here would turn a
      // default layout into a fixed one for no reason the reader asked for.
      props.onResizeEnd({
        width: size.width,
        height: size.height,
        place:
          size.left === null || instance.place === null
            ? instance.place
            : { x: size.left, y: instance.place.y },
      })
    },
    [props, resizing, instance.place],
  )

  const submit = useCallback(async () => {
    const text = reply.trim()
    if (text === '' || replyState === 'sending') return
    setReplyState('sending')
    const result = await props.onSend(text)
    if (!result.ok) {
      setReplyState('idle')
      return
    }
    setReply('')
    setReplyState('sent')
    window.setTimeout(() => setReplyState('idle'), 1500)
  }, [reply, replyState, props])

  const tone = stateTone(instance.state)
  // Only a minimized window swaps its title for the newest line, and only while that
  // line is still current. An expanded window has the list itself, so its title stays
  // put and doubles as the rename target.
  const newestLine = newest
    ? `${newest.user}：${truncate(newest.text, MIN_SUMMARY_CHARS)}`
    : ''
  const showPreview = minimized && !idle && newest !== undefined
  // A dragged window keeps its own corner; an untouched one stacks above the ball
  // in its slot, so several minimized rooms read as a list rather than a pile. The
  // step clears a minimized card's whole height, which is its title bar: a taller
  // bar would overlap the next one, and a shorter step would leave a visible gap.
  const settled = dragging ?? instance.place
  /**
   * How much the card's contents are enlarged or shrunk.
   *
   * Only the values drawn inside the card are multiplied by it, because the card
   * itself must keep measuring exactly what the resize gesture asked for: a
   * transform or a zoom on the whole card would rescale its own geometry and make
   * the size stored in pixels disagree with what a drag reports.
   */
  const scale = props.uiScale / 100
  const sp = (value: number): number => px(value, scale)
  const icon = iconOf(scale)
  // A minimized card stacks its slot above the ball, and its height is the title
  // bar, which now scales, so the step has to scale with it or the cards would
  // overlap at a large zoom and leave a gap at a small one.
  // A card that has never been placed is anchored to the ball's corner, so it has no
  // stored top or left to reason about; its on-screen box is measured once instead.
  const live = resizing === null ? { width: props.width, height: props.height } : { width: resizing.width, height: resizing.height }
  const box =
    cardRef.current === null
      ? null
      : { left: cardRef.current.getBoundingClientRect().left, top: cardRef.current.getBoundingClientRect().top }
  /**
   * Which bottom corner carries the grip.
   *
   * The right corner is the default, because that is where a resize grip is expected. The
   * left one is used only when the card is already against the right edge of the screen,
   * since growth that way would have nowhere to go there. It is always a bottom corner:
   * the top edge is not resizable, so a grip there would promise a drag that does not
   * exist.
   *
   * A running gesture keeps the corner it started from, because the card reaching the
   * opposite edge mid-drag would otherwise flip the choice and move the grip out from
   * under the pointer, cutting the gesture short.
   */
  const leftwards =
    resizeStartRef.current === null
      ? box !== null && box.left + live.width > window.innerWidth - EDGE_MARGIN * 2
      : resizeStartRef.current.edge === 'left'
  // A resize from the left corner owns the card's left coordinate, so the gesture's value
  // wins while it lasts; otherwise the settled place or the ball anchor decides it.
  const base =
    settled !== null
      ? { left: settled.x, top: settled.y }
      : minimized
        ? { right: 18, bottom: 18 + 34 + props.ballSize + props.slot * sp(MINIMIZED_STEP) }
        : { right: 18, bottom: 18 + 34 + props.ballSize }
  const position =
    resizing === null || resizing.left === null ? base : { ...base, left: resizing.left }

  return (
    <div
      ref={cardRef}
      style={{
        position: 'fixed',
        ...position,
        zIndex: 59,
        // A minimized window is only its title bar, so a stored height would leave
        // an empty card hanging below it.
        width: live.width,
        height: minimized ? undefined : live.height,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100vh - 24px)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
        background: 'var(--dsw-alias-bg-overlay, #fff)',
        boxShadow: minimized ? '0 4px 16px rgba(0,0,0,.14)' : '0 8px 28px rgba(0,0,0,.16)',
        font: `${sp(12)}px/${1.4} system-ui, -apple-system, sans-serif`,
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: sp(6),
          padding: `${sp(7)}px ${sp(8)}px ${sp(7)}px ${sp(10)}px`,
          // A minimized window has no content below the bar, so the rule that
          // separates them would hang at the bottom edge of the card.
          borderBottom: minimized ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <span
          title={stateTitle(t, instance.state, veiled)}
          style={{
            flex: '0 0 auto',
            width: sp(8),
            height: sp(8),
            borderRadius: 999,
            background: tone,
            boxShadow: instance.state === 'live' ? `0 0 0 ${sp(3)}px ${tone}33` : 'none',
          }}
        />
        {editing ? (
          <input
            autoFocus
            data-no-drag
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value.slice(0, MAX_TITLE))}
            onBlur={() => {
              props.onRename(titleDraft.trim())
              setEditing(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                props.onRename(titleDraft.trim())
                setEditing(false)
              }
              if (event.key === 'Escape') {
                setTitleDraft(instance.alias)
                setEditing(false)
              }
            }}
            placeholder={instance.liveTitle || `#${instance.room}`}
            title={t('renameHint')}
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              padding: `${sp(1)}px ${sp(5)}px`,
              fontSize: sp(12),
              fontWeight: 600,
              borderRadius: sp(5),
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
              background: 'var(--dsw-alias-bg-layer-2, transparent)',
              color: 'var(--dsw-alias-label-primary, #222)',
              outline: 'none',
            }}
          />
        ) : (
          <span
            data-rename
            title={showPreview ? newestLine : t('renameHint')}
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: sp(12),
              // The preview is lighter than the title so the two states stay
              // distinguishable while the layout does not move at all.
              fontWeight: showPreview ? 400 : 600,
              color: showPreview
                ? 'var(--dsw-alias-label-secondary, #666)'
                : 'var(--dsw-alias-label-primary, #222)',
              cursor: dragging ? 'grabbing' : 'grab',
            }}
          >
            {showPreview ? newestLine : windowLabel(instance)}
          </span>
        )}
        {instance.online > 0 ? (
          <span
            title={t('online')}
            style={{
              flex: '0 0 auto',
              fontSize: sp(11),
              color: 'var(--dsw-alias-label-secondary, #888)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {instance.online}
          </span>
        ) : null}
        <button
          type="button"
          data-no-drag
          onClick={props.onRefresh}
          title={t('refresh')}
          style={icon}
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          data-no-drag
          onClick={minimized ? props.onRestore : props.onMinimize}
          title={minimized ? t('expand') : t('minimizeWindow')}
          style={icon}
        >
          {minimized ? <RestoreIcon /> : <MinimizeIcon />}
        </button>
        <button
          type="button"
          data-no-drag
          onClick={props.onClose}
          title={t('hideWindow')}
          style={icon}
        >
          <CloseIcon />
        </button>
      </div>

      {minimized ? null : veiled ? (
        <div
          style={{
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: sp(10),
            padding: `${sp(14)}px ${sp(12)}px`,
            fontSize: sp(12),
            color: 'var(--dsw-alias-label-secondary, #888)',
          }}
        >
          <span>{t('offlineHint')}</span>
          <button
            type="button"
            onClick={() => setShowOffline(true)}
            style={{
              ...icon,
              width: 'auto',
              height: sp(26),
              padding: `0 ${sp(14)}px`,
              fontSize: sp(12),
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
              borderRadius: sp(7),
              color: 'var(--dsw-alias-label-primary, #222)',
              whiteSpace: 'nowrap',
            }}
          >
            {t('viewDanmaku')}
          </button>
        </div>
      ) : (
        <div
          ref={listRef}
          onScroll={onScroll}
          style={{
            flex: '1 1 auto',
            // A floor on the list's height keeps a short window from collapsing it
            // to nothing, but it cannot be a fixed scaled length: at a large zoom the
            // floor would exceed a short card and push the reply row out of view. A
            // percentage floor shrinks with the card instead.
            minHeight: '18%',
            overflowY: 'auto',
            padding: `${sp(6)}px ${sp(10)}px`,
          }}
        >
          {instance.items.length === 0 ? (
            <div
              style={{
                padding: `${sp(14)}px ${sp(4)}px`,
                fontSize: sp(12),
                color: 'var(--dsw-alias-label-tertiary, #999)',
                textAlign: 'center',
              }}
            >
              {instance.notice !== '' ? instance.notice : t('empty')}
            </div>
          ) : instance.items.map((item) => (
            <Row key={item.id} item={item} superChatLabel={t('superchat')} scale={scale} />
          ))}
        </div>
      )}

      {minimized ? null : (
      <div
        data-no-drag
        style={{
          display: 'flex',
          gap: sp(6),
          padding: `${sp(6)}px ${sp(8)}px ${sp(8)}px`,
          borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
        }}
      >
        <input
          value={reply}
          onChange={(event) => setReply(event.target.value.slice(0, 20))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder={
            veiled
              ? t('offlinePlaceholder')
              : props.canReply
                ? t('sendPlaceholder')
                : (props.replyReason || t('sendPlaceholder'))
          }
          maxLength={20}
          disabled={veiled || !props.canReply}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            padding: `${sp(4)}px ${sp(8)}px`,
            fontSize: sp(12),
            borderRadius: sp(7),
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
            background: 'var(--dsw-alias-bg-layer-2, transparent)',
            color: 'var(--dsw-alias-label-primary, #222)',
            outline: 'none',
            opacity: props.canReply ? 1 : 0.6,
          }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={veiled || !props.canReply || replyState === 'sending'}
          style={{
            ...icon,
            width: 'auto',
            padding: `0 ${sp(10)}px`,
            height: sp(24),
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
            borderRadius: sp(7),
            opacity: veiled || !props.canReply ? 0.5 : 1,
            whiteSpace: 'nowrap',
          }}
        >
          {replyState === 'sending' ? t('sending') : replyState === 'sent' ? t('sent') : t('send')}
        </button>
      </div>
      )}
      {minimized ? null : (
        <>
          {/*
            Four regions, three of which are invisible. The side strips and the plain
            bottom edge all resize, because an edge is what the reader aims at and making
            them work is what "the window can be resized" means. Only one corner draws
            strokes, which is a matter of looks and not an indication of where the card
            can be dragged. The top edge has no region at all, so a resize can never write
            `top` while a title-bar drag writes it too.
          */}
          <div
            onPointerDown={onResizeDown('left')}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title={t('resizeHint')}
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: sp(6), cursor: 'ew-resize', touchAction: 'none' }}
          />
          <div
            onPointerDown={onResizeDown('right')}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title={t('resizeHint')}
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: sp(6), cursor: 'ew-resize', touchAction: 'none' }}
          />
          <div
            onPointerDown={onResizeDown('bottom')}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title={t('resizeHint')}
            style={{ position: 'absolute', left: sp(6), right: sp(6), bottom: 0, height: sp(6), cursor: 'ns-resize', touchAction: 'none' }}
          />
          {/*
            Both bottom corners take a two-axis drag, which is why each gets its own square
            laid over the strips. Exactly one of the two draws strokes; the other is
            invisible but responds the same way, because the strokes are a hint rather than
            the extent of what can be grabbed.
          */}
          <div
            onPointerDown={onResizeDown('bottom-left')}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title={t('resizeHint')}
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              width: sp(14),
              height: sp(14),
              cursor: 'nesw-resize',
              touchAction: 'none',
              ...(leftwards ? { background: grips(true) } : {}),
            }}
          />
          <div
            onPointerDown={onResizeDown('bottom-right')}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            title={t('resizeHint')}
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: sp(14),
              height: sp(14),
              cursor: 'nwse-resize',
              touchAction: 'none',
              ...(leftwards ? {} : { background: grips(false) }),
            }}
          />
        </>
      )}
    </div>
  )
}

/**
 * Cut text to a length with an ellipsis.
 *
 * @param text - the source text.
 * @param max - the longest acceptable length.
 * @returns the text, shortened when needed.
 */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** Shared chrome for the small window buttons, drawn at the card's current zoom. */
const iconOf = (scale: number): React.CSSProperties => {
  const sp = (value: number): number => px(value, scale)
  return {
    // A card narrower than its scaled chrome is possible, because the two settings
    // are independent: a 240px window at 300% cannot fit three buttons at their
    // drawn size. The buttons shrink rather than overflow, so a narrow card keeps
    // its close button reachable instead of clipping it at the hidden edge.
    flex: '0 1 auto',
    width: sp(22),
    height: sp(22),
    // At the largest zoom against the narrowest card these three buttons cannot
    // all keep their drawn width, so they give up space down to a third of it and
    // the title gives up its own remainder first. Nothing overflows the hidden
    // edge, which would put the close button out of reach.
    minWidth: sp(7),
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 0,
    fontSize: sp(13),
    lineHeight: 1,
    borderRadius: sp(6),
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, #666)',
    cursor: 'pointer',
  }
}
