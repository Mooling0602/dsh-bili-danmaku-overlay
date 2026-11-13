/**
 * The event log a session refresh leaves behind.
 *
 * Why it is a file rather than a memory list
 *
 * A refresh can rotate the session token and invalidate the old one, so when it goes
 * wrong the reader needs to know which step failed. The failure is not reproducible: the
 * old token is gone by then, so a second attempt measures a different situation. The only
 * way to answer "did it work" afterwards is to have written down what each step returned
 * while it ran.
 *
 * What it holds
 *
 * One JSON record per event, appended. Records carry the endpoint, the HTTP status, the
 * numeric codes the payload answered with and the step's own verdict. They never carry a
 * token, a cookie or a refresh token, because this file is read and quoted during
 * debugging and a secret in it would outlive the session it belongs to.
 *
 * Why it is bounded
 *
 * The file is appended to and never truncated by this module, so a reader who wants the
 * history keeps it. `readRefreshLog` returns only the newest records, which is what a
 * diagnosis needs and what the diagnostic route can carry without growing without limit.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory both the credential and this log live in. */
const LOG_DIR = join(homedir(), '.dsh', 'bili-danmaku-overlay')

/** The file session refresh events are appended to. */
export const REFRESH_LOG_FILE = join(LOG_DIR, 'refresh.log')

/** How many records a read returns, newest last. */
const READ_LIMIT = 60

/** Which part of a refresh an event describes. */
export type RefreshStep =
  | 'check'
  | 'correspond'
  | 'refresh'
  | 'confirm'
  | 'store'
  | 'skip'

/** What one event recorded. */
export interface RefreshEvent {
  /** When the step ran, as an ISO timestamp. */
  readonly at: string
  /** Which step this is. */
  readonly step: RefreshStep
  /** The step's own verdict. */
  readonly outcome: 'ok' | 'failed' | 'skipped'
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number
  /** The payload's outer `code`, when the response carried one. */
  readonly code: number | null
  /** The payload's `data.code` or `data.refresh`, when present. */
  readonly detail: string
  /** A short note that names what the step concluded. */
  readonly note: string
}

/**
 * Append one event.
 *
 * A log that cannot be written must not change the outcome of a refresh: the refresh is
 * the thing being done, and failing it over its own diary would be the wrong trade. The
 * caller therefore never learns about a write failure here.
 *
 * @param event - the event to record.
 */
export function recordRefreshEvent(event: RefreshEvent): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(REFRESH_LOG_FILE, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Nothing to do and nothing to report: see the docstring.
  }
}

/**
 * Read the newest events.
 *
 * A line that does not parse is skipped rather than failing the read, because a crash
 * mid-append can leave a partial line at the end and the records before it are still
 * worth returning.
 *
 * @param limit - how many records to return, newest last.
 * @returns the events that could be read, oldest first.
 */
export function readRefreshLog(limit = READ_LIMIT): readonly RefreshEvent[] {
  let text: string
  try {
    text = readFileSync(REFRESH_LOG_FILE, 'utf8')
  } catch {
    return []
  }
  const events: RefreshEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as RefreshEvent
      if (typeof parsed.at === 'string' && typeof parsed.step === 'string') events.push(parsed)
    } catch {
      // A partial line from an interrupted write. The records around it stand.
    }
  }
  return events.slice(-limit)
}
