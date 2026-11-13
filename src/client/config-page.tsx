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

import {
  clampLength,
  clampScale,
  COMFORTABLE_UI_SCALE_MAX,
  COMFORTABLE_UI_SCALE_MIN,
  DEFAULT_UI_SCALE,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  loadState,
  MAX_UI_SCALE,
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_WIDTH,
  MIN_UI_SCALE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  saveState,
} from './api.ts'
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
  {
    field: 'checkCredentialOnLoad',
    label: '加载时检查登录',
    hint: '页面加载时检查登录凭据，不可用时弹窗说明。仅在自动连接开启时生效，否则加载时插件不主动做任何事，弹窗无从解释。',
    kind: 'switch',
  },
  {
    field: 'preferCustomCredential',
    label: '优先使用自定义凭据',
    hint: '启用后优先使用 dsh refs 凭据中配置的 BILIBILI_SESSDATA 和 BILIBILI_JCT，这些凭据不可用时回退到扫码登录获得的登录态。',
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
      <FrontendSettings />
    </SettingsForm>
  )
}

/**
 * Per-browser presentation settings.
 *
 * Everything here lives in localStorage rather than in the Host schema: these
 * are taste settings that belong to the screen the overlay sits on, they need no
 * server round trip, and a per-browser value is the honest model, because the
 * same account on a small laptop and on a large monitor wants different values.
 *
 * The section sits inside the bundle's configuration area, which is what puts it
 * above the "包含的组件" list on the plugin page. Writes are immediate: the
 * overlay listens for the storage change, so a slider takes effect on the page
 * without a reload or a save button.
 *
 * @returns the section below the configuration form.
 */
function FrontendSettings() {
  const [size, setSize] = useState(() => readBallSize())
  // The window size has no control here, but the reset covers it: it is a
  // presentation setting in the same stored document, and a reset that left it
  // at a hand-dragged value would not restore the shipped layout.
  const [windowSize, setWindowSize] = useState(() => readWindowSize())
  const [scale, setScale] = useState(() => clampScale(loadState().uiScale))
  /** Whether any value in this section differs from its shipped default. */
  const changed =
    size !== DEFAULT_BALL_SIZE ||
    windowSize.width !== DEFAULT_WINDOW_WIDTH ||
    windowSize.height !== DEFAULT_WINDOW_HEIGHT ||
    scale !== DEFAULT_UI_SCALE

  const reset = (): void => {
    setSize(DEFAULT_BALL_SIZE)
    setWindowSize({ width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT })
    setScale(DEFAULT_UI_SCALE)
    saveState({
      ...loadState(),
      ballSize: DEFAULT_BALL_SIZE,
      windowWidth: DEFAULT_WINDOW_WIDTH,
      windowHeight: DEFAULT_WINDOW_HEIGHT,
      uiScale: DEFAULT_UI_SCALE,
    })
  }

  return (
    <div style={FRONT_CARD}>
      <div style={FRONT_HEADER}>
        <div style={FRONT_HEADING}>前端设置</div>
        <button
          type="button"
          // Disabled when there is nothing to undo, so the control also answers
          // whether this section has been touched at all.
          disabled={!changed}
          onClick={reset}
          style={{ ...FRONT_RESET, opacity: changed ? 1 : 0.45, cursor: changed ? 'pointer' : 'default' }}
        >
          重置
        </button>
      </div>
      <p style={FRONT_NOTE}>这些设置只保存在当前浏览器，不会写入 dsh 配置，修改即时生效。</p>

      <SliderRow
        label="悬浮球大小"
        hint={`右下角悬浮球的直径，默认 ${DEFAULT_BALL_SIZE}px。`}
        value={size}
        min={MIN_BALL_SIZE}
        max={MAX_BALL_SIZE}
        step={4}
        unit="px"
        onChange={(next) => {
          setSize(next)
          saveState({ ...loadState(), ballSize: next })
        }}
      />

      <SliderRow
        label="窗口内缩放（DPI）"
        hint={
          scale > COMFORTABLE_UI_SCALE_MAX
            ? `${scale}% 偏大，弹幕窗口里能看到的条数会明显变少。`
            : scale < COMFORTABLE_UI_SCALE_MIN
              ? `${scale}% 偏小，弹幕文字会比较难读。`
              : `弹幕窗口内文字、间距和按钮的大小，${DEFAULT_UI_SCALE}% 表示跟随页面缩放。`
        }
        value={scale}
        min={MIN_UI_SCALE}
        max={MAX_UI_SCALE}
        step={1}
        unit="%"
        onChange={(next) => {
          setScale(next)
          saveState({ ...loadState(), uiScale: next })
        }}
      />

      <div style={BALL_ROW}>
        <div style={BALL_HEAD}>
          <span style={BALL_LABEL}>弹幕窗口大小</span>
          <span style={BALL_VALUE}>
            {windowSize.width}×{windowSize.height}px
          </span>
        </div>
        <p style={BALL_HINT}>
          直接拖动窗口右下角调整。重置会把它恢复为默认的 {DEFAULT_WINDOW_WIDTH}×{DEFAULT_WINDOW_HEIGHT}px。
        </p>
      </div>
    </div>
  )
}

/** @returns the stored window size, clamped into the allowed range. */
function readWindowSize(): { width: number; height: number } {
  const saved = loadState()
  return {
    width: clampLength(saved.windowWidth, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
    height: clampLength(saved.windowHeight, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT),
  }
}

/**
 * One labelled slider inside the front-end settings section.
 *
 * @param props - the copy, the bounds and the commit callback.
 * @returns the row.
 */
function SliderRow(props: {
  readonly label: string
  readonly hint: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly unit: string
  readonly onChange: (next: number) => void
}) {
  return (
    <div style={BALL_ROW}>
      <div style={BALL_HEAD}>
        <span style={BALL_LABEL}>{props.label}</span>
        <span style={BALL_VALUE}>
          {props.value}
          {props.unit}
        </span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        style={{ width: '100%', accentColor: 'var(--dsw-alias-brand-primary)' }}
      />
      <p style={BALL_HINT}>{props.hint}</p>
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

const FRONT_CARD = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginTop: 24,
} as const

const FRONT_HEADER = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
} as const

const FRONT_RESET = {
  flex: '0 0 auto',
  marginLeft: 'auto',
  padding: '2px 8px',
  fontSize: 12,
  lineHeight: 1.5,
  fontFamily: 'inherit',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  whiteSpace: 'nowrap',
} as const

const FRONT_HEADING = {
  flex: 1,
  minWidth: 0,
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
} as const

const FRONT_NOTE = {
  margin: '2px 0 4px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

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
