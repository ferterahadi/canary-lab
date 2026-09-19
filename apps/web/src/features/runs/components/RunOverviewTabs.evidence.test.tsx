// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BootFailureEvidence, DependencyEvidence } from './RunOverviewTabs'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('run overview evidence', () => {
  it('shows structured boot evidence and names an unpreserved wrapper cause', () => {
    act(() => root.render(<BootFailureEvidence failure={{
      service: 'api',
      safeName: 'api',
      reason: 'process-exited',
      classification: 'underlying-cause-not-preserved',
      detail: 'Service exited before readiness.',
      logPath: '/runs/1/svc-api.log',
      command: 'npm run dev',
      cwd: '/worktrees/api',
      exitCode: 1,
      excerpt: 'wrapper exited',
      nextAction: 'Update the outer wrapper to log and rethrow the original failure.',
    }} />))

    expect(container.textContent).toContain('underlying-cause-not-preserved')
    // phase is derived from reason, not stored — it must still render.
    expect(container.textContent).toContain('process-exit')
    expect(container.textContent).toContain('Underlying cause not preserved')
    expect(container.textContent).toContain('npm run dev')
    expect(container.textContent).toContain('/runs/1/svc-api.log')
  })

  it('does not present unknown dependency provenance as compatible', () => {
    act(() => root.render(<DependencyEvidence provenance={[{
      repoName: 'api',
      sourceRevision: 'abc123',
      sourcePath: '/source',
      worktreePath: '/worktree',
      dependencyPath: '/worktree/node_modules',
      dependencyRealPath: '/source/node_modules',
      lockfile: null,
      dependencyLockfile: null,
      generatorInputs: [],
      dependencyGeneratorInputs: [],
      runtime: { node: process.version, packageManager: 'npm' },
      mode: 'shared',
      verdict: 'unknown',
      warning: 'Legacy shared dependency state could not be proven.',
    }]} />))

    expect(container.textContent).toContain('unknown')
    expect(container.textContent).not.toContain('compatible')
    expect(container.textContent).toContain('Legacy shared dependency state could not be proven.')
  })
})
