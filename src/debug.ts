/**
 * The debug tool the agent calls while investigating a room.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Every fact worth having during a danmaku bug sits inside the Host process: the
 * live socket's state, whether the handshake was answered, how far the history
 * poller has backed off, and when it last read. The page renders a smoothed
 * version of that and reports it only as a colour, so diagnosing "the danmaku
 * stopped" from the outside means guessing at which of four transports went
 * quiet. This tool answers that directly, with no page reload and no restart.
 *
 * ── Why it is a tool and not a route ───────────────────────────────────────
 *
 * A route would be reachable from the page and from anything else that can send
 * a request, and it would publish the Host's internals on the same origin the
 * overlay runs on. The tool registry is the channel the agent already speaks, so
 * the diagnostic surface stays as narrow as the agent's own access.
 *
 * ── Why it never writes to Bilibili ────────────────────────────────────────
 *
 * The tool reports and resets local state. It does not send a danmaku, and it
 * does not forge an upstream request, because a debugging tool that can reach a
 * stranger's chat is a liability rather than a diagnostic.
 */

import type { ToolDefinition, Tools } from './types.ts'
import { describeSockets, resetTransportStats } from './stream.ts'
import { readRoomLoops } from './poller.ts'

/** One tracked upstream stream, as the model sees it. */
interface StreamReport {
  /** Real room id. */
  readonly roomId: number
  /** `connecting`, `open`, `closed`, `offline` or `error`. */
  readonly state: string
  /** Whether the comet server answered the handshake on the current socket. */
  readonly authenticated: boolean
  /** Comet messages decoded since the counters were last reset. */
  readonly messages: number
  /** Danmaku items forwarded to the page since the counters were last reset. */
  readonly items: number
  /** Reconnects completed since the counters were last reset. */
  readonly reconnects: number
  /** Milliseconds since the last message arrived, or null when none has. */
  readonly lastMessageAgeMs: number | null
  /** How long the stream has been attached, in milliseconds. */
  readonly ageMs: number
  /** Last status text sent to the page, empty when healthy. */
  readonly lastStatus: string
}

/** One room's history loop, as the model sees it. */
interface RoomReport {
  /** Real room id. */
  readonly roomId: number
  /** Current poll interval; this is what grows to 30s under a throttle. */
  readonly intervalMs: number
  /** Consecutive clean responses. */
  readonly streak: number
  /** Items in the most recent read. */
  readonly items: number
  /** Milliseconds since the last successful read. */
  readonly ageMs: number
  /** Whether a read timer is currently armed. */
  readonly polling: boolean
  /** Last error text, empty when healthy. */
  readonly error: string
}

/** What the tool returns. */
interface StatusReport {
  /** Wall-clock time the snapshot was taken, epoch ms. */
  readonly now: number
  /** Upstream transports, one per room currently streaming. */
  readonly transports: readonly StreamReport[]
  /** History loops, one per room currently being polled. */
  readonly rooms: readonly RoomReport[]
  /** A one line reading of the report, so the common cases need no interpretation. */
  readonly diagnosis: string
}

/**
 * Turn the raw counters into a reading of the failure.
 *
 * The three states this separates are the ones that look identical from the page:
 * a socket that never authenticated, a socket that is authenticated but silent,
 * and a poller that has backed off. Each has a different cause, so naming the one
 * in play is most of the diagnosis.
 *
 * @param transports - the live transports.
 * @param rooms - the history loops.
 * @returns one sentence, or an empty string when there is nothing to report.
 */
function diagnose(transports: readonly StreamReport[], rooms: readonly RoomReport[]): string {
  if (transports.length === 0 && rooms.length === 0) {
    return 'No room is streaming or polling. The page has not opened a room since the Host started, or every window is closed.'
  }

  for (const stream of transports) {
    if (stream.state === 'offline') return `Room ${stream.roomId} reports itself not live, so no danmaku will arrive until the stream starts.`
    if (stream.lastStatus !== '' && stream.state === 'error') return `Room ${stream.roomId} failed with: ${stream.lastStatus}`
    if (stream.state === 'connecting' && stream.ageMs > 15_000 && !stream.authenticated) {
      return `Room ${stream.roomId} has been connecting for ${Math.round(stream.ageMs / 1000)}s without a handshake reply, which points at the comet host rather than at the token.`
    }
    if (stream.state === 'open' && !stream.authenticated) {
      return `Room ${stream.roomId} has an open socket but no handshake reply, so it is connected to a comet host that is not accepting the session.`
    }
    if (stream.authenticated && stream.messages === 0) {
      return `Room ${stream.roomId} authenticated but has received no message at all, so the socket is idle rather than the room being quiet.`
    }
    if (stream.authenticated && stream.lastMessageAgeMs !== null && stream.lastMessageAgeMs > 120_000) {
      return `Room ${stream.roomId} is authenticated but silent for ${Math.round(stream.lastMessageAgeMs / 1000)}s, so the socket has most likely been dropped by a middlebox.`
    }
  }

  for (const room of rooms) {
    if (room.error !== '') return `Room ${room.roomId} history reads are failing: ${room.error}`
    if (room.intervalMs >= 30_000) return `Room ${room.roomId} history has backed off to the 30s ceiling, which means reads are being throttled or failing.`
    if (room.ageMs > Math.max(10_000, room.intervalMs * 3)) {
      return `Room ${room.roomId} history is stale by ${Math.round(room.ageMs / 1000)}s against a ${room.intervalMs}ms interval, so the poll loop is not keeping up.`
    }
    if (!room.polling && room.ageMs > 5_000) return `Room ${room.roomId} has stopped polling, so nothing will refresh until the page asks again.`
  }

  return 'Every transport is attached and every poll loop is current, so nothing in the Host is stalled.'
}

/**
 * Collect one status report.
 *
 * @param reset - whether to clear the counters afterwards.
 * @returns the report the tool renders.
 */
function buildReport(reset: boolean): StatusReport {
  const now = Date.now()
  const streams = describeSockets()

  const transports: StreamReport[] = streams.map((stream) => ({
    roomId: stream.roomId,
    state: stream.state,
    authenticated: stream.authenticated,
    messages: stream.messages,
    items: stream.items,
    reconnects: stream.reconnects,
    lastMessageAgeMs: stream.lastMessageAt === 0 ? null : now - stream.lastMessageAt,
    ageMs: now - stream.startedAt,
    lastStatus: stream.lastStatus,
  }))

  const rooms: RoomReport[] = readRoomLoops().map((room) => ({
    roomId: room.roomId,
    intervalMs: room.intervalMs,
    streak: room.streak,
    items: room.items,
    ageMs: room.ageMs,
    polling: room.polling,
    error: room.error,
  }))

  const report: StatusReport = { now, transports, rooms, diagnosis: diagnose(transports, rooms) }
  // Reset after the read, so this call still reports the window that just closed
  // rather than the empty one that follows it.
  if (reset) resetTransportStats()
  return report
}

/**
 * Render a report as the text the model reads.
 *
 * @param value - the value `execute` returned.
 * @returns the report as lines, diagnosis first.
 */
function format(value: unknown): string {
  const report = value as StatusReport | null
  if (!report || typeof report !== 'object') return 'No status was produced.'

  const lines = [`Diagnosis: ${report.diagnosis}`, '']

  if (report.transports.length === 0) {
    lines.push('Transports: none')
  } else {
    lines.push(`Transports (${report.transports.length}):`)
    for (const stream of report.transports) {
      const age = stream.lastMessageAgeMs === null ? 'never' : `${Math.round(stream.lastMessageAgeMs / 1000)}s ago`
      lines.push(
        `- room ${stream.roomId}: ${stream.state}` +
          `, authenticated=${String(stream.authenticated)}` +
          `, messages=${stream.messages}` +
          `, items=${stream.items}` +
          `, reconnects=${stream.reconnects}` +
          `, last message ${age}` +
          `, attached ${Math.round(stream.ageMs / 1000)}s` +
          (stream.lastStatus === '' ? '' : `, status="${stream.lastStatus}"`),
      )
    }
  }

  lines.push('')
  if (report.rooms.length === 0) {
    lines.push('History loops: none')
  } else {
    lines.push(`History loops (${report.rooms.length}):`)
    for (const room of report.rooms) {
      lines.push(
        `- room ${room.roomId}: interval=${room.intervalMs}ms` +
          `, streak=${room.streak}` +
          `, items=${room.items}` +
          `, age=${Math.round(room.ageMs / 1000)}s` +
          `, polling=${String(room.polling)}` +
          (room.error === '' ? '' : `, error="${room.error}"`),
      )
    }
  }

  return lines.join('\n')
}

/**
 * Build the status tool.
 *
 * @returns the definition to register.
 */
function statusTool(): ToolDefinition {
  return {
    name: 'bili_danmaku_status',
    description:
      'Report the live state of the Bilibili danmaku overlay: every upstream transport with its socket state, whether the comet handshake was answered, and its message and reconnect counters, plus every room history loop with its poll interval, backoff streak and staleness. Use it when danmaku appear to stop updating, because it separates a dead socket from a throttled poller from an offline room. Pass reset to clear the counters after reporting, so a second call measures only the interval between the two.',
    parameters: {
      type: 'object',
      properties: {
        reset: {
          type: 'boolean',
          description: 'Clear the per-transport counters after reporting them. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args: unknown, value: unknown) {
        return [{ type: 'text', text: format(value) }]
      },
    },
    execute(args: unknown): StatusReport {
      const reset = typeof args === 'object' && args !== null && (args as { reset?: unknown }).reset === true
      return buildReport(reset)
    },
  }
}

/**
 * Mount the debug tools.
 *
 * @param tools - the tool registry.
 * @returns a teardown callback that unregisters every tool.
 */
export function registerDebugTools(tools: Tools): () => void {
  const dispose = tools.register(statusTool())
  return () => {
    dispose()
  }
}
