/**
 * Host half of the Bilibili danmaku overlay.
 *
 * ── Why the Host owns the upstream connection ──────────────────────────────
 *
 * Bilibili's comet server validates the WebSocket `Origin` and refuses sockets
 * opened from the Harness page. The Host therefore holds the upstream socket and
 * the page only reads same-origin server-sent events, which has the useful side
 * effect of keeping the danmaku token out of the browser.
 *
 * ── Why no credential is configurable here ─────────────────────────────────
 *
 * `SESSDATA` and `bili_jct` are read from the Harness credential document and are
 * deliberately absent from `Config`, so a settings export or a profile patch can
 * never carry a login token. See `src/credentials.ts`.
 */

import type { HostPluginContext } from './src/types.ts'
import { BiliError } from './src/credentials.ts'
import { registerDebugTools } from './src/debug.ts'
import { ROUTE_PREFIX, route } from './src/routes.ts'
import type { Config } from './src/config.ts'

export { Config } from './src/config.ts'

/** Services this plugin needs mounted before `apply` runs. */
export const inject = ['webServer', 'tools']

/**
 * Mount the overlay's routes.
 *
 * @param ctx - the Cordis Host context.
 * @param config - the parsed plugin configuration.
 */
export function apply(ctx: HostPluginContext, config?: Partial<Config>): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          try {
            await route(request, response, config)
          } catch (error) {
            const status = error instanceof BiliError ? 200 : 500
            const message = error instanceof Error && error.message !== '' ? error.message : '未知错误'

            // A stream that already opened cannot switch to a JSON error: the
            // headers are gone. Dropping the socket lets EventSource reconnect.
            if (response.headersSent) {
              response.destroy()
              return
            }
            response.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            response.end(
              JSON.stringify({
                ok: false,
                error: message,
                code: error instanceof BiliError ? error.code : undefined,
              }),
            )
          }
        },
      }),
    'bili-danmaku-overlay: Bilibili danmaku routes',
  )

  // The registry is a hard dependency, so `ctx.tools` is always present here.
  ctx.effect(() => {
    const dispose = registerDebugTools(ctx.tools)
    return dispose
  }, 'bili-danmaku-overlay: debug tools')
}
