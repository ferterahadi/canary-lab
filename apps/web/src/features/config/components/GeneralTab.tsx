import * as api from '../../../shared/api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../../shared/api/client'
import { FieldRow, NumberInput, SectionHeader, TextInput, Textarea, Toggle } from './atoms'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'

// Mirror of DEFAULT_HEAL_ON_FAILURE_THRESHOLD in shared/launcher/types.ts —
// the server applies the same default at load time. Absent ⇒ enabled at this
// value; `0` ⇒ disabled (full suite runs before healing).
const DEFAULT_HEAL_THRESHOLD = 2

interface Slice {
  name: string
  description: string
  healOnFailureThreshold?: number
}

// A feature stops & heals by default; only an explicit `0` opts out.
function healEnabled(v: number | undefined): boolean {
  return v == null ? true : v > 0
}
function healDisplayValue(v: number | undefined): number {
  return v != null && v > 0 ? v : DEFAULT_HEAL_THRESHOLD
}

function asString(v: ConfigValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function asOptionalNumber(v: ConfigValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}

export function GeneralTab({ feature, onFeatureRenamed }: { feature: string; onFeatureRenamed?: (nextFeature: string) => void }) {
  const ed = useEditableSlice<ParsedConfigDoc, Slice>({
    load: () => api.getFeatureConfigDoc(feature),
    extract: (doc) => {
      const v = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      return {
        name: asString(v.name),
        description: asString(v.description),
        healOnFailureThreshold: asOptionalNumber(v.healOnFailureThreshold),
      }
    },
    merge: (doc, slice) => {
      const current = (doc.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const next: { [k: string]: ConfigValue } = {
        ...current,
        name: slice.name,
        description: slice.description,
      }
      // Always persist a concrete number (including `0` = opt out). An absent
      // value materializes the default so the saved config is explicit and
      // matches the server-side default.
      next.healOnFailureThreshold = slice.healOnFailureThreshold ?? DEFAULT_HEAL_THRESHOLD
      return next
    },
    save: async (payload) => {
      const next = await api.putFeatureConfigDoc(feature, payload as ConfigValue)
      const nextValue = (next.parsed.value ?? {}) as { [k: string]: ConfigValue }
      const nextName = asString(nextValue.name)
      if (nextName && nextName !== feature) onFeatureRenamed?.(nextName)
      return next
    },
    deps: [feature],
  })

  if (ed.error && !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--danger)' }}>{ed.error}</div>
  }
  if (ed.loading || !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <SectionHeader>Identity</SectionHeader>
        <div className="px-4 py-3">
          <FieldRow label="Name">
            <TextInput value={ed.draft.name} onChange={(name) => ed.setDraft((d) => ({ ...d, name }))} />
          </FieldRow>
          <FieldRow label="Description">
            <Textarea
              minRows={2}
              maxRows={6}
              value={ed.draft.description}
              onChange={(description) => ed.setDraft((d) => ({ ...d, description }))}
            />
          </FieldRow>
        </div>

        <SectionHeader>Heal behavior</SectionHeader>
        <div className="px-4 py-3">
          <FieldRow
            label="Stop & heal after"
            hint={`On by default (${DEFAULT_HEAL_THRESHOLD} failures). Each new Playwright spawn starts with --max-failures=N; turn off to run the whole suite before healing. Changes made while tests are already running apply to the next rerun or restart, not the current process.`}
            layout="inline"
          >
            <div className="flex items-center gap-3">
              <Toggle
                value={healEnabled(ed.draft.healOnFailureThreshold)}
                onChange={(enabled) => ed.setDraft((d) => ({
                  ...d,
                  healOnFailureThreshold: enabled ? healDisplayValue(d.healOnFailureThreshold) : 0,
                }))}
              />
              <NumberInput
                min={1}
                value={healDisplayValue(ed.draft.healOnFailureThreshold)}
                disabled={!healEnabled(ed.draft.healOnFailureThreshold)}
                onChange={(n) => ed.setDraft((d) => ({ ...d, healOnFailureThreshold: n }))}
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>failure(s)</span>
            </div>
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
