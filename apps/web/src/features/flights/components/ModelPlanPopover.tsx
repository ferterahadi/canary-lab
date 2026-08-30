import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useEscapeToClose } from '@/shared/ui/atoms'

/** One row of a model plan: which spawn, and the knobs it was pinned to. */
export interface ModelPlanRow {
  key: string
  label: string
  value: string
}

/** The launch model plan behind a click — the `Locked at launch` row list and
 *  the dismiss behaviour, shared by its two triggers: the header strip's
 *  `Models N tuned` fact (the whole flight's plan) and a stage header's
 *  `models N` chip (just the spawns that step runs). Both spell the same
 *  spawn → knobs pairing, so they live in one place rather than drifting into
 *  two popovers that answer the same question differently.
 *
 *  Same dropdown mechanics as the flight's Continue menu — outside-mousedown
 *  closes it, and the Escape layer closes the popover before the flight page's
 *  own Escape-to-exit. */
export function ModelPlanPopover({
  rows,
  footer,
  align = 'left',
  panelTestId,
  children,
}: {
  rows: ModelPlanRow[]
  /** Trailing note under the rows — the strip's "every other step runs on the
   *  agent default". A stage plan has no remainder to name, so it passes none. */
  footer?: ReactNode
  /** `right` for a trigger in a right-aligned cluster (the stage header), where
   *  a left-anchored panel would hang off the pane. */
  align?: 'left' | 'right'
  panelTestId?: string
  /** The trigger, rendered with the open state so it can mark itself pressed. */
  children: (state: { open: boolean; toggle: () => void }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEscapeToClose(() => setOpen(false), open)

  return (
    <div ref={ref} className="relative">
      {children({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          data-testid={panelTestId}
          className={`cl-popover absolute top-full z-20 mt-1 flex w-[280px] flex-col gap-1 p-2 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          <span className="cl-rubric">Locked at launch</span>
          {rows.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="min-w-0 truncate text-secondary">{row.label}</span>
              <span className="shrink-0 font-mono text-muted">{row.value}</span>
            </div>
          ))}
          {footer}
        </div>
      )}
    </div>
  )
}
