/**
 * A modal notice the overlay raises over the host page.
 *
 * ── Why it is not a window ─────────────────────────────────────────────────
 *
 * A danmaku window is a document the reader arranges: it is dragged, resized and
 * kept between reloads. A notice is the opposite. It exists to be read once and
 * dismissed, it belongs to no room, and it must appear over everything without
 * being moved out of the way first. Sharing the window's frame would give the
 * notice dimensions the reader can drag and a place to remember, neither of which
 * means anything for a message that is about to disappear.
 *
 * ── Why it dims the page ───────────────────────────────────────────────────
 *
 * The overlay floats above the host application, so a notice drawn in a corner
 * competes with whatever the reader was doing. Dimming separates the two planes
 * and makes dismissal the obvious next action. The dim is a separate element that
 * also answers a click, because a reader who clicks outside a notice means to
 * close it.
 */

import { useCallback, useEffect, useRef } from 'react'

import type { CopyKey } from './copy.ts'
import { CloseIcon } from './icons.tsx'

/**
 * One button offered at the foot of a notice.
 *
 * The notice renders the buttons in the order given and treats the last one as the
 * primary action, which is where a reader's eye lands first. A notice with no
 * buttons still closes, so an acknowledgement costs no extra declaration.
 */
export interface DialogAction {
  /** The button text. */
  readonly label: string
  /**
   * Whether this action is the one the reader most likely wants.
   *
   * A primary action is filled and every other action is outlined, so two buttons
   * never compete for the same emphasis.
   */
  readonly primary?: boolean
  /**
   * Run when the button is pressed.
   *
   * The notice closes afterwards unless `replaces` is set, so an action that simply
   * acknowledges needs no cleanup of its own.
   */
  readonly onPress?: () => void
  /**
   * Whether pressing this action swaps the notice for another one.
   *
   * A swap is two steps the caller cannot express through `onPress` alone: the notice
   * that is open has to close, and a different one has to take its place. Closing it
   * from inside `onPress` would race the close that follows, and the second notice
   * would be discarded with the first. Setting this lets the layer hand the dismissal
   * to the caller and stand aside.
   */
  readonly replaces?: boolean
}

/** A notice to show over the page. */
export interface DialogSpec {
  /** The heading, drawn in the top left. */
  readonly title: string
  /** The body, drawn left aligned under the heading. */
  readonly message: string
  /** The buttons, left to right; the last is primary when none is marked. */
  readonly actions?: readonly DialogAction[]
}

/** Props for the notice layer. */
export interface DialogProps {
  /** What to show, or null when nothing is open. */
  readonly spec: DialogSpec | null
  /** Called when the reader dismisses the notice. */
  readonly onClose: () => void
  /**
   * Zoom for the notice's contents, as a percentage of their declared size.
   *
   * The notice is part of the overlay the reader may have enlarged, so its text
   * follows the same ratio rather than sitting at a size of its own.
   */
  readonly uiScale: number
  /** Localized label for the close button. */
  readonly t: (key: CopyKey) => string
}

/**
 * A zoomed length, rounded and held at a minimum of one pixel.
 *
 * @param value - the length as written for a zoom of 100.
 * @param scale - the zoom as a factor, where 1 draws the length as written.
 * @returns the length to render.
 */
function px(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale))
}

/**
 * The notice layer.
 *
 * Renders nothing while no notice is open, so the dim cannot swallow a click meant
 * for the page underneath. The layer sits above every danmaku window and the ball's
 * menu, which is why it takes a `z-index` higher than both rather than reusing the
 * overlay's own stacking context.
 *
 * @param props - the notice to show and how to dismiss it.
 * @returns the layer, or null when nothing is open.
 */
export function Dialog(props: DialogProps): React.ReactElement | null {
  const { spec, onClose } = props
  const scale = props.uiScale / 100
  const sp = (value: number): number => px(value, scale)
  const surfaceRef = useRef<HTMLDivElement>(null)

  /**
   * Answer the two keys a reader reaches for when a notice interrupts them.
   *
   * Escape dismisses, which is the same thing the close button does. Enter presses
   * the primary action, so a notice with a single acknowledgement closes on the key
   * a reader's hands are already on.
   *
   * The listener is on the document because the notice does not take focus by
   * itself, and a notice that only answers keys after being clicked would feel
   * broken.
   */
  useEffect(() => {
    if (spec === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Enter') return
      const actions = spec.actions ?? []
      const primary = actions.find((action) => action.primary) ?? actions.at(-1)
      if (primary === undefined) {
        onClose()
        return
      }
      event.preventDefault()
      primary.onPress?.()
      if (primary.replaces !== true) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [spec, onClose])

  /**
   * Move focus into the notice when it opens.
   *
   * Without this a reader who navigates by keyboard would keep typing into the host
   * page behind the dim, with no indication that a notice is waiting.
   */
  useEffect(() => {
    if (spec === null) return
    surfaceRef.current?.focus()
  }, [spec])

  const stop = useCallback((event: React.MouseEvent): void => {
    event.stopPropagation()
  }, [])

  if (spec === null) return null

  const actions = spec.actions ?? []
  // The last action is primary when none declares itself, because a notice that
  // offers several buttons still has one answer the reader most likely wants, and a
  // row of equally weighted buttons makes them pick by reading rather than by shape.
  const declared = actions.findIndex((action) => action.primary === true)
  const primaryIndex = declared !== -1 ? declared : actions.length - 1

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // The dim is a wash rather than a black overlay so the page stays legible
        // enough to recognise, which is what tells the reader the notice belongs to
        // the same application instead of a separate one.
        background: 'rgba(0,0,0,.42)',
        padding: sp(24),
      }}
      onClick={onClose}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        tabIndex={-1}
        onClick={stop}
        style={{
          width: '100%',
          maxWidth: sp(360),
          display: 'flex',
          flexDirection: 'column',
          borderRadius: sp(12),
          border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2))',
          background: 'var(--dsw-alias-bg-layer-1, #fff)',
          color: 'var(--dsw-alias-label-primary, #222)',
          boxShadow: '0 18px 48px rgba(0,0,0,.28)',
          font: `${sp(12)}px/${1.5} system-ui, -apple-system, sans-serif`,
          outline: 'none',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: sp(8),
            padding: `${sp(12)}px ${sp(10)}px ${sp(6)}px ${sp(14)}px`,
          }}
        >
          <span
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              fontSize: sp(13),
              fontWeight: 600,
              // A long heading wraps rather than pushing the close button off the
              // card, which is why it is allowed to grow vertically here.
              overflowWrap: 'anywhere',
            }}
          >
            {spec.title}
          </span>
          <button
            type="button"
            onClick={onClose}
            title={props.t('close')}
            aria-label={props.t('close')}
            style={{
              flex: '0 0 auto',
              width: sp(22),
              height: sp(22),
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              marginTop: -sp(2),
              fontSize: sp(12),
              lineHeight: 1,
              borderRadius: sp(5),
              border: '1px solid transparent',
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary, #999)',
              cursor: 'pointer',
            }}
          >
            <CloseIcon />
          </button>
        </div>

        <p
          style={{
            margin: 0,
            padding: `0 ${sp(14)}px ${sp(14)}px`,
            fontSize: sp(12),
            color: 'var(--dsw-alias-label-secondary, #666)',
            textAlign: 'left',
            // The message carries room ids and file names, which have no spaces to
            // break at, so a long one has to wrap inside the word.
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap',
          }}
        >
          {spec.message}
        </p>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: sp(8),
            padding: `0 ${sp(14)}px ${sp(14)}px`,
          }}
        >
          {actions.map((action, index) => {
            const primary = index === primaryIndex
            return (
              <button
                key={`${action.label}-${index}`}
                type="button"
                onClick={() => {
                  action.onPress?.()
                  if (action.replaces !== true) onClose()
                }}
                style={{
                  minWidth: sp(64),
                  padding: `${sp(6)}px ${sp(14)}px`,
                  fontSize: sp(12),
                  borderRadius: sp(7),
                  // The primary action is filled and the rest are outlined, so the
                  // row reads as one recommendation plus alternatives rather than as
                  // a set of equal choices.
                  border: primary ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.32))',
                  background: primary ? 'var(--dsw-alias-label-primary, #222)' : 'transparent',
                  color: primary ? 'var(--dsw-alias-bg-layer-1, #fff)' : 'var(--dsw-alias-label-secondary, #666)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {action.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
