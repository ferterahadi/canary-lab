import { useWizardDrafts } from '@/features/wizard/state/WizardDraftContext'
import { useEvaluationExports } from '@/features/evaluation/state/EvaluationExportContext'
import { Chip } from '@/shared/ui/StatusChip'

/** The Flight activity list includes both collections, so freshness belongs
 * beside the global connection indicators and remains visible in drilldowns. */
export function WorkspaceRecordSyncStatus() {
  const { sync: drafts } = useWizardDrafts()
  const { sync: exports } = useEvaluationExports()
  const pending = [['Drafts', drafts], ['Exports', exports]] as const
  const affected = pending.filter(([, sync]) => sync.stale)
  if (affected.length === 0) return null
  const loading = affected.every(([, sync]) => sync.loading && !sync.error)
  return (
    <span role="status" data-testid="workspace-record-sync">
      <Chip
        label={loading ? 'Syncing activity' : 'Activity may be stale'}
        tone={loading ? 'var(--text-muted)' : 'var(--warning)'}
        title={affected.map(([name, sync]) => `${name}: ${sync.error ?? (sync.loading ? 'loading' : 'reconciling newer changes')}`).join('; ')}
      />
    </span>
  )
}
