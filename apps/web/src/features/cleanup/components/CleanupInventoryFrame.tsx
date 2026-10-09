import type { ReactNode } from 'react'
import { CleanupEmptyState, CleanupRefreshError, SpinnerGlyph, WarnGlyph } from './CleanupTableParts'

interface Props {
  initialLoading: boolean
  hasSnapshot: boolean
  error: string | null
  itemCount: number
  onRetry: () => void
  loadingTitle: string
  errorTitle: string
  emptyState: ReactNode
  toolbar: ReactNode
  actionError: ReactNode
  children: ReactNode
}

export function CleanupInventoryFrame({ initialLoading, hasSnapshot, error, itemCount, onRetry, loadingTitle, errorTitle, emptyState, toolbar, actionError, children }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      {hasSnapshot && error && <CleanupRefreshError error={error} />}
      {actionError}
      {/* Keep this node mounted across reads so refreshes retain scroll and rows. */}
      <div className="min-h-0 flex-1 overflow-auto px-5 py-2">
        {initialLoading && <CleanupEmptyState icon={<SpinnerGlyph />} title={loadingTitle} />}
        {!initialLoading && error && !hasSnapshot && (
          <CleanupEmptyState icon={<WarnGlyph />} title={errorTitle} hint={error} action={{ label: 'Retry', onClick: onRetry }} />
        )}
        {!initialLoading && !error && itemCount === 0 && emptyState}
        {itemCount > 0 && children}
      </div>
    </div>
  )
}
