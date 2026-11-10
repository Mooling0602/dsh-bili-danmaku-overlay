/**
 * The Bilibili comet protocol: packet encoding, frame decoding, and the mapping
 * from raw messages to the compact items the overlay renders.
 *
 * ── The framing ────────────────────────────────────────────────────────────
 *
 * Every packet is a 16-byte header followed by a body:
 *
 *     offset 0  u32  total packet length, header included
 *     offset 4  u16  header length, always 16
 *     offset 6  u16  protocol version
 *     offset 8  u32  operation
 *     offset 12 u32  sequence, always 1
 *
 * Version 2 bodies are zlib-deflated and, once inflated, contain further packets
 * — so decoding is recursive rather than a single pass.
 *
 * ── Why ids matter ─────────────────────────────────────────────────────────
 *
 * The live socket and the history endpoint describe the same message with
 * different shapes. `info[0][15].extra` carries `id_str`, which the history
 * endpoint also returns, so both sources de-duplicate against each other. The
 * obvious-looking alternatives are not stable: `info[0][5]` is only a
 * seconds-resolution timestamp, and `info[0][7]` is a per-user hash that repeats.
 */

import { inflateSync } from 'node:zlib'

import type { CometMessage, DanmakuItem } from './types.ts'

/** Operation codes used by this plugin. */
const OP_HEARTBEAT = 2
const OP_MESSAGE = 5
const OP_AUTH = 7
const OP_AUTH_REPLY = 8

/** Synthetic `cmd` marking the server's answer to the handshake. */
export const AUTH_REPLY_CMD = '__auth_reply__'

/** Protocol version carrying a zlib-deflated body. */
const VERSION_ZLIB = 2

/** Guards against a malformed or hostile frame nesting without end. */
const MAX_DEPTH = 4

/**
 * Keeps fallback ids distinct when a message carries no stable identifier.
 *
 * Module-level rather than per-connection so two overlapping sockets cannot mint
 * the same id in the same millisecond.
 */
let fallbackCounter = 0

/**
 * Encode one comet packet.
 *
 * @param operation - the operation code.
 * @param payload - the body; empty for a heartbeat.
 * @returns the framed packet.
 */
export function encodePacket(operation: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(16)
  header.writeUInt32BE(16 + body.length, 0)
  header.writeUInt16BE(16, 4)
  header.writeUInt16BE(1, 6)
  header.writeUInt32BE(operation, 8)
  header.writeUInt32BE(1, 12)
  return Buffer.concat([header, body])
}

/**
 * Build the op-7 authentication packet.
 *
 * The uid is the signed-in account, not 0: the server refuses an anonymous
 * handshake with an error frame and drops the socket, so an anonymous packet
 * silently yields a connection that never delivers danmaku.
 *
 * @param roomId - the real room id.
 * @param token - the token from `getDanmuInfo`.
 * @param uid - the signed-in account uid.
 * @returns the framed packet.
 */
export function authPacket(roomId: number, token: string, uid: number): Buffer {
  return encodePacket(
    OP_AUTH,
    JSON.stringify({
      uid,
      roomid: roomId,
      protover: 2,
      platform: 'web',
      type: 2,
      key: token,
    }),
  )
}

/**
 * Build the op-2 heartbeat packet.
 *
 * @returns the framed packet, with an empty body.
 */
export function heartbeatPacket(): Buffer {
  return encodePacket(OP_HEARTBEAT, '')
}

/**
 * Inflate a version-2 body.
 *
 * @param version - the packet's protocol version.
 * @param body - the raw body.
 * @returns the inflated bytes, or `null` when this body is not deflated.
 */
function decompressBody(version: number, body: Buffer): Buffer | null {
  if (version !== VERSION_ZLIB) return null
  try {
    return inflateSync(body)
  } catch {
    return null
  }
}

/**
 * Decode every op-5 message inside one comet frame, including nested frames.
 *
 * A malformed inner payload is skipped rather than failing the whole frame: one
 * bad message must not interrupt a live stream.
 *
 * @param buffer - the frame bytes.
 * @returns the decoded messages, in arrival order.
 */
export function decodeFrame(buffer: Buffer): CometMessage[] {
  const messages: CometMessage[] = []

  const walk = (payload: Buffer, depth: number): void => {
    if (depth > MAX_DEPTH || payload.length < 16) return
    let offset = 0

    while (offset + 16 <= payload.length) {
      const length = payload.readUInt32BE(offset)
      if (length < 16 || offset + length > payload.length) break

      const headerLength = payload.readUInt16BE(offset + 4)
      const version = payload.readUInt16BE(offset + 6)
      const operation = payload.readUInt32BE(offset + 8)
      const body = payload.subarray(offset + headerLength, offset + length)
      offset += length

      const inflated = decompressBody(version, body)
      if (inflated) {
        walk(inflated, depth + 1)
        continue
      }

      if (version !== 0 && version !== 1) continue

      if (operation === OP_MESSAGE) {
        try {
          messages.push(JSON.parse(body.toString('utf8')) as CometMessage)
        } catch {
          /* ignore malformed payloads */
        }
        continue
      }

      // The server answers the handshake with its own op. A non-zero code means
      // the session was refused — an anonymous uid, a stale token or a room
      // under risk control — and the socket is about to close. Without reading
      // this, a refused auth is indistinguishable from a healthy connection.
      if (operation === OP_AUTH_REPLY) {
        let code = 0
        try {
          code = Number((JSON.parse(body.toString('utf8')) as { code?: unknown }).code ?? 0)
        } catch {
          /* treat an unreadable reply as accepted; the close handler still fires */
        }
        messages.push({ cmd: AUTH_REPLY_CMD, authCode: code })
      }
    }
  }

  walk(buffer, 0)
  return messages
}

/**
 * Read the stable message id shared by the live stream and the history endpoint.
 *
 * @param info - the raw `info` array of a `DANMU_MSG` message.
 * @param message - the whole message, for the `msg_id` fallback.
 * @returns a stable id.
 */
function danmakuId(info: unknown, message: CometMessage): string {
  const head = Array.isArray(info) ? (info as unknown[]) : []
  const extraField = ((head[0] as unknown[] | undefined)?.[15] as
    | { extra?: unknown }
    | undefined)?.extra

  let extra: { id_str?: unknown } | null = null
  if (typeof extraField === 'string' && extraField !== '') {
    try {
      extra = JSON.parse(extraField) as { id_str?: unknown }
    } catch {
      extra = null
    }
  }

  const candidates: unknown[] = [extra?.id_str, message.msg_id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }

  const millis = Number(head[4])
  const base = Number.isFinite(millis) && millis > 0 ? String(millis) : String(Date.now())
  return `${base}-${fallbackCounter++}`
}

/** Options narrowing which message kinds are converted. */
export interface ConvertOptions {
  /** Whether `INTERACT_WORD` notices become items. */
  readonly showEnterMessages: boolean
  /** Whether super chats become items. */
  readonly showSuperChat: boolean
}

/**
 * Narrow one decoded comet message into a renderable item.
 *
 * @param message - a decoded comet message.
 * @param options - which kinds are enabled.
 * @returns the item, or `null` when the message is uninteresting or malformed.
 */
export function toDanmaku(message: CometMessage, options: ConvertOptions): DanmakuItem | null {
  const command = String(message.cmd ?? '')
  const info = message.info

  if (command.startsWith('DANMU_MSG') && Array.isArray(info)) {
    const text = String(info[1] ?? '').trim()
    if (text === '') return null

    const user = Array.isArray(info[2]) ? (info[2] as unknown[]) : []
    const medalInfo = Array.isArray(info[3]) ? (info[3] as unknown[]) : []
    const head = Array.isArray(info[0]) ? (info[0] as unknown[]) : []

    return {
      kind: 'danmaku',
      id: danmakuId(info, message),
      text,
      user: String(user[1] ?? ''),
      color: Number(head[3] ?? 16777215) || 16777215,
      admin: Boolean(user[2]),
      medal:
        medalInfo.length > 0
          ? { name: String(medalInfo[1] ?? ''), level: Number(medalInfo[0] ?? 0) }
          : null,
      guard: Number(info[7] ?? 0),
    }
  }

  if (command === 'SUPER_CHAT_MESSAGE' && options.showSuperChat) {
    const data = (message.data ?? {}) as {
      id?: unknown
      message?: unknown
      price?: unknown
      user_info?: { uname?: unknown }
    }
    const text = String(data.message ?? '').trim()
    if (text === '') return null

    return {
      kind: 'superchat',
      id: String(data.id ?? `${Date.now()}-${fallbackCounter++}`),
      text,
      user: String(data.user_info?.uname ?? ''),
      price: Number(data.price ?? 0),
      color: 16777215,
      admin: false,
      medal: null,
      guard: 0,
    }
  }

  if (command === 'INTERACT_WORD' && options.showEnterMessages) {
    const data = (message.data ?? {}) as { uname?: unknown }
    const user = String(data.uname ?? '')
    if (user === '') return null

    return {
      kind: 'enter',
      id: `enter-${Date.now()}-${fallbackCounter++}`,
      text: '进入了直播间',
      user,
      color: 16777215,
      admin: false,
      medal: null,
      guard: 0,
    }
  }

  return null
}
