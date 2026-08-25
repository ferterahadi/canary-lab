import { useState } from 'react'
import * as api from '@/shared/api/client'
import { PlusIcon, Section, TrashIcon } from '@/shared/ui/atoms'
import { TemplatedInput } from './TemplatedInput'
import { SaveBar } from './SaveBar'
import { useEditableSlice } from './useEditableSlice'
import { CopyFromModal } from './CopyFromModal'
import type { KvEntry } from './envset-diff'

export function SlotEditor({
  feature,
  env,
  slot,
  siblingEnvs,
}: {
  feature: string
  env: string
  slot: string
  siblingEnvs: string[]
}) {
  const [copyOpen, setCopyOpen] = useState(false)
  const ed = useEditableSlice<api.EnvsetSlotDoc, KvEntry[]>({
    cacheKey: `envset-slot:${feature}:${env}:${slot}`,
    load: () => api.getEnvsetSlot(feature, env, slot),
    extract: (doc) => doc.entries,
    merge: (_doc, slice) => slice,
    save: (payload) => api.putEnvsetSlot(feature, env, slot, payload as KvEntry[]),
  })

  if (ed.error && !ed.doc) return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>{ed.error}</div>
  if (ed.loading || !ed.doc || !ed.draft) return <div className="p-4 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>

  const draft = ed.draft
  const doc = ed.doc

  return (
    <div className="flex h-full flex-1 min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="p-3">
        <Section title={slot} bodyClassName="px-3.5 py-3 flex flex-col gap-1.5">
          {draft.map((entry, i) => (
            <div key={i} className="group flex items-center gap-1.5">
              <input
                type="text"
                value={entry.key}
                onChange={(e) => ed.setDraft(draft.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                placeholder="KEY"
                className="w-[40%] rounded-md px-2.5 py-1.5 text-xs outline-none"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <span style={{ color: 'var(--text-muted)' }}>=</span>
              <div className="relative flex-1">
                {/* Values support the per-run `${port.<slot>}` token (the only
                    namespace that resolves inside applied envset files) —
                    typing `${` offers the feature's declared port slots. */}
                <TemplatedInput
                  value={entry.value}
                  onChange={(v) => ed.setDraft(draft.map((x, j) => j === i ? { ...x, value: v } : x))}
                  feature={feature}
                  namespaces={['port']}
                  style={{ paddingRight: '2rem' }}
                />
                <button
                  type="button"
                  aria-label="Remove key"
                  title="Remove key"
                  onClick={() => ed.setDraft(draft.filter((_, j) => j !== i))}
                  className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100"
                  style={{ color: 'var(--danger)' }}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => ed.setDraft([...draft, { key: '', value: '' }])}
              className="cl-button inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{ borderStyle: 'dashed' }}
            >
              <PlusIcon />
              Add entry
            </button>
            <button
              type="button"
              onClick={() => setCopyOpen(true)}
              title="Seed values from another env or a file"
              className="cl-button inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
              style={{ borderStyle: 'dashed' }}
            >
              Copy from…
            </button>
          </div>
          {doc.unparsedLines.length > 0 && (
            <div className="mt-3 text-[10px]" style={{ color: 'var(--warning)' }}>
              {doc.unparsedLines.length} line(s) couldn't be parsed and will be preserved verbatim.
            </div>
          )}
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
      {copyOpen && (
        <CopyFromModal
          feature={feature}
          targetEnv={env}
          slot={slot}
          siblingEnvs={siblingEnvs}
          current={draft}
          onClose={() => setCopyOpen(false)}
          onApply={(merged) => { ed.setDraft(merged); setCopyOpen(false) }}
        />
      )}
    </div>
  )
}
