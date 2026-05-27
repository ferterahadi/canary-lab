import { useEffect, useMemo, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { DraftRecord, PlanStep } from '../../api/types'
import { AgentSessionView } from '../AgentSessionView'
import { ExternalDraftAgentPanel } from '../ExternalDraftAgentPanel'
import {
  removeStep,
  parsePlanStepMarkdown,
  renderPlanStepMarkdown,
  reorderStep,
  validatePlan,
} from '../../lib/plan-edit-state'

interface Props {
  draft: DraftRecord
  onAccept: (editedPlan?: PlanStep[], editedIntent?: string) => void
  onReject: () => void
  onRetry: () => void
  onCancelGeneration: () => void
  acting: boolean
}

// Step 2 of the wizard. While `planning` we stream the agent log; once
// `plan-ready` the user can inline-edit each step (label, actions, expected
// outcome), reorder via drag (@dnd-kit/core + @dnd-kit/sortable, chosen over
// react-dnd for smaller bundle footprint), delete, or append a new step.
// Accept passes the edited plan back; the original prop receives the full
// updated array.
export function PlanReviewStep({ draft, onAccept, onReject, onRetry, onCancelGeneration, acting }: Props) {
  const { status } = draft
  const seedPlan = useMemo(
    () => ((draft.plan as PlanStep[] | undefined) ?? []),
    [draft.plan],
  )
  const [plan, setPlan] = useState<PlanStep[]>(seedPlan)
  const [planMarkdown, setPlanMarkdown] = useState<string[]>(() => seedPlan.map(renderPlanStepMarkdown))
  const seedIntent = draft.intentSummary ?? ''
  const [intentDraft, setIntentDraft] = useState<string>(seedIntent)

  useEffect(() => {
    setPlan(seedPlan)
    setPlanMarkdown(seedPlan.map(renderPlanStepMarkdown))
  }, [seedPlan])

  useEffect(() => {
    setIntentDraft(seedIntent)
  }, [seedIntent])

  const editable = status === 'plan-ready'
  const generationActive = status === 'planning' || status === 'generating'
  const editedPlan = editable ? planMarkdown.map(parsePlanStepMarkdown) : plan
  const errors = validatePlan(editedPlan)
  const hasErrors = errors.length > 0
  const bodyClassName = status === 'planning'
    ? 'flex-1 min-h-0 overflow-hidden p-6'
    : 'flex-1 min-h-0 overflow-y-auto p-6'

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = Number(active.id)
    const to = Number(over.id)
    setPlan((current) => reorderStep(current, from, to))
    setPlanMarkdown((current) => reorderString(current, from, to))
  }

  const handleRemove = (index: number): void => {
    if (typeof window !== 'undefined' && !window.confirm('Remove this step?')) return
    setPlan((current) => removeStep(current, index))
    setPlanMarkdown((current) => current.filter((_, i) => i !== index))
  }

  const handleAppend = (): void => {
    const newStep = { step: 'New step', actions: [], expectedOutcome: '' }
    setPlan((current) => [newStep, ...current])
    setPlanMarkdown((current) => [renderPlanStepMarkdown(newStep), ...current])
  }

  const handleMarkdownChange = (index: number, value: string): void => {
    setPlanMarkdown((current) => current.map((markdown, i) => (i === index ? value : markdown)))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={bodyClassName}>
        <div className={`mx-auto max-w-3xl ${status === 'planning' ? 'flex h-full min-h-0 flex-col gap-4' : 'space-y-5'}`}>
          {status === 'planning' && (
            draft.source === 'external' ? (
              <div className="cl-frame flex min-h-0 flex-1 flex-col overflow-hidden">
                <ExternalDraftAgentPanel draft={draft} stageView="planning" />
              </div>
            ) : (
              <>
                <div
                  className="flex items-center justify-between gap-3 p-3"
                  style={{
                    border: '1px solid var(--border-default)',
                    background: 'var(--bg-overlay)',
                    color: 'var(--text-secondary)',
                    borderRadius: 6,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11.5,
                  }}
                >
                  <span>Agent is drafting the test plan…</span>
                  <button
                    type="button"
                    onClick={onCancelGeneration}
                    disabled={acting}
                    className="cl-button px-2 py-1 disabled:opacity-50"
                    style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                  >
                    {acting ? 'Stopping…' : 'Stop generation'}
                  </button>
                </div>
                <div className="cl-frame flex min-h-0 flex-1 flex-col overflow-hidden">
                  <AgentSessionView source={{ kind: 'draft', draftId: draft.draftId, stage: 'planning', live: true }} />
                </div>
              </>
            )
          )}

          {status === 'error' && (
            <div
              className="p-3 text-xs"
              style={{
                border: '1px solid var(--danger)',
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                color: 'var(--danger)',
                borderRadius: 6,
                fontFamily: 'var(--font-mono)',
              }}
            >
              <div className="mb-2 font-semibold">Plan generation failed.</div>
              <div className="text-[11px] opacity-90">{draft.errorMessage ?? 'Unknown error'}</div>
            </div>
          )}

          {status === 'cancelled' && (
            <>
              <div
                className="p-3 text-xs"
                style={{
                  border: '1px solid var(--warning)',
                  background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
                  color: 'var(--warning)',
                  borderRadius: 6,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                <div className="mb-2 font-semibold">Generation stopped.</div>
                <div className="text-[11px] opacity-90">{draft.errorMessage ?? 'Generation cancelled by user'}</div>
              </div>
              {draft.source === 'external' ? (
                <div className="cl-frame flex min-h-[24rem] max-h-[min(70vh,44rem)] flex-col overflow-hidden">
                  <ExternalDraftAgentPanel draft={draft} stageView="planning" />
                </div>
              ) : (
                <div className="cl-frame flex min-h-[24rem] max-h-[min(70vh,44rem)] flex-col overflow-hidden">
                  <AgentSessionView source={{ kind: 'draft', draftId: draft.draftId, stage: 'planning' }} />
                </div>
              )}
            </>
          )}

          {(status === 'plan-ready' || status === 'generating' || status === 'spec-ready' || status === 'accepted') && (
            <div className="space-y-5">
              <div>
                <div className="mb-2 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Intent summary
                </div>
                <textarea
                  value={intentDraft}
                  onChange={(e) => setIntentDraft(e.target.value)}
                  readOnly={!editable}
                  rows={6}
                  placeholder={editable ? 'No intent summary produced — describe what this test is for.' : ''}
                  className="cl-input min-h-32 w-full resize-y px-3 py-2 text-[11px] leading-5"
                  style={{
                    background: editable ? 'var(--bg-surface)' : 'var(--bg-overlay)',
                  }}
                  spellCheck={false}
                />
                <div
                  className="mt-1 text-[10.5px]"
                  style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                >
                  Saved to <code>docs/intent.md</code> when you accept the plan.
                </div>
              </div>
              <div>
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Generated plan
                  </div>
                  {editable && (
                    <button
                      type="button"
                      onClick={handleAppend}
                      className="cl-button px-2 py-1"
                    >
                      + Add step
                    </button>
                  )}
                </div>
                {editable ? (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={plan.map((_, i) => String(i))} strategy={verticalListSortingStrategy}>
                      <ol className="space-y-3">
                        {plan.map((item, i) => (
                          <SortablePlanItem
                            key={i}
                            id={String(i)}
                            index={i}
                            markdown={planMarkdown[i] ?? renderPlanStepMarkdown(item)}
                            onChange={handleMarkdownChange}
                            onRemove={handleRemove}
                          />
                        ))}
                      </ol>
                    </SortableContext>
                  </DndContext>
                ) : (
                  <PlanList plan={plan} />
                )}
                {editable && hasErrors && (
                  <div
                    className="mt-2 text-[11px]"
                    style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}
                  >
                    {errors.map((e, i) => (
                      <div key={i}>· Card #{e.index + 1}: {e.message}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="cl-panel-footer flex items-center justify-end gap-2 px-6 py-3">
        {status === 'error' || status === 'cancelled' ? (
          <>
            {status === 'cancelled' && (
              <button
                type="button"
                onClick={onReject}
                disabled={acting}
                className="cl-button px-3 py-1.5 disabled:opacity-50"
              >
                Close
              </button>
            )}
            <button
              type="button"
              onClick={onRetry}
              disabled={acting}
              className="cl-button-primary px-3 py-1.5 disabled:opacity-50"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={acting || generationActive}
              className="cl-button px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => onAccept(editedPlan, intentDraft.trim() ? intentDraft : undefined)}
              disabled={acting || status !== 'plan-ready' || hasErrors}
              className="cl-button-primary px-4 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {acting ? 'Working…' : 'Accept plan'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function SortablePlanItem({
  id,
  index,
  markdown,
  onChange,
  onRemove,
}: {
  id: string
  index: number
  markdown: string
  onChange: (i: number, value: string) => void
  onRemove: (i: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    border: '1px solid var(--border-default)',
    background: 'var(--bg-surface)',
    borderRadius: 6,
  }

  return (
    <li ref={setNodeRef} style={style} className="flex gap-3 p-3 text-xs">
      <button
        type="button"
        aria-label="Drag to reorder"
        className="cursor-grab self-start"
        style={{ color: 'var(--text-muted)' }}
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <textarea
        value={markdown}
        onChange={(e) => onChange(index, e.target.value)}
        rows={12}
        className="cl-input max-h-[28rem] min-h-56 flex-1 resize-y overflow-y-auto px-3 py-2 text-[11px] leading-5"
        spellCheck={false}
      />
      <button
        type="button"
        aria-label="Delete step"
        onClick={() => onRemove(index)}
        className="self-start"
        style={{ color: 'var(--text-muted)' }}
      >
        ✕
      </button>
    </li>
  )
}

function PlanList({ plan }: { plan: PlanStep[] }) {
  if (plan.length === 0) {
    return (
      <div
        className="text-xs"
        style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-display)', fontStyle: 'italic' }}
      >
        Plan is empty.
      </div>
    )
  }
  return (
    <ol className="space-y-3">
      {plan.map((item, i) => (
        <li
          key={i}
          className="p-3 text-xs"
          style={{
            border: '1px solid var(--border-default)',
            background: 'var(--bg-surface)',
            borderRadius: 6,
          }}
        >
          <textarea
            value={renderPlanStepMarkdown(item)}
            readOnly
            rows={12}
            className="cl-input max-h-[28rem] min-h-56 w-full resize-y overflow-y-auto px-3 py-2 text-[11px] leading-5"
            spellCheck={false}
          />
        </li>
      ))}
    </ol>
  )
}

function reorderString(items: string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex === toIndex) return items
  if (fromIndex < 0 || fromIndex >= items.length) return items
  if (toIndex < 0 || toIndex >= items.length) return items
  const next = items.slice()
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}
