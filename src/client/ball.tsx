/**
 * The floating ball that owns every room.
 *
 * ── Why a ball rather than a bar ───────────────────────────────────────────
 *
 * The ball is both the entry point and the resting state. With several rooms
 * monitored at once there is no single window to fall back to, so the control
 * that can always be found has to be independent of any one window. It carries
 * the aggregate connection state, the newest danmaku across rooms, and the menu
 * that shows, hides and stops monitoring each room.
 *
 * ── Why the controls fade ──────────────────────────────────────────────────
 *
 * A permanent button strip would cover the page for no benefit while the stream
 * is calm. After a short quiet period the controls fade out and the ball shows
 * only the state dot plus the newest line, which is the part worth glancing at.
 * A new danmaku or a click brings the controls back. The threshold is short on
 * purpose: live danmaku is only useful while it is current, so several quiet
 * seconds already mean "nothing is happening" rather than "wait longer".
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { CopyKey } from './copy.ts'
import { CloseIcon, EditIcon, HidePanelIcon, ShowPanelIcon } from './icons.tsx'
import { aggregateState, stateTone } from './rooms.ts'
import type { RoomInstance } from './rooms.ts'

/** Quiet period before the controls fade, in milliseconds. */
const IDLE_FADE_MS = 5_000

/** Longest summary line, in characters, before it is ellipsised. */
const SUMMARY_CHARS = 42

/** Diameter the ball uses when nothing overrides it. */
export const DEFAULT_BALL_SIZE = 48

/** Smallest and largest ball the settings allow. */
export const MIN_BALL_SIZE = 32
export const MAX_BALL_SIZE = 96

/**
 * Cut a danmaku down to a glanceable line.
 *
 * @param text - the full message.
 * @returns the message with an ellipsis when it was too long.
 */
export function summarise(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS)}…`
}

/**
 * The Bilibili television mark, drawn inline so no asset request is needed.
 *
 * @param props.size - edge length in pixels.
 * @param props.color - the mark colour.
 * @returns the svg.
 */
function TvMark(props: { readonly size: number; readonly color: string }) {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <rect
        x="2.5"
        y="7.5"
        width="19"
        height="13"
        rx="3"
        stroke={props.color}
        strokeWidth="1.8"
      />
      <path d="M7.5 4.2 10 6.9M16.5 4.2 14 6.9" stroke={props.color} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8.6" cy="13" r="1.35" fill={props.color} />
      <circle cx="15.4" cy="13" r="1.35" fill={props.color} />
    </svg>
  )
}

/** A room the menu can offer, whether or not it is monitored right now. */
export interface RoomCandidate {
  /** The room id. */
  readonly room: string
  /** The label to show, empty when nothing is known yet. */
  readonly label: string
  /** Whether this room is monitored right now. */
  readonly live: boolean
}

/** Props for the ball. */
export interface BallProps {
  readonly t: (key: CopyKey) => string
  readonly rooms: readonly RoomInstance[]
  /**
   * Rooms to offer for reopening, newest first, whether or not they are live.
   *
   * Kept separate from `rooms` because the two answer different questions: `rooms`
   * is what is monitored now, and this is what this browser has opened before. The
   * menu pins the room dsh is configured with above both.
   */
  readonly candidates: readonly RoomCandidate[]
  /** The room dsh is configured to open, shown first; empty when unset. */
  readonly configuredRoom: string
  readonly size: number
  /**
   * Zoom for the menu's contents, as a percentage of their declared size.
   *
   * The menu lists the same rooms the windows show, so it follows the same zoom a
   * window does rather than having a scale of its own. The ball itself does not use
   * it: the dot is sized by its own diameter, which is what keeps a big ball with
   * small text from looking like two objects.
   */
  readonly uiScale: number
  readonly open: boolean
  readonly onToggleMenu: () => void
  readonly onShowWindow: (key: string) => void
  readonly onHideWindow: (key: string) => void
  readonly onRemove: (key: string) => void
  readonly onRename: (key: string, alias: string) => void
  readonly onAddRoom: (room: string) => void
  readonly onShowAll: () => void
  readonly onHideAll: () => void
  /** Where the ball sits; null keeps the default bottom-right corner. */
  readonly place: { readonly x: number; readonly y: number } | null
  readonly onDragEnd: (place: { x: number; y: number }) => void
}

/**
 * The floating ball and its menu.
 *
 * @param props - the rooms, the ball size, and the actions the menu offers.
 * @returns the ball, with the menu rendered above it while open.
 */
/** Pixels the pointer must travel before a press counts as a drag. */
const DRAG_SLOP = 4

/**
 * Gap kept between the ball or its menu and the viewport edge, in pixels.
 *
 * Larger than a decorative margin on purpose: a phone reports a viewport that
 * already excludes the browser chrome, but not the home indicator or the rounded
 * corners, and a control parked flush against the edge is hard to hit there.
 */
const SAFE = 12

/** Preferred menu width; narrowed automatically on a small screen. */
const MENU_WIDTH = 268

export function FloatingBall(props: BallProps) {
  const { t, rooms, size } = props
  // The expanded summary is the ball's own label, so every length around it scales
  // with the dot rather than staying fixed: a pill drawn against a 96px dot with
  // text and padding sized for a 48px one reads as two mismatched objects. The
  // ratio is taken against the default diameter, so a default ball is unchanged.
  const bs = (value: number): number => Math.max(1, Math.round(value * (size / DEFAULT_BALL_SIZE)))
  // The menu follows the window zoom, not the ball size: it lists the same rooms
  // the danmaku windows show, so a reader who enlarged one text expects the other
  // to match. Rounding with a floor of one keeps a hairline gap visible at the
  // smallest zoom.
  const ds = (value: number): number => Math.max(1, Math.round(value * (props.uiScale / 100)))
  // Rooms the menu offers for reopening: everything this browser has opened that is
  // not monitored right now. The configured room is filtered out because it is
  // already pinned above the list under its own heading.
  const reopenable = props.candidates.filter(
    (entry) => !entry.live && entry.room !== props.configuredRoom,
  )
  const [idle, setIdle] = useState(false)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [aliasDraft, setAliasDraft] = useState('')
  const idleTimer = useRef(0)

  /**
   * Where the pointer currently holds the ball, in viewport coordinates.
   *
   * Dragging is rendered from state rather than written straight to the DOM: a
   * new danmaku re-renders this component constantly, and a DOM-only position
   * would be overwritten by the next render, snapping the ball back mid-drag.
   */
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null)
  /** Where the ball is drawn: the in-flight drag wins over the settled corner. */
  const at = dragAt ?? props.place
  const dragging = dragAt !== null

  const newest = newestRow(rooms)
  const state = aggregateState(rooms.map((room) => room.state))

  /**
   * The viewport, tracked so the default corner follows a window resize.
   *
   * Reading `window.innerWidth` during render would freeze the default position at
   * the size the page loaded at: the ball would then sit off-screen after the
   * window was made smaller.
   */
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }))

  useEffect(() => {
    const onResize = (): void => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x0: number; y0: number; moved: boolean } | null>(null)
  const latestRef = useRef<{ x: number; y: number } | null>(null)

  /**
   * Choose which side the menu unfolds towards.
   *
   * A menu opening towards the nearest edge would be cut off or pushed back over
   * the ball, so it always grows into the roomier half: near the right edge it
   * opens leftwards, near the left edge rightwards. The comparison uses the ball's
   * centre, so a ball parked mid-screen still picks a sensible side.
   *
   * @param point - where the ball is, in viewport coordinates.
   * @returns the horizontal side the menu should grow towards.
   */
  const unfold = useCallback((point: { x: number; y: number }): 'left' | 'right' => {
    const centre = point.x + size / 2
    // Left half of the screen opens rightwards, right half leftwards.
    return centre > viewport.w / 2 ? 'left' : 'right'
  }, [size, viewport.w])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    // The press starts a drag; whether it is also a click is decided on release.
    event.preventDefault()
    // Remember the press point so the slop test compares against where the press
    // began, not against the origin of the screen.
    dragRef.current = { x0: event.clientX, y0: event.clientY, moved: false }
    latestRef.current = null
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag) return
    // Once the pointer has left the slop radius, follow it and centre the ball on
    // the finger. A ball that jumped to its top-left corner would lag the pointer
    // by half its own size, which reads as the ball not tracking the drag.
    if (!drag.moved) {
      const travel = Math.abs(event.clientX - drag.x0) + Math.abs(event.clientY - drag.y0)
      if (travel < DRAG_SLOP) return
      drag.moved = true
    }
    const half = size / 2
    // Release never parks the ball inside the unsafe edge, so the dot stays
    // tappable on a phone instead of half-under the home indicator.
    const x = Math.max(SAFE, Math.min(window.innerWidth - size - SAFE, event.clientX - half))
    const y = Math.max(SAFE, Math.min(window.innerHeight - size - SAFE, event.clientY - half))
    latestRef.current = { x, y }
    setDragAt({ x, y })
  }, [size])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const landed = latestRef.current
    latestRef.current = null
    setDragAt(null)
    if (drag.moved && landed !== null) props.onDragEnd(landed)
    else props.onToggleMenu()
  }, [props])

  // Fade only while the menu is shut: an open menu is being read, so hiding the
  // controls under the pointer would be a bug, not a feature.
  useEffect(() => {
    window.clearTimeout(idleTimer.current)
    if (props.open) {
      setIdle(false)
      return undefined
    }
    setIdle(false)
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_FADE_MS)
    return () => window.clearTimeout(idleTimer.current)
  }, [props.open, newest?.text, rooms.length])

  const wake = useCallback(() => {
    window.clearTimeout(idleTimer.current)
    setIdle(false)
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_FADE_MS)
  }, [])

  const collapse = idle && !props.open

  // The ball's own point, resolved once so the menu and the dot agree on a side.
  // First run parks the ball in the top-right corner, out of the reading column.
  const anchor = at ?? { x: viewport.w - size - SAFE, y: SAFE }
  const side = unfold(anchor)
  // Dragging must not fight the pointer with a transition, and a dragged ball is
  // always the bare dot: a 280px pill under the finger would obscure what it is
  // being dragged over.
  const expanded = !collapse && !dragging

  /**
   * Place the menu beside the ball without letting it leave the screen.
   *
   * The menu is positioned against the viewport rather than inside a flex column,
   * because a flex column is as wide as its widest child: opening a 268px menu
   * would widen the container, push the dot off its anchor, and on a phone push the
   * whole panel past the edge. Anchoring both children to the same corner and
   * clamping the menu keeps the dot exactly where the user put it.
   *
   * The clamping is what makes this safe on a small screen: when neither side has
   * room for the panel, it is pinned inside the safe area instead of overflowing.
   */
  // The preferred width scales with the zoom, so a room named in text the reader
  // enlarged is not cut off at a width sized for the default one. The safe area and
  // the viewport still win, which is what keeps a 300% menu inside a small screen.
  const menuWidth = Math.min(ds(MENU_WIDTH), viewport.w - SAFE * 2)
  // Clamp to the safe area on BOTH sides: a ball parked at the very edge would
  // otherwise open a menu that starts off screen.
  const desired = side === 'left' ? anchor.x + size - menuWidth : anchor.x
  const menuLeft = Math.max(SAFE, Math.min(viewport.w - SAFE - menuWidth, desired))

  // Same idea vertically: the menu never sits on top of the ball, it hangs below
  // a ball in the upper half and rises above one in the lower half. Anchoring the
  // far edge (top for a rising menu, bottom for a hanging one) means the panel can
  // grow to its natural height without ever needing to know that height here.
  const below = anchor.y + size / 2 < viewport.h / 2
  const menuVertical = below
    ? { top: anchor.y + size + ds(8) }
    : { bottom: viewport.h - anchor.y + ds(8) }
  // Whichever direction it opens, it stays inside the safe area.
  const menuMaxHeight = below
    ? Math.max(ds(120), viewport.h - SAFE - (anchor.y + size + ds(8)))
    : Math.max(ds(120), anchor.y - ds(8) - SAFE)
  // The height cap scales with the zoom too, so a zoomed menu scrolls inside the
  // same footprint instead of being cut off at a height sized for the default one.
  const menuHeightCap = Math.min(menuMaxHeight, ds(520))

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        zIndex: 60,
        pointerEvents: 'none',
      }}
    >
      {props.open && !dragging ? (
        <div
          style={{
            position: 'fixed',
            left: menuLeft,
            ...menuVertical,
            pointerEvents: 'auto',
            width: menuWidth,
            maxHeight: Math.round(menuHeightCap),
            display: 'flex',
            flexDirection: 'column',
            borderRadius: ds(12),
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
            background: 'var(--dsw-alias-bg-overlay, #fff)',
            boxShadow: '0 10px 32px rgba(0,0,0,.18)',
            font: `${ds(12)}px/1.4 system-ui, -apple-system, sans-serif`,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: `${ds(9)}px ${ds(11)}px`,
              borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
              fontSize: ds(12),
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary, #222)',
            }}
          >
            {t('rooms')}
          </div>

          <div style={{ overflowY: 'auto', padding: `${ds(4)}px 0` }}>
            {props.configuredRoom !== '' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: ds(6),
                  padding: `${ds(6)}px ${ds(11)}px`,
                  borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.14))',
                }}
              >
                <span
                  style={{
                    width: ds(7),
                    height: ds(7),
                    borderRadius: 999,
                    flex: '0 0 auto',
                    // The configured room is pinned, not monitored, so it carries the
                    // same tone a connected room would rather than a live colour it
                    // has not earned.
                    background: 'var(--dsw-alias-label-tertiary, #999)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => props.onAddRoom(props.configuredRoom)}
                  title={t('openRoom')}
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: 'var(--dsw-alias-label-primary, #222)',
                    font: 'inherit',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('configuredRoom')} #{props.configuredRoom}
                </button>
              </div>
            ) : null}
            {rooms.length === 0 && props.candidates.length === 0 ? (
              <div
                style={{
                  padding: `${ds(16)}px ${ds(12)}px`,
                  textAlign: 'center',
                  color: 'var(--dsw-alias-label-tertiary, #999)',
                }}
              >
                {t('noRooms')}
              </div>
            ) : rooms.map((room) => (
              <div
                key={room.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: ds(6),
                  padding: `${ds(6)}px ${ds(11)}px`,
                }}
              >
                <span
                  style={{
                    width: ds(7),
                    height: ds(7),
                    borderRadius: 999,
                    flex: '0 0 auto',
                    background: stateTone(room.state),
                  }}
                />
                {editing === room.key ? (
                  <input
                    autoFocus
                    value={aliasDraft}
                    onChange={(event) => setAliasDraft(event.target.value.slice(0, 40))}
                    onBlur={() => {
                      props.onRename(room.key, aliasDraft.trim())
                      setEditing(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        props.onRename(room.key, aliasDraft.trim())
                        setEditing(null)
                      }
                      if (event.key === 'Escape') setEditing(null)
                    }}
                    placeholder={room.liveTitle || `#${room.room}`}
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      padding: `${ds(2)}px ${ds(6)}px`,
                      fontSize: ds(12),
                      borderRadius: ds(6),
                      border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
                      background: 'var(--dsw-alias-bg-layer-2, transparent)',
                      color: 'var(--dsw-alias-label-primary, #222)',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => props.onShowWindow(room.key)}
                    title={t('showWindow')}
                    style={{
                      flex: '1 1 auto',
                      minWidth: 0,
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                      color: 'var(--dsw-alias-label-primary, #222)',
                      font: 'inherit',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {room.alias || room.liveTitle || `#${room.room}`}
                  </button>
                )}
                <IconButton
                  label={room.view === 'hidden' ? t('showWindow') : t('hideWindow')}
                  scale={ds}
                  onClick={() => {
                    if (room.view === 'hidden') props.onShowWindow(room.key)
                    else props.onHideWindow(room.key)
                  }}
                >
                  {room.view === 'hidden' ? <ShowPanelIcon /> : <HidePanelIcon />}
                </IconButton>
                <IconButton
                  label={t('rename')}
                  scale={ds}
                  onClick={() => {
                    setEditing(room.key)
                    setAliasDraft(room.alias)
                  }}
                >
                  <EditIcon />
                </IconButton>
                <IconButton label={t('removeRoom')} scale={ds} onClick={() => props.onRemove(room.key)}>
                  <CloseIcon />
                </IconButton>
              </div>
            ))}
            {reopenable.length > 0 ? (
              <>
                <div
                  style={{
                    padding: `${ds(8)}px ${ds(11)}px ${ds(2)}px`,
                    fontSize: ds(11),
                    color: 'var(--dsw-alias-label-tertiary, #999)',
                  }}
                >
                  {t('recentRooms')}
                </div>
                {reopenable.map((entry) => (
                  <div
                    key={entry.room}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: ds(6),
                      padding: `${ds(6)}px ${ds(11)}px`,
                    }}
                  >
                    <span
                      style={{
                        width: ds(7),
                        height: ds(7),
                        borderRadius: 999,
                        flex: '0 0 auto',
                        background: 'var(--dsw-alias-label-tertiary, #999)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => props.onAddRoom(entry.room)}
                      title={t('openRoom')}
                      style={{
                        flex: '1 1 auto',
                        minWidth: 0,
                        padding: 0,
                        border: 'none',
                        background: 'transparent',
                        textAlign: 'left',
                        cursor: 'pointer',
                        color: 'var(--dsw-alias-label-secondary, #666)',
                        font: 'inherit',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.label || `#${entry.room}`}
                    </button>
                  </div>
                ))}
              </>
            ) : null}
          </div>

          <div
            style={{
              display: 'flex',
              gap: ds(6),
              padding: `${ds(8)}px ${ds(11)}px`,
              borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                props.onAddRoom(draft.trim())
                setDraft('')
              }}
              placeholder={t('roomPlaceholder')}
              inputMode="numeric"
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                padding: `${ds(4)}px ${ds(8)}px`,
                fontSize: ds(12),
                borderRadius: ds(7),
                border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
                background: 'var(--dsw-alias-bg-layer-2, transparent)',
                color: 'var(--dsw-alias-label-primary, #222)',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={() => {
                props.onAddRoom(draft.trim())
                setDraft('')
              }}
              style={{
                flex: '0 0 auto',
                padding: `${ds(4)}px ${ds(10)}px`,
                fontSize: ds(12),
                borderRadius: ds(7),
                border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary, #222)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t('addRoom')}
            </button>
          </div>

          {rooms.length > 1 ? (
            <div
              style={{
                display: 'flex',
                gap: ds(6),
                padding: `0 ${ds(11)}px ${ds(9)}px`,
              }}
            >
              <TextButton label={t('showWindow')} onClick={props.onShowAll} scale={ds} />
              <TextButton label={t('ungroupAll')} onClick={props.onHideAll} scale={ds} />
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerEnter={wake}
        title={t('manage')}
        style={{
          // The pill always stays on the dot's own edge and grows outwards into the
          // roomier half, so the summary never runs off screen.
          position: 'fixed',
          ...(side === 'left'
            ? { right: viewport.w - anchor.x - size }
            : { left: anchor.x }),
          top: anchor.y,
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          // The pill is anchored by the edge nearest the screen border, so the dot
          // must sit on that same edge (`row-reverse` puts the first child last):
          // otherwise the summary grows between the icon and the border and pushes
          // the icon halfway across the pill.
          flexDirection: side === 'left' ? 'row-reverse' : 'row',
          gap: expanded ? bs(8) : 0,
          height: size,
          // A pill that would run past the edge is clamped to the safe area, which
          // keeps the summary readable on a phone instead of clipping it.
          maxWidth: side === 'left'
            ? Math.max(size, anchor.x + size - SAFE)
            : Math.max(size, viewport.w - SAFE - anchor.x),
          minWidth: size,
          // No padding on the icon's side: the glyph is already centred inside a
          // full `size` box, so its own letterboxing is the gap to the pill edge.
          // Only the summary needs breathing room against the rounded end.
          padding: expanded ? (side === 'left' ? `0 0 0 ${bs(14)}px` : `0 ${bs(14)}px 0 0`) : 0,
          borderRadius: 999,
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
          background: 'var(--dsw-alias-bg-overlay, #fff)',
          boxShadow: dragging ? '0 10px 26px rgba(0,0,0,.28)' : '0 6px 22px rgba(0,0,0,.16)',
          cursor: dragging ? 'grabbing' : 'grab',
          overflow: 'hidden',
          touchAction: 'none',
          userSelect: 'none',
          transition: dragging ? 'none' : 'padding 160ms ease, gap 160ms ease',
        }}
      >
        <span
          style={{
            position: 'relative',
            flex: '0 0 auto',
            width: size,
            height: size,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <TvMark size={Math.round(size * 0.56)} color="var(--dsw-alias-label-primary, #222)" />
          <span
            style={{
              position: 'absolute',
              right: Math.round(size * 0.12),
              bottom: Math.round(size * 0.12),
              width: 9,
              height: 9,
              borderRadius: 999,
              background: stateTone(state),
              border: '2px solid var(--dsw-alias-bg-overlay, #fff)',
            }}
          />
        </span>
        {expanded ? (
          <span
            style={{
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 1,
              // The summary is the ball's own label, so it follows the ball: a larger
              // dot carries a larger summary, and the two always look like one object.
              // The ratio is taken against the default diameter, which keeps a default
              // ball drawing its text at the size it was designed for.
              font: `${Math.max(9, bs(12))}px/1.25 system-ui, -apple-system, sans-serif`,
            }}
          >
            <span
              style={{
                maxWidth: bs(210),
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--dsw-alias-label-secondary, #888)',
                fontSize: Math.max(9, bs(11)),
              }}
            >
              {newest ? `${newest.user}：${summarise(newest.text)}` : t('waitingNew')}
            </span>
            <span
              style={{
                color: 'var(--dsw-alias-label-primary, #222)',
                fontSize: Math.max(9, bs(12)),
              }}
            >
              {rooms.length === 0 ? t('noRooms') : `${rooms.length} ${t('roomCount')}`}
            </span>
          </span>
        ) : null}
      </button>
    </div>
  )
}

/**
 * The newest danmaku across every monitored room.
 *
 * Rooms are compared on `lastAt` rather than list length: a room that stopped
 * receiving ten minutes ago still has a long list, and its last row is not the
 * newest thing on screen.
 *
 * @param rooms - the monitored rooms.
 * @returns the newest row with its room key, or null when none has spoken.
 */
function newestRow(rooms: readonly RoomInstance[]): { user: string; text: string } | null {
  let best: { user: string; text: string; at: number } | null = null
  for (const room of rooms) {
    const last = room.items[room.items.length - 1]
    if (!last) continue
    const at = room.lastAt
    if (best && best.at >= at) continue
    best = { user: last.user, text: last.text, at }
  }
  return best === null ? null : { user: best.user, text: best.text }
}

/**
 * A small square icon button.
 *
 * @param props - the label, the click handler and the menu's zoom.
 * @returns the button.
 */
function IconButton(props: {
  readonly label: string
  readonly onClick: () => void
  readonly scale: (value: number) => number
  readonly children: React.ReactNode
}) {
  const sp = props.scale
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      style={{
        flex: '0 0 auto',
        width: sp(20),
        height: sp(20),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        fontSize: sp(12),
        lineHeight: 1,
        borderRadius: sp(5),
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #666)',
        cursor: 'pointer',
      }}
    >
      {props.children}
    </button>
  )
}

/**
 * A borderless text button.
 *
 * @param props - the label, the click handler and the menu's zoom.
 * @returns the button.
 */
function TextButton(props: {
  readonly label: string
  readonly onClick: () => void
  readonly scale: (value: number) => number
}) {
  const sp = props.scale
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        flex: '1 1 auto',
        padding: `${sp(3)}px ${sp(8)}px`,
        fontSize: sp(11),
        borderRadius: sp(6),
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #666)',
        cursor: 'pointer',
      }}
    >
      {props.label}
    </button>
  )
}
