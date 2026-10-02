import { agentModelArgs } from './agent-models'

/** Spell out the former full-auto policy: recent Codex releases removed the
 * shorthand. Keep workspace writes sandboxed and approvals on request. */
export function buildCodexAgenticArgs(prompt: string, opts: {
  model?: string | null
  effort?: string | null
  skipGitRepoCheck?: boolean
} = {}): string[] {
  return [
    'exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"',
    ...(opts.skipGitRepoCheck ? ['--skip-git-repo-check'] : []),
    ...agentModelArgs('codex', { model: opts.model ?? null, effort: opts.effort ?? null }),
    prompt,
  ]
}
