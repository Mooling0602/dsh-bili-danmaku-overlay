/**
 * Shared types for the Host half.
 *
 * These describe the wire shapes the overlay renders and the subset of the
 * Cordis Host context this plugin touches, so the rest of the sources can be
 * checked without depending on the Harness package's own declarations.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The Cordis Host context slice this plugin uses. */
export interface HostPluginContext {
  /**
   * Register a disposable effect; the callback runs immediately and its return
   * value is called on teardown.
   *
   * @param effect - factory returning the teardown callback.
   * @param label - diagnostic label shown in the Host log.
   */
  effect(effect: () => (() => void) | void, label?: string): void
  /** The HTTP server the Harness page is served from. */
  webServer: WebServer
}

/** The Harness `webServer` service surface. */
export interface WebServer {
  /**
   * Mount one route.
   *
   * @param route - the route to mount.
   * @returns a teardown callback.
   */
  register(route: RouteRegistration): () => void
}

/** One route mount request. */
export interface RouteRegistration {
  /** `prefix` matches every path under `path`. */
  readonly kind: 'prefix'
  /** Path prefix, always starting with a slash. */
  readonly path: string
  /** Request handler. */
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

/** A danmaku as the overlay renders it. */
export interface DanmakuItem {
  /** `danmaku` for chat, `superchat` for a paid message, `enter` for a join notice. */
  readonly kind: 'danmaku' | 'superchat' | 'enter'
  /** Stable identity shared with the history endpoint, used for de-duplication. */
  readonly id: string
  /** Body text. */
  readonly text: string
  /** Display name of the sender. */
  readonly user: string
  /** RGB integer from Bilibili; `16777215` when unset. */
  readonly color: number
  /** Whether the sender is a room moderator. */
  readonly admin: boolean
  /** Fans medal, when the sender wears one. */
  readonly medal: { readonly name: string; readonly level: number } | null
  /** Guard level: 0 none, 1 governor, 2 admiral, 3 captain. */
  readonly guard: number
  /** Super chat price in yuan; present on `superchat` items only. */
  readonly price?: number
  /** Set on items that came from the history endpoint. */
  readonly history?: boolean
}

/** One raw comet-server message, before it is narrowed to a `DanmakuItem`. */
export interface CometMessage {
  readonly cmd?: string
  readonly info?: unknown
  readonly data?: unknown
  /** Some commands carry the message id at the top level instead of in `info`. */
  readonly msg_id?: unknown
  /** Present only on the synthetic auth-reply message; 0 means accepted. */
  readonly authCode?: number
}

/** Result of resolving a room id against `room_init`. */
export interface ResolvedRoom {
  /** The real room id, which differs from the short id a user may type. */
  readonly roomId: number
  /** The configured short id, `0` when none is set. */
  readonly shortId: number
  /** `1` while the room is live, `2` when the stream is not running. */
  readonly liveStatus: number
  /** The room's own title, empty when the resolver did not report one. */
  readonly title: string
  /** The streamer's display name, empty when unavailable. */
  readonly uname: string
}

/** Danmaku token plus the comet host list that accepts it. */
export interface DanmuInfo {
  /** Authentication token sent in the op-7 handshake. */
  readonly token: string
  /** Candidate comet hosts, tried in order on reconnect. */
  readonly hosts: readonly DanmuHost[]
  /**
   * Uid the handshake authenticates as.
   *
   * The comet server refuses an anonymous op-7 with an error and closes the
   * socket, so this is the signed-in account's uid and never 0 while credentials
   * are configured.
   */
  readonly uid: number
}

/** One comet server entry. */
export interface DanmuHost {
  /** Hostname used to build `wss://<host>/sub`. */
  readonly host: string
}
