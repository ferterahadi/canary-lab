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
import { AgentLogPanel } from './AgentLogPanel'
import {
  appendStep,
  parseActionsTextarea,
  removeStep,
  renderActionsTextarea,
  reorderStep,
  updateStep,
  validatePlan,
} from '../../lib/plan-edit-state'

interface Props {
  draft: DraftRecord
  onAccept: (editedPlan?: PlanStep[]) => void
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

  // Re-seed when the upstream plan reference changes (new fetch / poll).
  useEffect(() => {
    setPlan(seedPlan)
  }, [seedPlan])

  const editable = status === 'plan-ready'
  const errors = validatePlan(plan)
  const hasErrors = errors.length > 0

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
  }

  const handleRemove = (index: number): void => {
    if (typeof window !== 'undefined' && !window.confirm('Remove this step?')) return
    setPlan((current) => removeStep(current, index))
  }

  const handlePatch = (index: number, patch: Partial<PlanStep>): void => {
    setPlan((current) => updateStep(current, index, patch))
  }

  const handleAppend = (): void => {
    setPlan((current) => appendStep(current))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {status === 'planning' && (
            <>
              <div className="flex items-center justify-between gap-3 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/60 p-3 text-xs text-zinc-700 dark:text-zinc-300">
                <span>Agent is drafting the test plan…</span>
                <button
                  type="button"
                  onClick={onCancelGeneration}
                  disabled={acting}
                  className="rounded border border-rose-500/40 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-300"
                >
                  {acting ? 'Stopping…' : 'Stop generation'}
                </button>
              </div>
              <AgentLogPanel
                draftId={draft.draftId}
                initialBuffer={draft.planAgentLogTail}
                agent={draft.wizardAgent}
                phase="planning"
                status="running"
                compact
              />
            </>
          )}

          {status === 'error' && (
            <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
              <div className="mb-2 font-medium">Plan generation failed.</div>
              <div className="font-mono text-[11px]">{draft.errorMessage ?? 'Unknown error'}</div>
            </div>
          )}

          {status === 'cancelled' && (
            <>
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                <div className="mb-2 font-medium">Generation stopped.</div>
                <div>{draft.errorMessage ?? 'Generation cancelled by user'}</div>
              </div>
              <AgentLogPanel
                draftId={draft.draftId}
                initialBuffer={draft.planAgentLogTail}
                agent={draft.wizardAgent}
                phase="planning"
                status="idle"
                compact
              />
            </>
          )}

          {(status === 'plan-ready' || status === 'generating' || status === 'spec-ready' || status === 'accepted') && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                  Generated plan
                </span>
                {editable && (
                  <button
                    type="button"
                    onClick={handleAppend}
                    className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-[11px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800"
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
                          item={item}
                          onPatch={handlePatch}
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
                <div className="mt-2 text-[11px] text-rose-300">
                  {errors.map((e, i) => (
                    <div key={i}>Step #{e.index + 1}: {e.message}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 dark:border-zinc-800 px-6 py-3">
        {status === 'error' || status === 'cancelled' ? (
          <>
            {status === 'cancelled' && (
              <button
                type="button"
                onClick={onReject}
                disabled={acting}
                className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                Close
              </button>
            )}
            <button
              type="button"
              onClick={onRetry}
              disabled={acting}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:opacity-50"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onReject}
              disabled={acting}
              className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => onAccept(plan)}
              disabled={acting || status !== 'plan-ready' || hasErrors}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-zinc-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
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
  item,
  onPatch,
  onRemove,
}: {
  id: string
  index: number
  item: PlanStep
  onPatch: (i: number, patch: Partial<PlanStep>) => void
  onRemove: (i: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  const [editingStep, setEditingStep] = useState(false)
  const [editingOutcome, setEditingOutcome] = useState(false)

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex gap-2 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/60 p-3 text-xs"
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        className="cursor-grab self-start text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <div className="flex-1 space-y-2">
        {editingStep ? (
          <input
            autoFocus
            defaultValue={item.step}
            onBlur={(e) => { onPatch(index, { step: e.target.value.trim() }); setEditingStep(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onPatch(index, { step: (e.target as HTMLInputElement).value.trim() }); setEditingStep(false) }
              if (e.key === 'Escape') setEditingStep(false)
            }}
            className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 font-medium text-zinc-900 dark:text-zinc-100"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingStep(true)}
            className="block w-full text-left font-medium text-zinc-900 dark:text-zinc-100 hover:text-emerald-300"
          >
            {item.step || <span className="italic text-zinc-500">(empty)</span>}
          </button>
        )}

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Actions</div>
          <textarea
            value={renderActionsTextarea(item.actions)}
            onChange={(e) => onPatch(index, { actions: parseActionsTextarea(e.target.value) })}
            rows={Math.max(2, item.actions.length + 1)}
            className="w-full rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300"
            placeholder="One action per line"
          />
        </div>

        {editingOutcome ? (
          <input
            autoFocus
            defaultValue={item.expectedOutcome}
            onBlur={(e) => { onPatch(index, { expectedOutcome: e.target.value }); setEditingOutcome(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onPatch(index, { expectedOutcome: (e.target as HTMLInputElement).value }); setEditingOutcome(false) }
              if (e.key === 'Escape') setEditingOutcome(false)
            }}
            className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 italic text-zinc-700 dark:text-zinc-300"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingOutcome(true)}
            className="block w-full text-left italic text-zinc-600 dark:text-zinc-400 hover:text-emerald-300"
          >
            {item.expectedOutcome || <span className="text-zinc-400 dark:text-zinc-600">(no expected outcome)</span>}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Delete step"
        onClick={() => onRemove(index)}
        className="self-start text-zinc-500 hover:text-rose-400"
      >
        🗑
      </button>
    </li>
  )
}

function PlanList({ plan }: { plan: PlanStep[] }) {
  if (plan.length === 0) {
    return <div className="text-xs italic text-zinc-500">Plan is empty.</div>
  }
  return (
    <ol className="space-y-3">
      {plan.map((item, i) => (
        <li key={i} className="rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/60 p-3 text-xs">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">{item.step}</div>
          {item.actions.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-zinc-700 dark:text-zinc-300">
              {item.actions.map((a, j) => (
                <li key={j}>{a}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 italic text-zinc-600 dark:text-zinc-400">{item.expectedOutcome}</div>
        </li>
      ))}
    </ol>
  )
}
