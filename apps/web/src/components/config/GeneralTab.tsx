import * as api from '../../api/client'
import type { ConfigValue, ParsedConfigDoc } from '../../api/client'
import { FieldRow, NumberInput, SectionHeader, TextInput, Textarea } from './atoms'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'

interface Slice {
  name: string
  description: string
  healOnFailureThreshold?: number
}

function asString(v: ConfigValue | undefined, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function asOptionalNumber(v: ConfigValue | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}

export function GeneralTab({ feature }: { feature: string }) {
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
      if (slice.healOnFailureThreshold == null) {
        delete next.healOnFailureThreshold
      } else {
        next.healOnFailureThreshold = slice.healOnFailureThreshold
      }
      return next
    },
    save: (payload) => api.putFeatureConfigDoc(feature, payload as ConfigValue),
    deps: [feature],
  })

  if (ed.error && !ed.draft) {
    return <div className="p-4 text-xs" style={{ color: '#ef4444' }}>{ed.error}</div>
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
              rows={2}
              value={ed.draft.description}
              onChange={(description) => ed.setDraft((d) => ({ ...d, description }))}
            />
          </FieldRow>
        </div>

        <SectionHeader>Heal behavior</SectionHeader>
        <div className="px-4 py-3">
          <FieldRow
            label="Stop & heal after"
            hint="Stops the test run once N tests have failed, then triggers the auto-heal flow. Default 1 (stop on first failure)."
            layout="inline"
          >
            <div className="flex items-center gap-2">
              <NumberInput
                min={1}
                value={ed.draft.healOnFailureThreshold ?? 1}
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
