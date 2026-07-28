import * as api from '@/shared/api/client'
import type { ConfigValue, ParsedConfigDoc } from '@/shared/api/client'
import { DEFAULT_HEAL_ON_FAILURE_THRESHOLD } from '@/shared/lib/heal-threshold'
import { FieldRow, HintIcon, Section, TextInput, Textarea } from '@/shared/ui/atoms'
import { HEAL_BEHAVIOR_INFO, HealBehaviorChoice } from '@/shared/ui/HealBehaviorChoice'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'

interface Slice {
  name: string
  description: string
  group: string
  healOnFailureThreshold?: number
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
        group: asString(v.group),
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
      // Group is optional: a non-empty value persists it; clearing the field
      // removes the key entirely rather than writing an empty string.
      const group = slice.group.trim()
      if (group) next.group = group
      else delete next.group
      // Always persist a concrete number (including `0` = opt out). An absent
      // value materializes the default so the saved config is explicit and
      // matches the server-side default.
      next.healOnFailureThreshold = slice.healOnFailureThreshold ?? DEFAULT_HEAL_ON_FAILURE_THRESHOLD
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
        <div className="flex flex-col gap-3 p-3">
          <Section title="Identity">
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
            <FieldRow label="Group">
              <TextInput
                value={ed.draft.group}
                placeholder="Features with the same group are shown together."
                onChange={(group) => ed.setDraft((d) => ({ ...d, group }))}
              />
            </FieldRow>
          </Section>

          {/* The same two-shape choice the flight Suite setup digest shows —
              one component, so the two lenses on `healOnFailureThreshold` can't
              drift into a switch here and a pick-a-run-shape there. The body
              padding drops to px-0.5 because the rows carry their own px-3:
              the selected band then spans the section edge-to-edge, with the
              labels still under the section title. */}
          <Section
            title={<span className="inline-flex items-center gap-1.5">Heal behavior<HintIcon hint={HEAL_BEHAVIOR_INFO} /></span>}
            bodyClassName="px-0.5 py-1.5"
          >
            <HealBehaviorChoice
              threshold={ed.draft.healOnFailureThreshold}
              editable
              testIdPrefix="general-heal"
              onChange={(healOnFailureThreshold) => ed.setDraft((d) => ({ ...d, healOnFailureThreshold }))}
            />
          </Section>
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
