/**
 * The floating overlay component.
 *
 * ── Layout ─────────────────────────────────────────────────────────────────
 *
 * `shell.overlay` renders in a layer that ignores pointer events, so the card
 * re-enables them on itself. Without that every click passes through to the page
 * underneath and none of the controls work.
 *
 * ── Why the reply path re-reads history ────────────────────────────────────
 *
 * The live socket never echoes your own message back, so a successful send would
 * otherwise be invisible until someone else spoke. The Host cannot mint the real
 * message id, so the page re-reads history a moment later and merges on the id
 * the same way the initial load does.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { CopyKey, Dictionary } from './copy.ts'
import {
  colorOf,
  fetchConfig,
  fetchCredential,
  fetchHistory,
  fetchStats,
  loadState,
  saveState,
  sendReply,
  type Credential,
  type Item,
  type RemoteConfig,
} from './api.ts'

/** Connection state as the status dot reports it. */
type State = 'idle' | 'connecting' | 'reconnecting' | 'live' | 'offline' | 'error'

/** Props the slot injects. */
export interface OverlayProps {
  readonly t: (key: CopyKey) => string
}

/** Longest message accepted, matching Bilibili's own limit. */
const MAX_CHARS = 20

/**
 * Fallback poll interval, used only before the Host has reported its own.
 *
 * Once `/api/history` answers, its `intervalMs` takes over: the Host runs one
 * shared poller per room and knows whether it is healthy or backing off. This
 * value exists so the first round has something sane to use.
 */
const DEFAULT_POLL_MS = 1_000

/** Base path of the Host routes. */
const BASE = '/bili-danmaku-overlay'

/** Shared button chrome; every control in the header uses it. */
const BUTTON: React.CSSProperties = {
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

/**
 * The status dot.
 *
 * @param props - the current connection state.
 * @returns the dot.
 */
function StatusDot(props: { readonly state: State }) {
  const tone =
    props.state === 'live'
      ? 'var(--dsw-alias-state-success-primary, #22c55e)'
      : props.state === 'connecting' || props.state === 'reconnecting'
        ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
        : props.state === 'error'
          ? 'var(--dsw-alias-state-error-primary, #ef4444)'
          : 'var(--dsw-alias-state-idle-primary, #8b8b8b)'

  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: tone,
        boxShadow: props.state === 'live' ? `0 0 0 3px ${tone}33` : 'none',
        flex: '0 0 auto',
      }}
    />
  )
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

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        padding: '2px 0',
        fontSize: 12,
        lineHeight: 1.45,
        wordBreak: 'break-word',
      }}
    >
      {item.medal
        ? (
          <span
            style={{
              flex: '0 0 auto',
              alignSelf: 'flex-start',
              marginTop: 1,
              padding: '0 4px',
              borderRadius: 4,
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
              fontSize: 10,
              lineHeight: '15px',
              color: 'var(--dsw-alias-label-tertiary, #999)',
            }}
          >
            {item.medal.name}
            {item.medal.level}
          </span>
        )
        : null}
      {item.kind === 'superchat'
        ? (
          <span
            style={{
              flex: '0 0 auto',
              padding: '0 4px',
              borderRadius: 4,
              background: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
              color: '#fff',
              fontSize: 10,
              lineHeight: '15px',
            }}
          >
            {props.superChatLabel} ¥{item.price ?? 0}
          </span>
        )
        : null}
      <span style={{ flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary, #888)' }}>
        {item.user}
        {item.admin ? '：' : '：'}
      </span>
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
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
 * The overlay.
 *
 * @param props - the bound translator.
 * @returns the overlay card, or the floating reopen button while hidden.
 */
export function Overlay(props: OverlayProps) {
  const { t } = props
  const saved = useRef(loadState()).current

  const [room, setRoom] = useState(String(saved.room ?? ''))
  const [draft, setDraft] = useState(String(saved.room ?? ''))
  const [enabled, setEnabled] = useState(Boolean(saved.enabled && saved.room))
  const [collapsed, setCollapsed] = useState(Boolean(saved.collapsed))
  const [hidden, setHidden] = useState(false)
  const [place, setPlace] = useState<{ x: number; y: number } | null>(saved.place ?? null)
  const [state, setState] = useState<State>('idle')
  const [items, setItems] = useState<Item[]>([])
  const [notice, setNotice] = useState('')
  const [reply, setReply] = useState('')
  const [replyState, setReplyState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [credential, setCredential] = useState<Credential | null>(null)
  const [config, setConfig] = useState<RemoteConfig>({
    historyLimit: 200,
    statsIntervalMs: 60_000,
    defaultRoom: '',
    autoConnect: false,
  })
  const [generation, setGeneration] = useState(0)
  const [online, setOnline] = useState(0)

  const listRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const pinnedBottom = useRef(true)
  const appliedDefault = useRef(false)

  // Read the Host's limits once, then seed the room from them when the user has
  // never chosen one, so `defaultRoom` and `autoConnect` can work together.
  useEffect(() => {
    let disposed = false
    void fetchConfig().then((next) => {
      if (disposed) return
      setConfig(next)
      if (appliedDefault.current || saved.room) return
      appliedDefault.current = true
      if (next.defaultRoom === '') return
      setDraft(next.defaultRoom)
      if (next.autoConnect) {
        setRoom(next.defaultRoom)
        setEnabled(true)
      }
    })
    return () => {
      disposed = true
    }
  }, [saved.room])

  useEffect(() => {
    let disposed = false
    void fetchCredential().then((next) => {
      if (!disposed) setCredential(next)
    })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    saveState({ room, enabled, collapsed, place })
  }, [room, enabled, collapsed, place])

  /**
   * How often to poll, in milliseconds, as reported by the Host.
   *
   * Kept in state because it drives a timer: the Host lowers it while healthy and
   * raises it while backing off, and the page has to follow rather than guess.
   * Zero means "no value yet", which the timer reads as a conservative default.
   */
  const [pollMs, setPollMs] = useState(0)

  const mergeHistory = useCallback(
    async (isDisposed: () => boolean) => {
      const snapshot = await fetchHistory(room)
      if (isDisposed()) return
      // Only write when the number actually changed: at a 100ms cadence an
      // unconditional setState queues a render every round for no reason.
      if (snapshot.intervalMs > 0) {
        setPollMs((current) => (current === snapshot.intervalMs ? current : snapshot.intervalMs))
      }
      if (snapshot.items.length === 0) return

      const fresh = snapshot.items
      setItems((previous) => {
        const freshIds = new Set(fresh.map((item) => item.id))
        // Everything the window no longer covers is older than the window, so it
        // belongs in front; the window itself is already in chronological order.
        //
        // Prepending only the unseen rows instead would look fine on the first
        // pull and then invert on the next one: B alone is unseen, so it would
        // land in front of A even though it came after.
        const older = previous.filter((item) => !freshIds.has(item.id))
        const merged = [...older, ...fresh]
        return merged.length === previous.length &&
          merged.every((item, index) => item.id === previous[index]?.id)
          ? previous
          : merged.slice(-config.historyLimit)
      })
    },
    [room, config.historyLimit],
  )

  const submitReply = useCallback(async () => {
    const text = reply.trim()
    if (text === '' || replyState === 'sending') return

    setReplyState('sending')
    const result = await sendReply(room, text)
    if (!result.ok) {
      setReplyState('idle')
      setNotice(result.error ?? t('sendFailed'))
      return
    }

    setReply('')
    setReplyState('sent')
    // The socket does not echo your own message, so re-read history after a beat
    // to render it with the real nickname instead of leaving it invisible.
    window.setTimeout(() => {
      void (async () => {
        const fresh = (await fetchHistory(room)).items
        const mine = fresh.find((item) => item.text === text)
        if (!mine) return
        setItems((previous) =>
          previous.some((item) => item.id === mine.id)
            ? previous
            : [...previous, mine].slice(-config.historyLimit),
        )
      })()
    }, 1200)
    window.setTimeout(() => setReplyState('idle'), 1500)
  }, [reply, replyState, room, t, config.historyLimit])

  // Live stream. One effect per (room, generation): bumping the generation is what
  // the refresh button does, and the cleanup closes the socket before the next
  // one opens so a refresh never double-subscribes.
  useEffect(() => {
    if (!enabled || room === '') {
      setState('idle')
      return undefined
    }

    let disposed = false
    const isDisposed = () => disposed
    setState('connecting')
    setNotice('')

    void mergeHistory(isDisposed)

    // A background tab throttles EventSource delivery; on return to the
    // foreground pull the recent window instead of waiting the gap out.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void mergeHistory(isDisposed)
    }
    document.addEventListener('visibilitychange', onVisible)

    const source = new window.EventSource(`${BASE}/api/events?room=${encodeURIComponent(room)}`)

    const onRoom = (event: MessageEvent) => {
      if (disposed) return
      try {
        const data = JSON.parse(String(event.data)) as { liveStatus?: number }
        if (data.liveStatus !== undefined && data.liveStatus !== 1) setNotice(t('offline'))
      } catch {
        /* ignore malformed frames */
      }
    }

    const onStatus = (event: MessageEvent) => {
      if (disposed) return
      try {
        const data = JSON.parse(String(event.data)) as { state?: State; message?: string }
        if (data.state) setState(data.state)
        if (data.message) setNotice(data.message)
      } catch {
        /* ignore malformed frames */
      }
    }

    const onDanmaku = (event: MessageEvent) => {
      if (disposed) return
      try {
        const data = JSON.parse(String(event.data)) as Item
        if (!data?.id) return
        setItems((previous) => {
          // A throttled tab replays buffered events and the same message also
          // arrives from history, so the id check is what keeps rows unique.
          if (previous.some((item) => item.id === data.id)) return previous
          return [...previous, data].slice(-config.historyLimit)
        })
      } catch {
        /* ignore malformed frames */
      }
    }

    source.addEventListener('room', onRoom as EventListener)
    source.addEventListener('status', onStatus as EventListener)
    source.addEventListener('danmaku', onDanmaku as EventListener)
    source.addEventListener('error', () => {
      if (!disposed) setState('reconnecting')
    })

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisible)
      source.close()
    }
  }, [enabled, room, t, generation, mergeHistory, config.historyLimit])

  // Nobody pushes the audience figure, so poll it. The interval comes from the
  // Host config rather than the bundle.
  useEffect(() => {
    if (!enabled || room === '') {
      setOnline(0)
      return undefined
    }

    let disposed = false
    const load = () => {
      void fetchStats(room).then((count) => {
        if (!disposed && count !== null) setOnline(count)
      })
    }

    load()
    const timer = window.setInterval(load, config.statsIntervalMs)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [enabled, room, config.statsIntervalMs])

  // Poll history while the live socket is not delivering.
  //
  // The upstream socket can be refused for reasons outside our control — a
  // throttled IP, a room at capacity, a network that blocks the comet hosts.
  // Without this the overlay shows an empty list indefinitely, because the only
  // history pulls used to be "on connect", "on refresh" and "tab regained focus".
  // History reads a different endpoint over plain HTTPS, so it keeps working when
  // the socket does not, and that is exactly the case worth covering.
  //
  // A recursive timeout rather than an interval: the Host reports the rate its
  // shared poller is actually using, and a fixed interval would ignore it —
  // either lagging a healthy poller or pounding a room that had backed off.
  useEffect(() => {
    if (!enabled || room === '') return undefined

    const degraded = state === 'error' || state === 'reconnecting' || state === 'connecting'
    if (!degraded) return undefined

    let disposed = false
    let timer = 0

    const tick = () => {
      if (disposed) return
      void mergeHistory(() => disposed).finally(() => {
        if (disposed) return
        // Read the newest interval each round; fall back to a conservative value
        // before the Host has reported one.
        timer = window.setTimeout(tick, pollMs > 0 ? pollMs : DEFAULT_POLL_MS)
      })
    }

    timer = window.setTimeout(tick, pollMs > 0 ? pollMs : DEFAULT_POLL_MS)

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [enabled, room, state, mergeHistory, pollMs])

  // Stick to the bottom unless the user has scrolled up to read something.
  useEffect(() => {
    const node = listRef.current
    if (!node || !pinnedBottom.current) return
    node.scrollTop = node.scrollHeight
  }, [items, collapsed])

  const onScroll = useCallback(() => {
    const node = listRef.current
    if (!node) return
    pinnedBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const width = cardRef.current?.offsetWidth ?? 320
    const height = cardRef.current?.offsetHeight ?? 60
    setPlace({
      x: Math.max(4, Math.min(window.innerWidth - width - 4, event.clientX - dragRef.current.dx)),
      y: Math.max(4, Math.min(window.innerHeight - height - 4, event.clientY - dragRef.current.dy)),
    })
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    // Commit once, on release, instead of writing storage on every frame.
    saveState({ room, enabled, collapsed, place })
  }, [room, enabled, collapsed, place])

  const connect = useCallback(() => {
    const value = draft.trim()
    if (value === '') return
    setItems([])
    pinnedBottom.current = true
    setRoom(value)
    setEnabled(true)
  }, [draft])

  const disconnect = useCallback(() => {
    setEnabled(false)
    setItems([])
    setState('idle')
    setNotice('')
  }, [])

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setHidden(false)}
        title={t('reopen')}
        style={{
          position: 'fixed',
          right: 18,
          bottom: 18,
          zIndex: 60,
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 12px',
          borderRadius: 999,
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
          background: 'var(--dsw-alias-bg-overlay, #fff)',
          color: 'var(--dsw-alias-label-secondary, #555)',
          font: '12px/1.2 system-ui, -apple-system, sans-serif',
          cursor: 'pointer',
          boxShadow: '0 6px 20px rgba(0,0,0,.14)',
        }}
      >
        <StatusDot state={state} />
        {t('reopen')}
      </button>
    )
  }

  const canReply = Boolean(enabled && credential?.configured && credential.hasCsrf && room !== '')
  const replyReason = !credential
    ? ''
    : credential.ok === false
      ? t('hostNotReady')
      : !credential.configured
        ? (credential.error ?? t('noCredential'))
        : !credential.hasCsrf
          ? t('credentialHint')
          : ''

  const position = place ? { left: place.x, top: place.y } : { right: 18, bottom: 18 }

  return (
    <div
      ref={cardRef}
      style={{
        position: 'fixed',
        ...position,
        zIndex: 60,
        width: collapsed ? 'auto' : 320,
        maxWidth: 'calc(100vw - 24px)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28))',
        background: 'var(--dsw-alias-bg-overlay, #fff)',
        boxShadow: '0 8px 28px rgba(0,0,0,.16)',
        font: '12px/1.4 system-ui, -apple-system, sans-serif',
        overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 8px 7px 10px',
          borderBottom: collapsed ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
          cursor: 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <StatusDot state={state} />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--dsw-alias-label-primary, #222)',
            whiteSpace: 'nowrap',
          }}
        >
          {t('title')}
        </span>
        {room !== ''
          ? (
            <span
              style={{
                fontSize: 11,
                color: 'var(--dsw-alias-label-secondary, #888)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              #{room}
            </span>
          )
          : null}
        <span style={{ flex: '1 1 auto' }} />
        {online > 0
          ? (
            <span
              title={t('online')}
              style={{
                fontSize: 11,
                color: 'var(--dsw-alias-label-secondary, #888)',
                fontVariantNumeric: 'tabular-nums',
                marginRight: 8,
              }}
            >
              {'\u{1F465} '}
              {online}
            </span>
          )
          : null}
        {items.length > 0
          ? (
            <span
              style={{
                fontSize: 11,
                color: 'var(--dsw-alias-label-secondary, #888)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {items.length}
            </span>
          )
          : null}
        <button
          type="button"
          data-no-drag
          onClick={() => {
            if (room === '') return
            // Bumping the generation re-runs the stream effect: reconnect and refetch.
            setItems([])
            setNotice('')
            setGeneration((value) => value + 1)
          }}
          title={t('refresh')}
          style={BUTTON}
        >
          ⟳
        </button>
        <button
          type="button"
          data-no-drag
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? t('expand') : t('collapse')}
          style={BUTTON}
        >
          {collapsed ? '▴' : '−'}
        </button>
        <button
          type="button"
          data-no-drag
          onClick={() => setHidden(true)}
          title={t('close')}
          style={BUTTON}
        >
          ×
        </button>
      </div>

      {collapsed
        ? null
        : (
          <>
            <div
              data-no-drag
              style={{
                display: 'flex',
                gap: 6,
                padding: '8px 8px 6px',
                borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
              }}
            >
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') connect()
                }}
                placeholder={t('roomPlaceholder')}
                inputMode="numeric"
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
                }}
              />
              <button
                type="button"
                onClick={enabled ? disconnect : connect}
                style={{
                  ...BUTTON,
                  width: 'auto',
                  padding: '4px 10px',
                  borderRadius: 7,
                  border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
                }}
              >
                {enabled ? t('disconnect') : t('connect')}
              </button>
            </div>

            <div
              ref={listRef}
              onScroll={onScroll}
              style={{
                maxHeight: 280,
                minHeight: 60,
                overflowY: 'auto',
                padding: '6px 10px',
              }}
            >
              {items.length === 0
                ? (
                  <div
                    style={{
                      padding: '14px 4px',
                      fontSize: 12,
                      color: 'var(--dsw-alias-label-tertiary, #999)',
                      textAlign: 'center',
                    }}
                  >
                    {notice !== '' ? notice : t('empty')}
                  </div>
                )
                : items.map((item) => (
                  <Row key={item.id} item={item} superChatLabel={t('superchat')} />
                ))}
            </div>

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
                onChange={(event) => setReply(event.target.value.slice(0, MAX_CHARS))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitReply()
                }}
                placeholder={canReply ? t('sendPlaceholder') : (replyReason || t('sendPlaceholder'))}
                maxLength={MAX_CHARS}
                disabled={!canReply}
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
                  opacity: canReply ? 1 : 0.6,
                }}
              />
              <button
                type="button"
                onClick={() => void submitReply()}
                disabled={!canReply || replyState === 'sending'}
                style={{
                  ...BUTTON,
                  width: 'auto',
                  padding: '4px 10px',
                  borderRadius: 7,
                  border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
                  opacity: canReply ? 1 : 0.5,
                }}
              >
                {replyState === 'sending' ? t('sending') : replyState === 'sent' ? t('sent') : t('send')}
              </button>
            </div>
          </>
        )}
    </div>
  )
}

/** Dictionary shape the slot expects. */
export type { Dictionary }
