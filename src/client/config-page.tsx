/**
 * The bundle's configuration page.
 *
 * The Plugins page renders this on the bundle's own detail page. It is built from
 * the same primitives the official settings pages use, so the rows carry the
 * platform's typography, overridden badges, reset controls and save flow instead
 * of a hand-rolled imitation: `SettingsFormModel` owns the staging, validation
 * and one-shot write, `SettingsForm` draws the frame, and `SettingsValueField`
 * draws each row.
 *
 * Nothing here writes per keystroke. Every control stages a draft and the form's
 * save performs one revision-fenced mutation, which is what makes what is on
 * screen exactly what a save would store.
 */

import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  Switch,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFormActions,
  type SettingsFormLabels,
  type SettingsFormScope,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { loadState, saveState } from './api.ts'
import { DEFAULT_BALL_SIZE, MAX_BALL_SIZE, MIN_BALL_SIZE } from './ball.tsx'

/** Every field this page edits, with the copy each one shows. */
const FIELDS = [
  {
    field: 'defaultRoom',
    label: '默认直播间',
    hint: '浮层默认打开的直播间号，留空则每次手动输入。',
    kind: 'text',
  },
  {
    field: 'autoConnect',
    label: '自动连接',
    hint: '页面加载后自动连接默认直播间。',
    kind: 'switch',
  },
  {
    field: 'historyLimit',
    label: '保留条数',
    hint: '浮层最多保留的弹幕条数。',
    kind: 'number',
  },
  {
    field: 'historyFetch',
    label: '单次拉取条数',
    hint: '连接和刷新时从历史接口拉取的条数。',
    kind: 'number',
  },
  {
    field: 'pollMinMs',
    label: '轮询最快间隔',
    hint: '历史轮询的最快间隔（毫秒）。出错时会自动退避到更慢，下限 100。',
    kind: 'number',
  },
  {
    field: 'statsIntervalMs',
    label: '在线人数刷新间隔',
    hint: '在线人数刷新间隔（毫秒）。',
    kind: 'number',
  },
  {
    field: 'heartbeatMs',
    label: '弹幕服务器心跳',
    hint: '弹幕服务器心跳间隔（毫秒）。',
    kind: 'number',
  },
  {
    field: 'requestTimeoutMs',
    label: '请求超时',
    hint: '请求 Bilibili 接口的超时时间（毫秒）。',
    kind: 'number',
  },
  {
    field: 'showEnterMessages',
    label: '显示进场消息',
    hint: '有人进入直播间时在浮层里显示一条提示。',
    kind: 'switch',
  },
  {
    field: 'showSuperChat',
    label: '显示醒目留言',
    hint: '醒目留言（Super Chat）在浮层里显示。',
    kind: 'switch',
  },
] as const

/** The settings scope this plugin injects for its own namespace. */
export type ConfigScope = SettingsFormScope<Record<string, unknown>>

/** Props this page receives from its own registration. */
export interface ConfigPageProps {
  readonly view: 'summary' | 'page'
  readonly form?: ConfigScope | undefined
  readonly t?: (key: string) => string
}

/** Copy the form frame renders. */
const LABELS: SettingsFormLabels = {
  unavailable: '当前页面不提供配置。',
  readOnly: '配置文件为只读，无法保存。',
  saveFailed: '保存失败，已保留你的修改。',
  save: '保存',
  saving: '保存中…',
}

/**
 * Render one boolean field as a labelled switch.
 *
 * The shared value field edits text, so a boolean gets its own row. The frame
 * copies the official field exactly — same padding, same label and hint
 * typography, same bottom border — so it reads as part of the form.
 *
 * @param props - the field's copy, its value, and the staging action.
 * @returns the labelled switch.
 */
function SwitchField(props: {
  readonly field: string
  readonly label: string
  readonly hint: string
  readonly model: SettingsFormModel<Record<string, unknown>>
  readonly disabled: boolean
  readonly onEdit: (next: boolean) => void
}) {
  const state = useFieldState(props.model, props.field)
  return (
    <div style={SWITCH_ROW}>
      <div style={SWITCH_HEAD}>
        <span style={SWITCH_LABEL}>{props.label}</span>
        <Switch
          checked={state.text === 'on'}
          label={props.label}
          disabled={props.disabled}
          onChange={props.onEdit}
        />
      </div>
      <p style={SWITCH_HINT}>{props.hint}</p>
    </div>
  )
}

/**
 * Render the settings form.
 *
 * @param props - slot props carrying the injected settings scope.
 * @returns the form, or the summary one-liner.
 */
export function ConfigPage(props: ConfigPageProps) {
  const { view, form } = props

  const specs = useMemo<SettingsFieldSpec[]>(
    () =>
      FIELDS.map((field) => {
        if (field.kind === 'number') return settingsNumberField(field.field)
        if (field.kind === 'switch') return settingsBooleanField(field.field)
        return settingsTextField(field.field)
      }),
    [],
  )

  // One model per scope: it owns the staged drafts and the accepted-value
  // subscription, so rebuilding it on every render would drop both.
  const model = useMemo(() => (form ? new SettingsFormModel(form, specs) : undefined), [form, specs])

  useEffect(() => () => model?.dispose(), [model])

  // The shell and every field state come from the model's own store, so the page
  // re-renders on a Host write or a staged edit without copying either into state.
  const shellStore = useMemo(() => model?.bind(() => model.shell()), [model])
  const shell = useSyncExternalStore(
    shellStore?.subscribe ?? NO_SUBSCRIBE,
    shellStore?.getSnapshot ?? readEmptyShell,
    shellStore?.getSnapshot ?? readEmptyShell,
  )

  const actions = useMemo<SettingsFormActions | undefined>(() => model?.actions(), [model])

  if (view === 'summary') return <span>弹幕浮层的房间、条数与刷新频率。</span>
  if (!model || !actions) return <span style={NOTE}>正在读取配置…</span>
  if (!shell.available) return <span style={NOTE}>{LABELS.unavailable}</span>

  const disabled = !shell.writable || shell.saving

  return (
    <SettingsForm labels={LABELS} state={shell} onSave={actions.save} onDiscard={actions.discard}>
      {FIELDS.map((field) => {
        if (field.kind === 'switch') {
          return (
            <SwitchField
              key={field.field}
              field={field.field}
              label={field.label}
              hint={field.hint}
              model={model}
              disabled={disabled}
              onEdit={(next) => actions.edit(field.field, next ? 'on' : 'off')}
            />
          )
        }

        return (
          <ValueRow
            key={field.field}
            field={field.field}
            label={field.label}
            hint={field.hint}
            numeric={field.kind === 'number'}
            model={model}
            disabled={disabled}
            onEdit={(text) => actions.edit(field.field, text)}
            onReset={() => actions.resetField(field.field)}
          />
        )
      })}
      <BallSizeRow />
    </SettingsForm>
  )
}

/**
 * The floating ball's diameter.
 *
 * Kept in the browser rather than the Host schema: it is a taste setting that
 * belongs to the screen the overlay sits on, it needs no server round trip, and
 * a per-browser value is the honest model — the same account on a small laptop
 * and a large monitor wants different sizes.
 *
 * @returns the labelled slider and its live preview.
 */
function BallSizeRow() {
  const [size, setSize] = useState(() => readBallSize())
  const commit = (next: number): void => {
    setSize(next)
    const saved = loadState()
    saveState({ ...saved, ballSize: next })
  }

  return (
    <div style={BALL_ROW}>
      <div style={BALL_HEAD}>
        <span style={BALL_LABEL}>悬浮球大小</span>
        <span style={BALL_VALUE}>{size}px</span>
      </div>
      <input
        type="range"
        min={MIN_BALL_SIZE}
        max={MAX_BALL_SIZE}
        step={4}
        value={size}
        onChange={(event) => commit(Number(event.target.value))}
        style={{ width: '100%', accentColor: 'var(--dsw-alias-brand-primary)' }}
      />
      <p style={BALL_HINT}>
        右下角悬浮球的直径。点击悬浮球管理各个直播间，刷新页面后生效。
      </p>
    </div>
  )
}

/**
 * @returns the stored ball size, clamped into the allowed range.
 */
function readBallSize(): number {
  const stored = loadState().ballSize
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_BALL_SIZE
  return Math.min(MAX_BALL_SIZE, Math.max(MIN_BALL_SIZE, Math.round(stored)))
}

const BALL_ROW = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
} as const

const BALL_HEAD = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
} as const

const BALL_LABEL = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
} as const

const BALL_VALUE = {
  flex: '0 0 auto',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  fontVariantNumeric: 'tabular-nums',
} as const

const BALL_HINT = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

/**
 * Stage a boolean field as its two-way switch.
 *
 * The shared text field would store the string `on` where the Host schema
 * accepts only a boolean, so this spec reads and writes the real type and keeps
 * a draft the schema would reject. An absent value clears the field back to its
 * default rather than forcing it off.
 *
 * @param field - the field name.
 * @returns the boolean field spec.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'on' : value === false ? 'off' : ''),
    parse: (text) => {
      if (text === 'on') return { kind: 'set', value: true }
      if (text === 'off') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/** No-op subscription for the pre-model render. */
const NO_SUBSCRIBE = () => () => {}

/**
 * Placeholder shell used before the model exists.
 *
 * A single frozen value: `useSyncExternalStore` compares snapshots by identity
 * and warns, and can loop, when `getSnapshot` builds a new object each call.
 */
const EMPTY_SHELL = Object.freeze({
  available: false,
  writable: false,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}) as unknown as SettingsFormShell

/** Read the placeholder shell. */
const readEmptyShell = () => EMPTY_SHELL

/**
 * Subscribe one field's staged state.
 *
 * @param model - the form model.
 * @param field - the field name.
 * @returns the field state, read through the model's store.
 */
function useFieldState(model: SettingsFormModel<Record<string, unknown>>, field: string) {
  const store = useMemo(() => model.bind(() => model.field(field)), [model, field])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/**
 * Render one text or number row through the shared value field.
 *
 * @param props - the field's identity, copy, model and staging actions.
 * @returns the labelled control.
 */
function ValueRow(props: {
  readonly field: string
  readonly label: string
  readonly hint: string
  readonly numeric: boolean
  readonly model: SettingsFormModel<Record<string, unknown>>
  readonly disabled: boolean
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}) {
  const state = useFieldState(props.model, props.field)
  return (
    <SettingsValueField
      id={`bili-danmaku-${props.field}`}
      label={props.label}
      hint={props.hint}
      text={state.text}
      overridden={state.overridden}
      invalid={state.invalid}
      overriddenLabel="已修改"
      resetLabel="重置"
      invalidLabel="值无效"
      disabled={props.disabled}
      numeric={props.numeric}
      onEdit={props.onEdit}
      onReset={props.onReset}
    />
  )
}

/** Frame copy for a boolean row, matching the official field. */
const SWITCH_ROW = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '12px 0',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
} as const

const SWITCH_HEAD = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
} as const

const SWITCH_LABEL = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
} as const

const SWITCH_HINT = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

const NOTE = {
  fontSize: 13,
  color: 'var(--dsw-alias-label-tertiary)',
} as const
