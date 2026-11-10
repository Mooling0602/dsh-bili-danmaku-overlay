/**
 * Inline vector icons for the overlay's buttons.
 *
 * The buttons used to hold characters such as `×`, `−` and `⟳`. A character is a
 * glyph, not an icon: its shape, baseline and advance width come from whatever font
 * the page resolves, so the same button could sit off centre on one machine and be
 * a different weight on another. These paths are drawn on a fixed 16 unit grid and
 * centred on that grid, which makes every icon the same optical size everywhere.
 *
 * Each icon inherits `currentColor` and sizes itself from the surrounding font size,
 * so a button only sets colour and font-size; no icon carries its own palette.
 */

import type { JSX } from 'react'

/** Shared sizing and stroke for every icon. */
const BASE = {
  width: '1em',
  height: '1em',
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  // Heavier than a hairline on purpose. These render at about 13px, so a 1.75 unit
  // stroke on a 16 unit grid lands near 1.4 device pixels once scaled down; a
  // thinner one reads as a grey outline instead of an icon.
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  // Keeps a stroked path from being read as decoration by assistive technology.
  'aria-hidden': true,
  focusable: 'false',
} as const

/**
 * @returns an icon that closes or dismisses, drawn as a symmetrical cross.
 */
export function CloseIcon(): JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/**
 * @returns an icon for minimizing, a single horizontal rule centred on the grid.
 */
export function MinimizeIcon(): JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M3.5 8h9" />
    </svg>
  )
}

/**
 * @returns an icon that reloads, a circular arrow with a gap and an arrowhead.
 */
export function RefreshIcon(): JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.6v3.2h-3.2" />
    </svg>
  )
}

/**
 * @returns an icon that restores a minimized window, a panel with two offset corners.
 */
export function RestoreIcon(): JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M3 6.5V13h6.5" />
      <path d="M6.5 3H13v6.5" />
      <path d="M13 3L6.5 9.5" />
    </svg>
  )
}

/**
 * @returns an icon for hiding a window, a panel with an arrow withdrawing into it.
 */
export function HidePanelIcon(): JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M2.5 3.5h11v9h-11z" />
      <path d="M5.5 8h5" />
    </svg>
  )
}

/**
 * @returns an icon for showing a window, the same panel with the rule restored.
 */
export function ShowPanelIcon(): JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M2.5 3.5h11v9h-11z" />
      <path d="M5.5 8h5M8 5.5v5" />
    </svg>
  )
}

/**
 * @returns an icon for renaming, a pencil resting on its own baseline.
 */
export function EditIcon(): JSX.Element {
  return (
    <svg {...BASE}>
      <path d="M11.2 2.6l2.2 2.2-7.6 7.6-3 .8.8-3z" />
      <path d="M9.6 4.2l2.2 2.2" />
    </svg>
  )
}
