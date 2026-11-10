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
import { colorOf, type Item } from './api.ts'
import { CloseIcon, MinimizeIcon, RefreshIcon, RestoreIcon } from './icons.tsx'
import { stateTone } from './rooms.ts'
import type { RoomInstance } from './rooms.ts'

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
}

/**
 * One danmaku row.
 *
 * @param props - the item and the localized super-chat label.
 * @returns the row.
 */
function Row(props: { readonly item: Item; readonly superChatLabel: string }) {
  const { item } = props
  const color = item.kind === 'enter' ? null : colorOf(item.color)
  // A Bilibili nickname may reach 20 characters, which is most of a 320px window
  // before a medal or a message is considered. Only a name past the limit is
  // allowed to shrink, so an ordinary one keeps its full width and reads as a name.
  const longName = [...item.user].length > MAX_NAME_CHARS

  return (
    // A wrapped message makes the row taller than its badges, and a flex row
    // stretches every other child to that height by default, which drags a badge
    // border down the whole row. Aligning to the top keeps each chip its own size.
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0' }}>
      {item.medal ? (
        <span
          style={{
            flex: '0 0 auto',
            maxWidth: '35%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            padding: '0 4px',
            borderRadius: 3,
            fontSize: 10,
            lineHeight: '15px',
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
            padding: '0 4px',
            borderRadius: 3,
            fontSize: 10,
            lineHeight: '15px',
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
          lineHeight: '15px',
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
          // Pinned so the first text line and the 15px badges beside it share one
          // baseline; a browser default line height is fractional and drifts.
          lineHeight: '15px',
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
  const idleTimer = useRef(0)

  const minimized = instance.view === 'minimized'
  const newest = instance.items[instance.items.length - 1]

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
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const node = cardRef.current
    if (!node) return
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
    setDragging(null)
    if (landed !== null) props.onDragEnd(landed)
  }, [props])

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
  const position = settled
    ? { left: settled.x, top: settled.y }
    : minimized
      ? { right: 18, bottom: 18 + 34 + props.ballSize + props.slot * MINIMIZED_STEP }
      : { right: 18, bottom: 18 + 34 + props.ballSize }

  return (
    <div
      ref={cardRef}
      style={{
        position: 'fixed',
        ...position,
        zIndex: 59,
        width: 320,
        maxWidth: 'calc(100vw - 24px)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
        background: 'var(--dsw-alias-bg-overlay, #fff)',
        boxShadow: minimized ? '0 4px 16px rgba(0,0,0,.14)' : '0 8px 28px rgba(0,0,0,.16)',
        font: '12px/1.4 system-ui, -apple-system, sans-serif',
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
          gap: 6,
          padding: '7px 8px 7px 10px',
          // A minimized window has no content below the bar, so the rule that
          // separates them would hang at the bottom edge of the card.
          borderBottom: minimized ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <span
          style={{
            flex: '0 0 auto',
            width: 8,
            height: 8,
            borderRadius: 999,
            background: tone,
            boxShadow: instance.state === 'live' ? `0 0 0 3px ${tone}33` : 'none',
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
              padding: '1px 5px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 5,
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
              background: 'var(--dsw-alias-bg-layer-2, transparent)',
              color: 'var(--dsw-alias-label-primary, #222)',
              outline: 'none',
            }}
          />
        ) : (
          <span
            data-no-drag
            onDoubleClick={() => {
              setTitleDraft(instance.alias)
              setEditing(true)
            }}
            title={showPreview ? newestLine : instance.alias ? t('renameHint') : instance.liveTitle}
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              // The preview is lighter than the title so the two states stay
              // distinguishable while the layout does not move at all.
              fontWeight: showPreview ? 400 : 600,
              color: showPreview
                ? 'var(--dsw-alias-label-secondary, #666)'
                : 'var(--dsw-alias-label-primary, #222)',
              cursor: 'text',
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
              fontSize: 11,
              color: 'var(--dsw-alias-label-secondary, #888)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {instance.online}
          </span>
        ) : null}
        <button type="button" data-no-drag onClick={props.onRefresh} title={t('refresh')} style={ICON}>
          <RefreshIcon />
        </button>
        <button
          type="button"
          data-no-drag
          onClick={minimized ? props.onRestore : props.onMinimize}
          title={minimized ? t('expand') : t('minimizeWindow')}
          style={ICON}
        >
          {minimized ? <RestoreIcon /> : <MinimizeIcon />}
        </button>
        <button type="button" data-no-drag onClick={props.onClose} title={t('hideWindow')} style={ICON}>
          <CloseIcon />
        </button>
      </div>

      {minimized ? null : (
        <div
          ref={listRef}
          onScroll={onScroll}
          style={{ maxHeight: 280, minHeight: 60, overflowY: 'auto', padding: '6px 10px' }}
        >
          {instance.items.length === 0 ? (
            <div
              style={{
                padding: '14px 4px',
                fontSize: 12,
                color: 'var(--dsw-alias-label-tertiary, #999)',
                textAlign: 'center',
              }}
            >
              {instance.notice !== '' ? instance.notice : t('empty')}
            </div>
          ) : instance.items.map((item) => (
            <Row key={item.id} item={item} superChatLabel={t('superchat')} />
          ))}
        </div>
      )}

      {minimized ? null : (
      <div
        data-no-drag
        style={{
          display: 'flex',
          gap: 6,
          padding: '6px 8px 8px',
          borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
        }}
      >
        <input
          value={reply}
          onChange={(event) => setReply(event.target.value.slice(0, 20))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder={props.canReply ? t('sendPlaceholder') : (props.replyReason || t('sendPlaceholder'))}
          maxLength={20}
          disabled={!props.canReply}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            padding: '4px 8px',
            fontSize: 12,
            borderRadius: 7,
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
          disabled={!props.canReply || replyState === 'sending'}
          style={{
            ...ICON,
            width: 'auto',
            padding: '0 10px',
            height: 24,
            border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
            borderRadius: 7,
            opacity: props.canReply ? 1 : 0.5,
          }}
        >
          {replyState === 'sending' ? t('sending') : replyState === 'sent' ? t('sent') : t('send')}
        </button>
      </div>
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

/** Shared chrome for the small window buttons. */
const ICON: React.CSSProperties = {
  flex: '0 0 auto',
  width: 22,
  height: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  fontSize: 13,
  lineHeight: 1,
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #666)',
  cursor: 'pointer',
}
