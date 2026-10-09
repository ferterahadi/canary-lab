import type { ReactNode } from 'react'
import { WorkspaceActionsProvider, type WorkspaceActions } from '@/shared/state/workspace-actions'
import { WorkStateProvider, type WorkState } from '@/shared/state/work-state'

/** Test scaffolding: mounts a component under the two workspace contexts App
 *  provides, so a test that used to pass these as props supplies the same
 *  values here and keeps its assertions. Omitted values stay absent, exactly
 *  like an omitted prop. */
export function WorkspaceTestProviders({ actions = {}, workState = {}, children }: {
  actions?: WorkspaceActions
  workState?: WorkState
  children: ReactNode
}) {
  return (
    <WorkspaceActionsProvider {...actions}>
      <WorkStateProvider {...workState}>{children}</WorkStateProvider>
    </WorkspaceActionsProvider>
  )
}
