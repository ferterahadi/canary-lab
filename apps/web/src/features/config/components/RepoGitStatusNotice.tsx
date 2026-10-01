import type { GitRepoStatus } from '@/shared/api/workspace'

export function RepoGitStatusNotice({ status, confirmed, error }: {
  status: GitRepoStatus | null
  confirmed: boolean
  error: string | null
}) {
  if (confirmed) return null
  return <div role="status" className="text-[10px]" style={{ color: 'var(--warning)' }}>
    {status ? 'Git status is stale. Retrying…' : 'Checking Git status…'}
    {error && <> {error}</>}
  </div>
}
