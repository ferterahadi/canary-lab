import { describe, expect, it } from 'vitest'
import {
  demoCheckpointChoice,
  isSuccessfulDemoStage,
  needsPassedRunForExport,
  parseArgs,
  workflowsToRecord,
} from './record-getting-started.mjs'

const catalog = [
  { id: 'run', title: 'Repair', internalAction: { kind: 'run', feature: 'storefront-journey' }, unavailableReason: null },
  { id: 'flight', title: 'Flight', internalAction: { kind: 'flight', repoPath: '/w/flight-app' }, unavailableReason: null },
  { id: 'coverage', title: 'Coverage', internalAction: { kind: 'coverage', feature: 'workflow-workbench' }, unavailableReason: null },
  { id: 'author', title: 'Author', internalAction: { kind: 'author', feature: 'workflow-workbench' }, unavailableReason: null },
  { id: 'portify', title: 'Portify', internalAction: { kind: 'portify', feature: 'workflow-workbench' }, unavailableReason: null },
  { id: 'verify', title: 'Verify', internalAction: { kind: 'verify', feature: 'workflow-workbench' }, unavailableReason: null },
  { id: 'export', title: 'Export', internalAction: { kind: 'export', feature: 'storefront-journey' }, unavailableReason: null },
]

describe('Getting Started recorder', () => {
  it('normalizes the server URL and accepts recording controls', () => {
    expect(parseArgs([
      '--url', 'http://127.0.0.1:61377/?dialog=demo',
      '--workflow', 'verify',
      '--linger', '0',
      '--headed',
      '--no-cleanup',
    ])).toMatchObject({
      url: 'http://127.0.0.1:61377',
      workflow: 'verify',
      lingerMs: 0,
      headed: true,
      cleanup: false,
    })
  })

  it('records every server-owned workflow once with Repair before Export', () => {
    expect(workflowsToRecord(catalog, 'all').map((workflow) => workflow.id)).toEqual([
      'verify', 'portify', 'author', 'run', 'export', 'flight', 'coverage',
    ])
  })

  it('refuses an unavailable workflow before opening a browser', () => {
    expect(() => workflowsToRecord([
      { id: 'run', title: 'Repair', internalAction: null, unavailableReason: 'fixture removed' },
    ], 'run')).toThrow('Repair cannot run here: fixture removed')
  })

  it('rejects an unknown workflow id', () => {
    expect(() => parseArgs(['--url', 'http://127.0.0.1:7421', '--workflow', 'unknown']))
      .toThrow('--workflow must be all or one of')
  })

  it('waits for Repair only when Export has no passed product run yet', () => {
    expect(needsPassedRunForExport(catalog, [])).toBe(true)
    expect(needsPassedRunForExport(catalog, [
      { feature: 'storefront-journey', executionType: 'run', status: 'passed' },
    ])).toBe(false)
    expect(needsPassedRunForExport(catalog, [
      { feature: 'storefront-journey', executionType: 'boot', status: 'passed' },
    ])).toBe(true)
  })

  it('drives the successful choices for the two completion demos', () => {
    expect(demoCheckpointChoice('portify', 'portify-gate')).toBe('run')
    expect(demoCheckpointChoice('portify', 'portify-apply')).toBe('apply')
    expect(demoCheckpointChoice('export', 'export-mode')).toBe('raw')
    expect(demoCheckpointChoice('export', 'run-failed')).toBeNull()
  })

  it('accepts only completed or previously verified parallel-readiness stages', () => {
    expect(isSuccessfulDemoStage({ status: 'done' })).toBe(true)
    expect(isSuccessfulDemoStage({ status: 'skipped', skipReason: 'already portified (double-boot verified by a prior flight/portify)' })).toBe(true)
    expect(isSuccessfulDemoStage({ status: 'skipped', skipReason: 'declined' })).toBe(false)
    expect(isSuccessfulDemoStage({ status: 'failed' })).toBe(false)
  })
})
