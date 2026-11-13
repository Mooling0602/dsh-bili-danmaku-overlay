/**
 * The QR sign-in surface.
 *
 * It draws whatever the Host is holding rather than a code of its own, because the key
 * behind the code lives in the Host process: the page cannot poll for a key it never
 * generated, and a reload must not strand a scan that is already in flight.
 *
 * The lifetime is honoured in two ways. A countdown tells the reader how long is left,
 * and the poll stops at zero instead of spending a request on a key the Host will
 * refuse. When the countdown reaches zero the code is replaced by an invitation to get
 * a new one, since a stale code drawn on screen looks scannable and is not.
 *
 * Once the login completes the surface switches to the account it belongs to. A reader
 * who scans expects to be told who they signed in as, and that confirmation is the only
 * evidence the flow actually ended rather than merely stopped.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { pollQrLogin, startQrLogin } from './api.ts'
import type { CopyKey } from './copy.ts'

/** Where one sign-in attempt stands. */
type Phase = 'starting' | 'waiting' | 'scanned' | 'done' | 'expired' | 'failed'

/** Props for the sign-in surface. */
export interface QrLoginDialogProps {
  /** Whether the surface is open. */
  readonly open: boolean
  /** Dismisses the surface. */
  readonly onClose: () => void
  /** The page's scale, so the surface matches the rest of the overlay. */
  readonly uiScale: number
  /** Localized lookup. */
  readonly t: (key: CopyKey) => string
  /** The account name the Host already knows, shown before a fresh scan. */
  readonly existingUname?: string
  /** Called once a login succeeds, so the caller can re-read the credential. */
  readonly onSignedIn?: () => void
}

/** How often the state is polled, in milliseconds. */
const POLL_INTERVAL_MS = 2000

/**
 * Convert a design pixel into the scaled value the overlay uses.
 *
 * @param value - the size at 100 percent.
 * @param scale - the page's scale as a fraction.
 * @returns the rounded value, never below one.
 */
function px(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale))
}

/**
 * The sign-in surface.
 *
 * @param props - open state, dismissal, scale, wording and the success callback.
 * @returns the surface, or null while closed.
 */
export function QrLoginDialog(props: QrLoginDialogProps): React.ReactElement | null {
  const { open, onClose, t } = props
  const scale = props.uiScale / 100
  const sp = (value: number): number => px(value, scale)

  const [phase, setPhase] = useState<Phase>('starting')
  const [svg, setSvg] = useState('')
  const [failure, setFailure] = useState('')
  const [uname, setUname] = useState('')
  const [remainingMs, setRemainingMs] = useState(0)

  /**
   * The deadline of the code on screen, held as a ref because the poll timer reads it
   * without needing to be rebuilt when it changes.
   */
  const deadlineRef = useRef(0)

  /**
   * Ask for a code, and record where the attempt stands.
   *
   * A code is requested each time the surface opens and each time the reader asks for
   * another one, because the Host keeps a single key and a second surface would
   * otherwise inherit a code already scanned on another device.
   */
  const request = useCallback((): void => {
    setPhase('starting')
    setFailure('')
    setSvg('')
    setUname('')
    void startQrLogin().then((result) => {
      if (!result.ok) {
        setPhase('failed')
        setFailure(result.error)
        return
      }
      deadlineRef.current = Date.now() + result.expiresInMs
      setSvg(result.svg)
      setRemainingMs(result.expiresInMs)
      setPhase('waiting')
    })
  }, [])

  // A fresh code belongs to a fresh opening, so the surface never shows the previous
  // attempt's code or account name for a moment after being reopened.
  useEffect(() => {
    if (open) request()
  }, [open, request])

  /**
   * Poll while an attempt is live.
   *
   * The interval is a `setTimeout` chain rather than `setInterval` so a slow answer
   * cannot stack requests on top of each other: the next poll is scheduled only after
   * the previous one has been answered.
   */
  useEffect(() => {
    if (!open || phase !== 'waiting' && phase !== 'scanned') return
    let disposed = false
    let timer = 0
    const tick = (): void => {
      timer = window.setTimeout(() => {
        if (disposed) return
        void pollQrLogin().then((result) => {
          if (disposed) return
          const state = result.state ?? 'error'
          if (state === 'done') {
            setPhase('done')
            setUname(result.uname ?? '')
            props.onSignedIn?.()
            return
          }
          if (state === 'expired') {
            setPhase('expired')
            return
          }
          if (state === 'error') {
            // A single failed poll is not a dead attempt: the network may have blipped
            // while the phone was still being raised. The next tick tries again, and
            // only the deadline ends the attempt.
            tick()
            return
          }
          setPhase(state)
          tick()
        })
      }, POLL_INTERVAL_MS)
    }
    tick()
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [open, phase, props.onSignedIn])

  /**
   * Count the code down.
   *
   * The remaining time drives the label, and reaching zero ends the attempt locally
   * rather than waiting for the poll to be refused.
   */
  useEffect(() => {
    if (!open || phase !== 'waiting' && phase !== 'scanned') return
    const timer = window.setInterval(() => {
      const left = deadlineRef.current - Date.now()
      setRemainingMs(Math.max(0, left))
      if (left <= 0) setPhase('expired')
    }, 1000)
    return () => window.clearInterval(timer)
  }, [open, phase])

  const onKey = useCallback(
    (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (!open) return
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onKey])

  if (!open) return null

  const seconds = Math.ceil(remainingMs / 1000)
  const busy = phase === 'starting'
  const live = phase === 'waiting' || phase === 'scanned'

  const title = phase === 'done' ? t('qrSignedInTitle') : t('qrLogin')
  const status = ((): string => {
    if (phase === 'starting') return t('qrStarting')
    if (phase === 'scanned') return t('qrScanned')
    if (phase === 'expired') return t('qrExpired')
    if (phase === 'failed') return failure === '' ? t('qrFailed') : failure
    if (phase === 'done') {
      const name = uname === '' ? props.existingUname ?? '' : uname
      return name === '' ? t('qrSignedInBody') : `${t('qrSignedInAs')}${name}`
    }
    return `${t('qrWaiting')}${seconds}s`
  })()

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 71,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,.42)',
        padding: sp(24),
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          // Wide enough for the code plus its padding at 100 percent scale. The card is
          // sized from its content rather than squeezing the one element whose size
          // cannot shrink without becoming unscannable.
          width: 'auto',
          minWidth: sp(260),
          maxWidth: `min(${sp(340)}px, 100%)`,
          background: 'var(--dsw-alias-bg-layer-1, #fff)',
          color: 'var(--dsw-alias-label-primary, #222)',
          border: `1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))`,
          borderRadius: sp(12),
          boxShadow: '0 18px 48px rgba(0,0,0,.28)',
          padding: sp(20),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: sp(14),
        }}
      >
        <div
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: sp(8),
          }}
        >
          <span style={{ fontSize: sp(14), fontWeight: 600 }}>{title}</span>
          <button
            type="button"
            aria-label={t('close')}
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))',
              cursor: 'pointer',
              fontSize: sp(16),
              lineHeight: 1,
              padding: sp(4),
            }}
          >
            {'\u00d7'}
          </button>
        </div>

        {phase === 'done' ? (
          <div
            style={{
              width: sp(56),
              height: sp(56),
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--state-success-primary, #22c55e)',
              color: '#fff',
              fontSize: sp(28),
              lineHeight: 1,
            }}
          >
            {'\u2713'}
          </div>
        ) : (
          <div
            style={{
              width: sp(220),
              height: sp(220),
              flex: `0 0 ${sp(220)}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: sp(8),
              background: '#fff',
              border: `1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))`,
              // No `overflow: hidden`. The drawing is sized to this square and the quiet
              // zone is part of it, so a mask here would be the very thing that cropped
              // the code rather than a guard against an oversized one.
            }}
          >
            {svg === '' ? (
              <span style={{ fontSize: sp(12), color: 'var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))' }}>
                {phase === 'failed' ? t('qrFailed') : t('qrStarting')}
              </span>
            ) : (
              // The Host already produced this markup from its own encoder, so it holds
              // no reader input. Its drawing carries a `viewBox` and percentage sizes, so
              // it fills the square above exactly rather than at a fixed pixel size that
              // would overflow it. Cropping a finder pattern makes a code unscannable, so
              // nothing on this path is allowed to constrain it.
              <div
                aria-label={t('qrCode')}
                style={{
                  width: '100%',
                  height: '100%',
                  opacity: live ? 1 : 0.25,
                  lineHeight: 0,
                }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        )}

        <div
          style={{
            width: '100%',
            fontSize: sp(12),
            lineHeight: 1.5,
            color: 'var(--dsw-alias-label-secondary, rgba(0,0,0,.65))',
            textAlign: 'center',
          }}
        >
          {status}
        </div>

        <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end', gap: sp(8) }}>
          {phase === 'expired' || phase === 'failed' ? (
            <button
              type="button"
              onClick={request}
              style={{
                border: 'none',
                borderRadius: sp(8),
                background: 'var(--dsw-alias-label-primary, #222)',
                color: 'var(--dsw-alias-bg-layer-1, #fff)',
                cursor: 'pointer',
                fontSize: sp(12),
                padding: `${sp(7)} ${sp(14)}`,
              }}
            >
              {t('qrRefresh')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              border: `1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))`,
              borderRadius: sp(8),
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, #222)',
              cursor: busy ? 'default' : 'pointer',
              fontSize: sp(12),
              padding: `${sp(7)} ${sp(14)}`,
            }}
          >
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}
