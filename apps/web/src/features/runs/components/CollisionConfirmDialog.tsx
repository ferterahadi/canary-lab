import type { RepoCollisionChoice } from '@/shared/api/client'
import { Modal } from '@/features/config/components/atoms'

interface Props {
  info: RepoCollisionChoice
  /** The feature the user tried to start (for the headline). */
  feature: string
  onChoose: (isolation: 'worktree' | 'queue') => void
  onCancel: () => void
  /** False when the feature's apps hardcode their ports — worktree isolation
   *  can't relocate ports, so the durable fix is to make them injectable. When
   *  false and `onPortify` is set, the dialog offers that path. */
  portsConfigured?: boolean
  onPortify?: () => void
}

// Shown when a start request hits a same-repo collision. The user picks how to
// resolve it: isolate the new run in a git worktree (runs now, in parallel) or
// queue it until the conflicting run finishes. Mirrors the RunsColumn confirm
// modal pattern.
export function CollisionConfirmDialog({ info, feature, onChoose, onCancel, portsConfigured, onPortify }: Props) {
  const offerPortify = portsConfigured === false && !!onPortify

  return (
    <Modal open onClose={onCancel} title={`${feature} uses the same app as a running run`} ariaLabel="Same-app collision" width={460}>
      <div className="p-5">
        <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {info.conflictingFeature} is currently using the same repo. Running both
          in place could let one run’s fixes corrupt the other. Isolate this run
          in its own git worktree to run now, or queue it until the other finishes.
        </p>
        {offerPortify && (
          <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            This app hardcodes its ports, so an isolated worktree still can’t boot a
            second copy without clashing. Make its ports injectable to run copies in
            parallel for good.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="cl-button px-3 py-1 text-xs">
            Cancel
          </button>
          {offerPortify && (
            <button
              type="button"
              onClick={onPortify}
              className="cl-button px-3 py-1 text-xs"
            >
              Portify
            </button>
          )}
          <button
            type="button"
            onClick={() => onChoose('queue')}
            className="cl-button px-3 py-1 text-xs"
          >
            Queue
          </button>
          <button
            type="button"
            onClick={() => onChoose('worktree')}
            className="cl-button cl-button-primary px-3 py-1 text-xs"
          >
            Run isolated (worktree)
          </button>
        </div>
      </div>
    </Modal>
  )
}
