/**
 * Client half entry point.
 *
 * Registers the dictionaries and injects the overlay into `shell.overlay`, the
 * slot that renders above the application and stays mounted across route
 * changes — which is what "keep watching the room while I work" requires.
 */

import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'

import { ConfigPage } from './config-page.tsx'
import { en, zh } from './copy.ts'
import { Overlay, type OverlayProps } from './overlay.tsx'

/** Locale namespace this plugin owns. */
const NS = 'bili-danmaku-overlay'

/** Package name the Plugins page keys a bundle's own configuration by. */
const BUNDLE = '@local/bili-danmaku-overlay'

/**
 * Settings namespaces this page waits for.
 *
 * The Host keys forms by profile entry id, and a bundle installed through its own
 * patch is served as `include:<patch id>`. The bare id is listed too, for a
 * profile that names the package directly and so is served under the plain id.
 */
const NAMESPACES = ['include:bili-danmaku-overlay', 'bili-danmaku-overlay'] as const

/**
 * The settings service face this plugin uses.
 *
 * Only the two members the registration touches are declared: `whileServed` to
 * wait for the Host to serve the namespace, and `get` to hand the page the scope
 * it edits. `get` is typed to the primitive's own scope so the page and the
 * service can never disagree about the snapshot shape.
 */
interface ConfigForms {
  describe(): { state?: { value?: { namespaces?: readonly { readonly ns: string }[] } } }
  get<T>(entryId: string): SettingsFormScope<T>
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

/** The slice of the Client context this plugin uses. */
interface ClientContext {
  effect(effect: () => (() => void) | void, label?: string): void
  locale: {
    register(namespace: string, dictionaries: Record<string, unknown>): () => void
    bind(namespace: string): (key: Parameters<OverlayProps['t']>[0]) => string
  }
  configForms?: ConfigForms
  get?(name: string): unknown
  slots: {
    inject(
      name: string,
      register: () => () => void,
    ): void
    register(
      options: {
        readonly name: string
        readonly id?: string
        readonly key?: string
        readonly order?: number
        readonly locale?: string
        readonly inject?: () => unknown
      },
      component: (props: never) => unknown,
    ): () => void
  }
}

/** Services this plugin needs mounted before `apply` runs. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Find the settings namespace the Host serves for this bundle.
 *
 * The settings service keys every form by the profile entry id (`include:bili-danmaku-overlay`
 * here), not by the package name the slot is keyed by, so the two cannot be used
 * interchangeably. Matching on the trailing segment accepts every form the id
 * takes: a bare `bili-danmaku-overlay`, or any patch prefix the profile adds.
 *
 * @param forms - the settings service.
 * @param served - namespaces the Host currently serves, when already known.
 * @returns the namespace, or undefined when the Host serves none for us.
 */
function ourNamespace(forms: ConfigForms, served?: ReadonlySet<string>): string | undefined {
  const candidates = served
    ? [...served]
    : (forms.describe().state?.value?.namespaces ?? []).map((view) => view.ns)
  return candidates.find(
    (ns) => ns === BUNDLE || ns.endsWith('bili-danmaku-overlay'),
  )
}

/**
 * Register the overlay and the bundle's configuration page.
 *
 * The configuration page is registered here rather than left to automatic
 * projection: the Plugins page renders a bundle's settings only from entries in
 * `plugins.bundle.config`, keyed by the package name, so a bundle that never
 * registers one shows an empty detail page even though the Host serves its
 * schema.
 *
 * The slot hands a bundle-level page only `view`; the `form` it documents is
 * filled for a row or an official plugin, so a bundle page must reach the
 * settings service itself to read and write its own fields.
 *
 * @param ctx - the Cordis Client context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bili-danmaku-overlay: dictionaries')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'bili-danmaku-overlay',
        order: 40,
        locale: NS,
        inject: () => ({ t }),
      },
      Overlay,
    ),
  )

  const forms = ctx.configForms
  if (!forms) return

  // Wait until the Host actually serves our namespace before drawing the page:
  // a form whose fields nothing accepts is worse than no page at all.
  //
  // `whileServed` also derives the entry id, which is a profile entry id rather
  // than the package name and so cannot be hardcoded here.
  ctx.effect(
    () =>
      forms.whileServed(NAMESPACES, (served) => {
        // `served` is the Host's own list, so it already carries the entry id form
        // the form lookup needs; the describe fallback only covers a miss.
        const ns = ourNamespace(forms, served)
        if (!ns) return () => {}

        let disposeSlot: (() => void) | undefined
        ctx.slots.inject('plugins.bundle.config', () => {
          disposeSlot = ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: BUNDLE,
              locale: NS,
              inject: () => ({ t, form: forms.get<Record<string, unknown>>(ns) }),
            },
            ConfigPage as (props: never) => unknown,
          )
          return disposeSlot
        })

        // Release the slot registration when the namespace stops being served,
        // so the page cannot outlive the form it reads.
        return () => {
          disposeSlot?.()
          disposeSlot = undefined
        }
      }),
    'bili-danmaku-overlay: configuration page',
  )
}
