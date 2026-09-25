// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BootFailureEvidence, RunOverviewTab } from './RunOverviewTabs'
import type { RunManifest, ServiceManifestEntry } from '@/shared/api/types'
import type { RunBootFailure } from '@shared/run-state'
import type { RunDependencyProvenance } from '@shared/dependency-provenance'
import { deriveRunViewModel } from '../utils/run-view-model'
import { openRunLog } from '../utils/open-run-log'

vi.mock('../utils/open-run-log', () => ({ openRunLog: vi.fn(async () => {}) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.clearAllMocks()
})

function dependency(over: Partial<RunDependencyProvenance> = {}): RunDependencyProvenance {
  return {
    repoName: 'app', sourceRevision: 'abc123', sourcePath: '/source', worktreePath: '/worktree',
    dependencyPath: '/worktree/node_modules', dependencyRealPath: '/source/node_modules',
    lockfile: null, dependencyLockfile: null, generatorInputs: [], dependencyGeneratorInputs: [],
    runtime: { node: 'v22', packageManager: 'npm' }, mode: 'shared', verdict: 'incompatible',
    incompatibilityCause: 'generator-input-mismatch', remediation: 'Prepare worktree-local dependencies.',
    ...over,
  }
}

function renderOverview(provenance?: RunDependencyProvenance[]) {
  const services: ServiceManifestEntry[] = ['api', 'worker', 'other'].map((name) => ({
    repoName: name === 'other' ? 'other' : 'app', name, safeName: name, command: 'npm run start',
    cwd: `/worktree/${name}`, logPath: `/run/svc-${name}.log`, status: 'timeout',
  }))
  const manifest: RunManifest = {
    runId: 'run-1', feature: 'demo', status: 'healing', startedAt: '2026-09-22T00:00:00Z', healCycles: 1,
    services, dependencyProvenance: provenance,
    bootFailure: { service: 'api', safeName: 'api', reason: 'dependency-incompatible', detail: 'Old duplicate dependency message', logPath: '/run/runner.log' },
  }
  act(() => root.render(<RunOverviewTab manifest={manifest} services={services} repoBranches={[]} view={deriveRunViewModel(undefined)} />))
}

function renderBootOverview(bootFailure?: RunBootFailure, names = ['api']) {
  const services: ServiceManifestEntry[] = names.map((name) => ({
    repoName: name, name, safeName: name, command: `npm run ${name}`, cwd: `/worktree/${name}`,
    healthUrl: `http://localhost/${name}/health`, logPath: `/run/svc-${name}.log`, status: bootFailure?.safeName === name ? 'timeout' : 'ready',
  }))
  const manifest: RunManifest = {
    runId: 'run-boot', feature: 'demo', status: 'healing', startedAt: '2026-09-22T00:00:00Z', healCycles: 1,
    services, ...(bootFailure ? { bootFailure } : {}),
  }
  act(() => root.render(<RunOverviewTab manifest={manifest} services={services} repoBranches={[]} view={deriveRunViewModel(undefined)} />))
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('run overview evidence', () => {
  it('shows a service failure when the open run receives updated manifest state', () => {
    const services: ServiceManifestEntry[] = [{
      repoName: 'app', name: 'api', safeName: 'api', command: 'npm run dev',
      cwd: '/worktree/app', logPath: '/run/svc-api.log', status: 'ready',
    }]
    const manifest: RunManifest = {
      runId: 'run-live', feature: 'demo', status: 'running',
      startedAt: '2026-09-22T00:00:00Z', healCycles: 0, services,
    }
    act(() => root.render(<RunOverviewTab manifest={manifest} services={services} repoBranches={[]} view={deriveRunViewModel(undefined)} />))
    expect(container.querySelector('[data-testid="service-failure-evidence"]')).toBeNull()

    const failed = { ...manifest, status: 'healing' as const, serviceFailure: {
      service: 'api', safeName: 'api', kind: 'compiler' as const,
      detail: 'Watch compiler failed.', logPath: '/run/svc-api.log',
      command: 'npm run dev', cwd: '/worktree/app', at: '2026-09-22T00:01:00Z',
    } }
    act(() => root.render(<RunOverviewTab manifest={failed} services={services} repoBranches={[]} view={deriveRunViewModel(undefined)} />))
    expect(container.querySelector('[data-testid="service-failure-evidence"]')?.textContent).toContain('Watch compiler failed')
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('Open full service log'))
    act(() => button?.click())
    expect(openRunLog).toHaveBeenCalledWith('run-live', '/run/svc-api.log')
  })

  it('shows structured boot evidence and names an unpreserved wrapper cause', () => {
    act(() => root.render(<BootFailureEvidence runId="run-1" failure={{
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
    expect(container.textContent).not.toContain('/runs/1/svc-api.log')
    act(() => (container.querySelector('button') as HTMLButtonElement).click())
    expect(openRunLog).toHaveBeenCalledWith('run-1', '/runs/1/svc-api.log')
  })

  it('moves a matched boot failure into the affected service card and orders that service first', () => {
    renderBootOverview({
      service: 'api', safeName: 'api', reason: 'process-exited', detail: 'Exited.', logPath: '/run/svc-api.log',
      excerpt: 'Error: unavailable',
    }, ['healthy', 'api'])

    expect(container.querySelector('[data-testid="boot-failure-evidence"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="service-boot-failure"]')).toHaveLength(1)
    expect(container.querySelector('li')?.textContent).toContain('api')
  })

  it('keeps a run-level fallback when historical boot evidence matches no service', () => {
    renderBootOverview({
      service: 'removed-api', safeName: 'removed-api', reason: 'process-exited', detail: 'Exited.', logPath: '/run/removed.log',
      excerpt: 'Error: unavailable',
    })

    expect(container.querySelector('[data-testid="boot-failure-evidence"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="service-boot-failure"]')).toBeNull()
    expect(container.textContent).not.toContain('Evidence preserved')
  })

  it('updates an already mounted service card when live boot evidence appears and clears', () => {
    renderBootOverview()
    const card = container.querySelector('li')
    expect(container.querySelector('[data-testid="service-boot-failure"]')).toBeNull()
    renderBootOverview({
      service: 'api', safeName: 'api', reason: 'health-timeout', detail: 'Timed out.', logPath: '/run/svc-api.log',
      nextAction: 'Verify readiness, then restart.',
    })
    expect(container.querySelector('li')).toBe(card)
    expect(container.textContent).toContain('Service did not become ready before the timeout.')
    renderBootOverview()
    expect(container.querySelector('li')).toBe(card)
    expect(container.querySelector('[data-testid="service-boot-failure"]')).toBeNull()
  })

  it.each([
    undefined,
    [],
    [dependency({ verdict: 'compatible' })],
    [dependency({ verdict: 'unknown', warning: 'Legacy shared dependency state could not be proven.' })],
    [dependency({ verdict: 'unknown', warning: 'Canary could not link the shared dependency tree.' })],
  ])('renders no dependency information for unblocked evidence: %j', (provenance) => {
    renderOverview(provenance)
    expect(container.textContent).not.toMatch(/dependenc|unknown|compatible/i)
    expect(container.querySelector('[data-testid="dependency-evidence"]')).toBeNull()
    expect(container.querySelector('[data-testid="boot-failure-evidence"]')).toBeNull()
  })

  it('puts one actionable blocker in each affected service card with no standalone panel', () => {
    renderOverview([dependency({
      validation: { command: 'validate', cwd: '/worktree', exitCode: 1, signal: null, logPath: '/run/dependency.log' },
    }), dependency({ repoName: 'other', verdict: 'compatible' })])
    const blockers = container.querySelectorAll('[data-testid="service-dependency-blocker"]')
    expect(blockers).toHaveLength(2)
    expect([...blockers].map((blocker) => blocker.closest('li')!.textContent)).toEqual([
      expect.stringContaining('api'), expect.stringContaining('worker'),
    ])
    expect(blockers[0].textContent).toContain('Startup blocked by dependencies · app')
    expect(blockers[0].textContent).toContain('different generator inputs; generated output compatibility is unproven')
    expect(blockers[0].textContent).toContain('Prepare worktree-local dependencies.')
    expect(container.textContent).not.toContain('Old duplicate dependency message')
    expect(container.textContent).not.toContain('Dependency evidence')
    act(() => (blockers[0].querySelector('button') as HTMLButtonElement).click())
    expect(openRunLog).toHaveBeenCalledWith('run-1', '/run/dependency.log')
  })

  it('updates the already mounted overview when refreshed evidence clears or changes the block', () => {
    renderOverview([dependency()])
    const card = container.querySelector('li')
    expect(container.querySelectorAll('[data-testid="service-dependency-blocker"]')).toHaveLength(2)
    expect(container.textContent).not.toContain('Open dependency log')
    renderOverview([dependency({ incompatibilityCause: 'lockfile-mismatch' })])
    expect(container.querySelector('li')).toBe(card)
    expect(container.textContent).toContain('different lockfiles')
    renderOverview([dependency({ verdict: 'unknown' })])
    expect(container.querySelector('li')).toBe(card)
    expect(container.querySelector('[data-testid="service-dependency-blocker"]')).toBeNull()
  })
})
