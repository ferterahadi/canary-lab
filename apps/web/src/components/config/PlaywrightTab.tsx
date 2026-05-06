import * as api from '../../api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../api/client'
import {
  ComplexValueBadge,
  FieldRow,
  NumberInput,
  SectionHeader,
  Select,
  Toggle,
} from './atoms'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'

interface Slice {
  fullyParallel?: boolean
  workers?: number | { $expr: string }
  retries?: number | { $expr: string }
  timeout?: number | { $expr: string }
  use: {
    headless?: boolean
    video?: string
    trace?: string
    screenshot?: string
  }
}

const VIDEO_OPTIONS = ['off', 'on', 'on-first-retry', 'retain-on-failure'] as const
const TRACE_OPTIONS = ['off', 'on', 'on-first-retry', 'retain-on-failure'] as const
const SCREENSHOT_OPTIONS = ['off', 'on', 'only-on-failure'] as const

function asMaybeNumberOrExpr(v: ConfigValue | undefined): number | { $expr: string } | undefined {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && !Array.isArray(v) && '$expr' in v) {
    return { $expr: (v as { $expr: string }).$expr }
  }
  return undefined
}

function asMaybeBool(v: ConfigValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function asMaybeString(v: ConfigValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function PlaywrightTab({ feature }: { feature: string }) {
  const ed = useEditableSlice<ParsedConfigDoc, Slice>({
    load: () => api.getPlaywrightConfig(feature),
    extract: (doc) => {
      const v = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const u = (v.use && typeof v.use === 'object' && !Array.isArray(v.use))
        ? (v.use as { [k: string]: ConfigValue })
        : {}
      return {
        fullyParallel: asMaybeBool(v.fullyParallel),
        workers: asMaybeNumberOrExpr(v.workers),
        retries: asMaybeNumberOrExpr(v.retries),
        timeout: asMaybeNumberOrExpr(v.timeout),
        use: {
          headless: asMaybeBool(u.headless),
          video: asMaybeString(u.video),
          trace: asMaybeString(u.trace),
          screenshot: asMaybeString(u.screenshot),
        },
      }
    },
    merge: (doc, slice) => {
      const current = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const next: { [k: string]: ConfigValue } = { ...current }
      const setOrDelete = (key: string, value: ConfigValue | undefined): void => {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      setOrDelete('fullyParallel', slice.fullyParallel)
      setOrDelete('workers', slice.workers as ConfigValue | undefined)
      setOrDelete('retries', slice.retries as ConfigValue | undefined)
      setOrDelete('timeout', slice.timeout as ConfigValue | undefined)

      const currentUse = (current.use && typeof current.use === 'object' && !Array.isArray(current.use))
        ? (current.use as { [k: string]: ConfigValue })
        : {}
      const nextUse: { [k: string]: ConfigValue } = { ...currentUse }
      if (slice.use.headless === undefined) delete nextUse.headless; else nextUse.headless = slice.use.headless
      if (!slice.use.video) delete nextUse.video; else nextUse.video = slice.use.video
      if (!slice.use.trace) delete nextUse.trace; else nextUse.trace = slice.use.trace
      if (!slice.use.screenshot) delete nextUse.screenshot; else nextUse.screenshot = slice.use.screenshot
      next.use = nextUse
      return next
    },
    save: (payload) => api.putPlaywrightConfig(feature, payload as ConfigValue),
    deps: [feature],
  })

  if (ed.error) return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>{ed.error}</div>
  if (ed.loading || !ed.draft) return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const numberOrExprField = (
    label: string,
    hint: string | undefined,
    value: number | { $expr: string } | undefined,
    onChange: (next: number | { $expr: string } | undefined) => void,
    defaultIfUnset = 0,
    min?: number,
  ) => (
    <FieldRow label={label} hint={hint} layout="inline">
      {value && typeof value === 'object' ? (
        <div className="flex items-center gap-2">
          <ComplexValueBadge source={value.$expr} />
          <button
            type="button"
            onClick={() => onChange(defaultIfUnset)}
            className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
          >
            Override
          </button>
        </div>
      ) : (
        <NumberInput
          value={typeof value === 'number' ? value : defaultIfUnset}
          min={min}
          onChange={onChange}
        />
      )}
    </FieldRow>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <SectionHeader>Run behavior</SectionHeader>
        <div className="px-4 py-3">
          <FieldRow label="Fully parallel" hint="Run tests inside files in parallel" layout="inline">
            <Toggle
              value={ed.draft.fullyParallel ?? false}
              onChange={(v) => ed.setDraft((d) => ({ ...d, fullyParallel: v }))}
            />
          </FieldRow>
          {numberOrExprField(
            'Workers',
            'Concurrent worker processes',
            ed.draft.workers,
            (workers) => ed.setDraft((d) => ({ ...d, workers })),
            1,
            1,
          )}
          {numberOrExprField(
            'Retries',
            'Retries per failed test',
            ed.draft.retries,
            (retries) => ed.setDraft((d) => ({ ...d, retries })),
            0,
            0,
          )}
          {numberOrExprField(
            'Timeout (ms)',
            'Per-test timeout',
            ed.draft.timeout,
            (timeout) => ed.setDraft((d) => ({ ...d, timeout })),
            0,
            0,
          )}
        </div>

        <SectionHeader>Browser & artifacts</SectionHeader>
        <div className="px-4 py-3">
          <FieldRow label="Headless" hint="Hide browser windows during test runs" layout="inline">
            <Toggle
              value={ed.draft.use.headless ?? true}
              onChange={(v) => ed.setDraft((d) => ({ ...d, use: { ...d.use, headless: v } }))}
            />
          </FieldRow>
          <FieldRow label="Video" layout="inline">
            <Select<string>
              value={ed.draft.use.video ?? 'off'}
              onChange={(v) => ed.setDraft((d) => ({ ...d, use: { ...d.use, video: v } }))}
              options={VIDEO_OPTIONS.map((v) => ({ value: v, label: v }))}
            />
          </FieldRow>
          <FieldRow label="Trace" layout="inline">
            <Select<string>
              value={ed.draft.use.trace ?? 'retain-on-failure'}
              onChange={(v) => ed.setDraft((d) => ({ ...d, use: { ...d.use, trace: v } }))}
              options={TRACE_OPTIONS.map((v) => ({ value: v, label: v }))}
            />
          </FieldRow>
          <FieldRow label="Screenshot" layout="inline">
            <Select<string>
              value={ed.draft.use.screenshot ?? 'only-on-failure'}
              onChange={(v) => ed.setDraft((d) => ({ ...d, use: { ...d.use, screenshot: v } }))}
              options={SCREENSHOT_OPTIONS.map((v) => ({ value: v, label: v }))}
            />
          </FieldRow>
        </div>
      </div>

      <SaveBar
        dirty={ed.dirty}
        saving={ed.saving}
        error={ed.error}
        savedAt={ed.savedAt}
        onSave={ed.doSave}
        onDiscard={ed.discard}
      />
    </div>
  )
}
