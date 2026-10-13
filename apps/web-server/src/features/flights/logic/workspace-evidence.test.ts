import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { FlightStage } from '../../../../../../shared/flights/types'
import { readDocsCollection } from '../../coverage/logic/coverage/docs-collection'
import * as coverage from '../../coverage/logic/coverage/service'
import * as featureLoader from '../../../shared/feature-loader'
import * as runStore from '../../runs/logic/run-store'
import * as runDetail from '../../runs/logic/run-detail'
import {
  fillStageEvidence,
  stageEvidenceMissing,
  stagesNeedingEvidence,
  withWorkspaceEvidence,
  workspaceStageEvidence,
} from './workspace-evidence'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-wsev-')

let tmp: string
let featuresDir: string
let logsDir: string
let featureDir: string

const FEATURE = 'probe_demo'

function stage(key: FlightStage['key'], status: FlightStage['status'], evidence?: unknown): FlightStage {
  return evidence === undefined ? { key, status } : { key, status, evidence }
}

/** A saved portify overlay on disk — the artifact that proves portification. */
function writeOverlay(repos: Array<Record<string, unknown>>): void {
  const dir = path.join(featureDir, 'portify')
  fs.mkdirSync(dir, { recursive: true })
  for (const r of repos) fs.writeFileSync(path.join(dir, String(r.patch)), '')
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ version: 1, featureName: FEATURE, agent: 'claude', capturedAt: '2026-07-01T00:00:00.000Z', repos }),
  )
}

/** A run whose services all reached ready — the boot half of Suite setup. */
function writeBootedRun(runId: string, services: Array<{ name: string; readyAt: string }>): void {
  fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
  fs.writeFileSync(
    path.join(logsDir, 'runs', 'index.json'),
    JSON.stringify([{ runId, feature: FEATURE, startedAt: '2026-08-07T10:00:00Z', status: 'passed' }]),
  )
  const runDir = path.join(logsDir, 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({
      runId,
      feature: FEATURE,
      startedAt: '2026-08-07T10:00:00Z',
      status: 'passed',
      healCycles: 0,
      services: services.map((s) => ({ name: s.name, safeName: s.name, command: 'npm run dev', cwd: '/tmp', logPath: '/tmp/x.log', status: 'stopped', readyAt: s.readyAt })),
    }),
  )
}

function writePortifyIndex(rows: Array<Record<string, unknown>>): void {
  const dir = path.join(logsDir, 'portify')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(rows.map((r) => ({ id: r.workflowId, createdAt: r.startedAt, ...r }))))
}

/** Rewrite the fixture config's repos — Parallel readiness reads its port slots
 *  when no portify overlay exists. */
function writeRepos(repos: string): void {
  fs.writeFileSync(
    path.join(featureDir, 'feature.config.cjs'),
    `module.exports = { config: {
       name: '${FEATURE}',
       description: 'fixture',
       envs: ['local'],
       featureDir: __dirname,
       repos: ${repos},
     } }`,
  )
}

beforeEach(() => {
  tmp = tempDir()
  featuresDir = path.join(tmp, 'features')
  logsDir = path.join(tmp, 'logs')
  featureDir = path.join(featuresDir, FEATURE)
  fs.mkdirSync(featureDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.writeFileSync(
    path.join(featureDir, 'feature.config.cjs'),
    `module.exports = { config: {
       name: '${FEATURE}',
       description: 'fixture',
       envs: ['local'],
       featureDir: __dirname,
       repos: [],
     } }`,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('workspaceStageEvidence — shared evaluation inputs', () => {
  it('evaluates configuration once across scout, portify and coverage, then reads fresh configuration', () => {
    const counter = path.join(tmp, 'config-loads')
    const configure = (repos: string): void => {
      writeRepos(repos)
      fs.appendFileSync(path.join(featureDir, 'feature.config.cjs'),
        `\nrequire('fs').appendFileSync(${JSON.stringify(counter)}, 'x')\n`)
    }
    configure(`[{ name: 'app', localPath: __dirname, startCommands: [{ command: 'node app.js', ports: [{ name: 'http', env: 'PORT' }] }] }]`)
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout', 'portify', 'specs-coverage'])
    expect(fs.readFileSync(counter, 'utf8')).toBe('x')
    expect(ev.scout).toEqual({ repos: 1 })
    expect(ev.portify).toEqual({ declaredInjectable: 1, serviceCount: 1 })
    expect(ev['specs-coverage']).toMatchObject({ requirementCount: 0, testsWritten: 0 })

    configure('[]')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout', 'portify'])).toEqual({})
    expect(fs.readFileSync(counter, 'utf8')).toBe('xx')
  })

  it('uses the configured linked directory for documents and coverage', () => {
    const linkedDir = path.join(tmp, 'linked-suite')
    fs.mkdirSync(path.join(linkedDir, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(linkedDir, 'e2e'))
    fs.writeFileSync(path.join(linkedDir, 'docs', 'requirements.md'), '# Linked requirements')
    fs.writeFileSync(path.join(linkedDir, 'e2e', 'a.spec.ts'), "test('linked test', () => {})\n")
    fs.appendFileSync(path.join(featureDir, 'feature.config.cjs'),
      `\nmodule.exports.config.featureDir = ${JSON.stringify(linkedDir)}\n`)
    const compute = vi.spyOn(coverage, 'computeFeatureCoverage')
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['docs', 'specs-coverage'])
    expect(ev.docs).toEqual({ docs: ['requirements.md'] })
    expect(ev['specs-coverage']).toMatchObject({ testsWritten: 1 })
    expect(compute).toHaveBeenCalledWith({ featuresDir, logsDir, feature: FEATURE, featureDir: linkedDir })
  })

  it('shares the settled run and selects a newer result on the next evaluation', () => {
    writeBootedRun('older', [])
    const list = vi.spyOn(runStore, 'listRuns')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run', 'heal'])).toEqual({
      run: { runId: 'older', status: 'passed' },
      heal: { finalStatus: 'passed', healCycles: 0 },
    })
    expect(list).toHaveBeenCalledTimes(1)

    writeBootedRun('newer', [])
    fs.writeFileSync(path.join(logsDir, 'runs', 'index.json'), JSON.stringify([
      { runId: 'older', feature: FEATURE, status: 'passed', startedAt: '2026-08-07T10:00:00Z' },
      { runId: 'newer', feature: FEATURE, status: 'passed', startedAt: '2026-08-08T10:00:00Z' },
    ]))
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['heal', 'run']).run)
      .toEqual({ runId: 'newer', status: 'passed' })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('keeps coverage on the latest attempt while run and heal use the settled result', () => {
    writeBootedRun('settled', [])
    fs.writeFileSync(path.join(logsDir, 'runs', 'settled', 'e2e-summary.json'),
      JSON.stringify({ total: 1, passed: 1, passedNames: ['test-case-shared'], failed: [] }))
    const compute = vi.spyOn(coverage, 'computeFeatureCoverage')
    workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['specs-coverage'])
    expect(compute.mock.results[0].value.provenRunId).toBe('settled')

    fs.writeFileSync(path.join(logsDir, 'runs', 'index.json'), JSON.stringify([
      { runId: 'settled', feature: FEATURE, status: 'passed', startedAt: '2026-08-07T10:00:00Z' },
      { runId: 'active', feature: FEATURE, status: 'running', startedAt: '2026-08-08T10:00:00Z' },
    ]))
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run', 'heal', 'specs-coverage'])
    expect(ev.run).toMatchObject({ runId: 'settled', status: 'passed' })
    expect(ev.heal).toEqual({ finalStatus: 'passed', healCycles: 0 })
    expect(compute.mock.results[1].value.provenRunId).toBeUndefined()
  })

  it('shares absence when no eligible run exists', () => {
    writeBootedRun('active', [])
    fs.writeFileSync(path.join(logsDir, 'runs', 'index.json'), JSON.stringify([
      { runId: 'active', feature: FEATURE, status: 'running', startedAt: '2026-08-07T10:00:00Z' },
    ]))
    const list = vi.spyOn(runStore, 'listRuns')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run', 'heal'])).toEqual({})
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('does no discovery for unsupported keys or populated stages, and keeps expensive probes lazy', () => {
    const load = vi.spyOn(featureLoader, 'findFeature')
    const list = vi.spyOn(runStore, 'listRuns')
    const compute = vi.spyOn(coverage, 'computeFeatureCoverage')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['similarity', 'scaffold'])).toEqual({})
    const stages = [stage('run', 'done', { runId: 'recorded' }), stage('specs-coverage', 'done', { covered: 1 })]
    expect(withWorkspaceEvidence({ featuresDir, logsDir }, FEATURE, stages)).toBe(stages)
    expect(load).not.toHaveBeenCalled()
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['docs'])).toEqual({})
    expect(load).toHaveBeenCalledTimes(1)
    expect(list).not.toHaveBeenCalled()
    expect(compute).not.toHaveBeenCalled()
  })

  it('keeps heal evidence when the run summary probe throws', () => {
    writeBootedRun('settled', [])
    vi.spyOn(runDetail, 'readRunSummary').mockImplementationOnce(() => { throw new Error('summary read failed') })
    const list = vi.spyOn(runStore, 'listRuns')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run', 'heal'])).toEqual({
      heal: { finalStatus: 'passed', healCycles: 0 },
    })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('lets the next dependent probe retry a thrown lookup', () => {
    writeBootedRun('settled', [])
    const list = vi.spyOn(runStore, 'listRuns').mockImplementationOnce(() => { throw new Error('index read failed') })
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run', 'heal'])).toEqual({
      heal: { finalStatus: 'passed', healCycles: 0 },
    })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('propagates unavailable configuration and failed probes for strict evidence readers', () => {
    vi.spyOn(featureLoader, 'findFeature').mockImplementationOnce(() => { throw new Error('discovery failed') })
    expect(() => workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout'], 'local', true)).toThrow('discovery failed')
    vi.spyOn(runStore, 'listRuns').mockImplementationOnce(() => { throw new Error('index read failed') })
    expect(() => workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run'], 'local', true)).toThrow('index read failed')
    fs.appendFileSync(path.join(featureDir, 'feature.config.cjs'), '\ndelete module.exports.config.featureDir\n')
    expect(() => workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout'], 'local', true)).toThrow('Suite configuration is unavailable')
  })

  it('returns no evidence when discovery throws or the configured directory is absent', () => {
    vi.spyOn(featureLoader, 'findFeature').mockImplementationOnce(() => { throw new Error('discovery failed') })
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout'])).toEqual({})
    fs.appendFileSync(path.join(featureDir, 'feature.config.cjs'), '\ndelete module.exports.config.featureDir\n')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout'])).toEqual({})
  })
})

describe('stageEvidenceMissing', () => {
  it('treats undefined, null and an empty object as nothing to render', () => {
    expect(stageEvidenceMissing({ evidence: undefined })).toBe(true)
    expect(stageEvidenceMissing({ evidence: null })).toBe(true)
    expect(stageEvidenceMissing({ evidence: {} })).toBe(true)
  })

  it('treats any recorded key as present', () => {
    expect(stageEvidenceMissing({ evidence: { coveragePct: 0 } })).toBe(false)
  })
})

describe('stagesNeedingEvidence', () => {
  it('names only settled stages whose evidence is missing', () => {
    const stages = [
      stage('scaffold', 'done'),
      stage('env-capture', 'done', { captured: 2 }),
      stage('specs-coverage', 'skipped'),
      stage('portify', 'pending'),
      stage('run', 'running'),
      stage('heal', 'waiting-for-approval'),
    ]
    expect(stagesNeedingEvidence(stages)).toEqual(['scaffold', 'specs-coverage'])
  })
})

describe('fillStageEvidence', () => {
  it('fills a gap and marks the source, so a panel can tell probed from measured', () => {
    const [filled] = fillStageEvidence([stage('portify', 'done')], { 'portify': { edits: 0 } })
    expect(filled.evidence).toEqual({ edits: 0 })
    expect(filled.evidenceSource).toBe('workspace')
  })

  it('never overwrites what a stage recorded — the conducted measurement wins', () => {
    const recorded = stage('specs-coverage', 'done', { coveragePct: 100 })
    const [kept] = fillStageEvidence([recorded], { 'specs-coverage': { coveragePct: 36 } })
    expect(kept.evidence).toEqual({ coveragePct: 100 })
    expect(kept.evidenceSource).toBeUndefined()
  })

  it('leaves a stage alone when no block was probed for it', () => {
    const [untouched] = fillStageEvidence([stage('scout', 'done')], {})
    expect(untouched.evidence).toBeUndefined()
    expect(untouched.evidenceSource).toBeUndefined()
  })
})

describe('workspaceStageEvidence probes', () => {
  it('reports the captured envset file count for the named env', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'app.env'), 'A=1\n')
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'db.env'), 'B=2\n')
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'], 'local')
    expect(ev['env-capture']).toEqual({ captured: 2 })
  })

  it('omits env-capture when the envset dir exists but is empty', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'], 'local')
    expect(ev['env-capture']).toBeUndefined()
  })

  // Suite setup's other half. An app with no env files captures nothing, so the
  // boot is the only evidence it can ever produce — and it is the same evidence
  // the conducted stage reports.
  it('reports the boot that proved the config, with no envset captured', () => {
    writeBootedRun('r_boot', [{ name: 'catalog-service', readyAt: '2026-08-07T10:00:05Z' }])
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'], 'local')
    expect(ev['env-capture']).toEqual({ boot: { runId: 'r_boot', services: [{ name: 'catalog-service', status: 'ready' }] } })
  })

  it('reports both halves when the feature captured an envset and booted', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'app.env'), 'A=1\n')
    writeBootedRun('r_boot', [{ name: 'api', readyAt: '2026-08-07T10:00:05Z' }])
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'], 'local')['env-capture'])
      .toEqual({ captured: 1, boot: { runId: 'r_boot', services: [{ name: 'api', status: 'ready' }] } })
  })

  it('lists source requirement docs and excludes the generated summary', () => {
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', 'prd-plan.md'), '# plan\n')
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.md'), '# generated\n')
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['docs'])
    expect(ev['docs']).toEqual({ docs: ['prd-plan.md'] })
  })

  it('counts requirements from the distilled summary', () => {
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'docs', '_prd-summary.json'),
      JSON.stringify({ requirements: [{ id: 'R1' }, { id: 'R2' }, { id: 'R3' }] }),
    )
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['prd-summary'])
    expect(ev['prd-summary']).toEqual({ requirementCount: 3 })
  })

  // Repo scan reports what a scan OBSERVED, and no artifact records that — but
  // the repo LIST is a config read, the same one the panel's own tiles perform.
  // Without it a flight resumed past this step marked the row skipped over a
  // fully populated pane.
  it('reports the configured repositories for Repo scan, counting a shared tree once', () => {
    writeRepos(`[
      { name: 'a', localPath: __dirname, startCommands: [{ name: 'a', command: 'x' }] },
      { name: 'b', localPath: __dirname + '/', startCommands: [{ name: 'b', command: 'y' }] },
    ]`)
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout'])['scout'])
      .toEqual({ repos: 1 })
  })

  // A suite whose config declares no `repos` key at all — the shape a
  // remote-URL-only feature has, and the shape every config had before repos
  // were introduced. Reading the count off `undefined` would throw during a
  // read-time probe, which runs on every flight-picker render.
  it('reports nothing for Repo scan when the config declares no repos', () => {
    fs.writeFileSync(
      path.join(featureDir, 'feature.config.cjs'),
      `module.exports = { config: {
         name: '${FEATURE}',
         description: 'fixture',
         envs: ['local'],
         featureDir: __dirname,
       } }`,
    )
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['scout'])['scout'])
      .toBeUndefined()
  })

  // What a scan saw is still never invented — only `similarity` has nothing on
  // disk to read at all, so it stays out of the probe table entirely.
  it('never probes similarity — nothing records which suites were compared', () => {
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['similarity'])['similarity'])
      .toBeUndefined()
  })

  // A suite whose start commands already declare a port slot per service is
  // concurrency-ready by construction, so portify correctly never ran and left
  // no overlay. Reading that as "no evidence" ticked the stage and rendered its
  // whole panel blank.
  it('reports a natively injectable suite from its config when no overlay exists', () => {
    writeRepos(`[
      { name: 'a', localPath: __dirname, startCommands: [{ name: 'a', command: 'x', ports: [{ name: 'a', env: 'PORT' }] }] },
      { name: 'b', localPath: __dirname, startCommands: [{ name: 'b', command: 'y', ports: [{ name: 'b', env: 'PORT' }] }] },
    ]`)
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify'])
      .toEqual({ declaredInjectable: 2, serviceCount: 2 })
  })

  // The workflow record is where the PROOF lives (the double boot, the diff);
  // the config only holds a declaration nothing has tested. Gating the lookup on
  // an overlay hid the proof whenever the patch was absent — a no-op
  // port-ification, one the user removed, or edits landed upstream.
  it('prefers a saved workflow over the config declaration when no overlay exists', () => {
    writeRepos(`[
      { name: 'a', localPath: __dirname, startCommands: [{ name: 'a', command: 'x', ports: [{ name: 'a', env: 'PORT' }] }] },
    ]`)
    writePortifyIndex([
      { workflowId: 'portify-proof', feature: FEATURE, status: 'saved', startedAt: '2026-06-25T09:50:54.369Z', endedAt: '2026-06-25T09:54:03.420Z' },
    ])
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify'])
      .toEqual({ workflowId: 'portify-proof' })
  })

  it('falls through to the config when the only workflow on record never saved', () => {
    writeRepos(`[
      { name: 'a', localPath: __dirname, startCommands: [{ name: 'a', command: 'x', ports: [{ name: 'a', env: 'PORT' }] }] },
    ]`)
    writePortifyIndex([
      { workflowId: 'portify-abandoned', feature: FEATURE, status: 'aborted', startedAt: '2026-06-25T09:50:54.369Z' },
    ])
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify'])
      .toEqual({ declaredInjectable: 1, serviceCount: 1 })
  })

  it('reports nothing for a suite that is only PARTLY slotted — that one still needs portify', () => {
    writeRepos(`[
      { name: 'a', localPath: __dirname, startCommands: [{ name: 'a', command: 'x', ports: [{ name: 'a', env: 'PORT' }] }] },
      { name: 'b', localPath: __dirname, startCommands: [{ name: 'b', command: 'y' }] },
    ]`)
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify']).toBeUndefined()
  })

  it('prefers a real overlay over the config fallback', () => {
    writeRepos(`[{ name: 'a', localPath: __dirname, startCommands: [{ name: 'a', command: 'x', ports: [{ name: 'a', env: 'PORT' }] }] }]`)
    writeOverlay([{ name: 'a', baseSha: 'abc', patch: 'a.patch', touchedFiles: ['build.gradle'] }])
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify'])
      .toEqual({ edits: 1 })
  })

  it('reports a saved no-op overlay as 0 edits, not as no overlay', () => {
    fs.mkdirSync(path.join(featureDir, 'portify'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'portify', 'svc.patch'), '')
    fs.writeFileSync(
      path.join(featureDir, 'portify', 'meta.json'),
      JSON.stringify({
        version: 1,
        featureName: FEATURE,
        agent: 'claude',
        capturedAt: '2026-07-01T00:00:00.000Z',
        repos: [{ name: 'svc', baseSha: 'abc', patch: 'svc.patch', touchedFiles: [] }],
      }),
    )
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])
    expect(ev['portify']).toEqual({ edits: 0 })
  })

  it('carries the saved workflow id so the facts row and drill-through unlock', () => {
    writeOverlay([{ name: 'a', baseSha: 'abc', patch: 'a.patch', touchedFiles: [] }])
    writePortifyIndex([
      { workflowId: 'portify-older', feature: FEATURE, status: 'saved', startedAt: '2026-06-01T00:00:00.000Z', endedAt: '2026-06-01T00:10:00.000Z' },
      { workflowId: 'portify-newest', feature: FEATURE, status: 'saved', startedAt: '2026-06-25T09:50:54.369Z', endedAt: '2026-06-25T09:54:03.420Z' },
      // A row that never recorded an end falls back to its start for ordering.
      { workflowId: 'portify-no-end', feature: FEATURE, status: 'saved', startedAt: '2026-06-10T00:00:00.000Z' },
      // Neither an abandoned attempt nor another feature's workflow may claim it.
      { workflowId: 'portify-aborted', feature: FEATURE, status: 'aborted', startedAt: '2026-07-01T00:00:00.000Z', endedAt: '2026-07-01T00:01:00.000Z' },
      { workflowId: 'portify-elsewhere', feature: 'other_suite', status: 'saved', startedAt: '2026-07-02T00:00:00.000Z', endedAt: '2026-07-02T00:01:00.000Z' },
    ])
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify'])
      .toEqual({ edits: 0, workflowId: 'portify-newest' })
  })

  it('omits the workflow id for a hand-written overlay with no workflow on record', () => {
    writeOverlay([{ name: 'a', baseSha: 'abc', patch: 'a.patch', touchedFiles: [] }])
    writePortifyIndex([])
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify'])
      .toEqual({ edits: 0 })
  })

  it('sums rewritten files across repos, counting an older entry with no touchedFiles as none', () => {
    fs.mkdirSync(path.join(featureDir, 'portify'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'portify', 'a.patch'), '')
    fs.writeFileSync(path.join(featureDir, 'portify', 'b.patch'), '')
    fs.writeFileSync(
      path.join(featureDir, 'portify', 'meta.json'),
      JSON.stringify({
        version: 1,
        featureName: FEATURE,
        agent: 'claude',
        capturedAt: '2026-07-01T00:00:00.000Z',
        repos: [
          { name: 'a', baseSha: 'abc', patch: 'a.patch', touchedFiles: ['src/app.ts', 'src/db.ts'] },
          { name: 'b', baseSha: 'def', patch: 'b.patch' },
        ],
      }),
    )
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['portify'])['portify'])
      .toEqual({ edits: 2 })
  })

  it('reads the latest settled run with the score off its summary artifact', () => {
    const runId = '2026-07-01T0245-o456'
    fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'runs', 'index.json'),
      JSON.stringify([
        { runId: '2026-06-01T0100-old0', feature: FEATURE, startedAt: '2026-06-01T01:00:00.000Z', status: 'failed' },
        { runId, feature: FEATURE, startedAt: '2026-07-01T02:45:00.000Z', status: 'passed' },
        // None of these four are a feature test run, however recent they are.
        { runId: 'boot-1', feature: FEATURE, startedAt: '2026-07-02T00:00:00.000Z', status: 'passed', executionType: 'boot' },
        { runId: 'bench-1', feature: FEATURE, startedAt: '2026-07-03T00:00:00.000Z', status: 'passed', executionType: 'benchmark' },
        { runId: 'cell-1', feature: FEATURE, startedAt: '2026-07-03T12:00:00.000Z', status: 'failed', executionType: 'robustness' },
        { runId: 'verify-1', feature: FEATURE, startedAt: '2026-07-04T00:00:00.000Z', status: 'passed', executionType: 'verify' },
        { runId: 'other-feature', feature: 'somebody_else', startedAt: '2026-07-05T00:00:00.000Z', status: 'passed' },
      ]),
    )
    const runDir = path.join(logsDir, 'runs', runId)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({ total: 23, passed: 23, failed: [] }))
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run'])
    expect(ev['run']).toEqual({ runId, status: 'passed', counts: { passed: 23, total: 23, failed: 0 } })
  })

  it('never probes similarity or scout — no artifact records what a scan saw', () => {
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['similarity', 'scout'])
    expect(ev).toEqual({})
  })

  it('returns nothing for a feature that does not load, instead of failing the read', () => {
    expect(workspaceStageEvidence({ featuresDir, logsDir }, 'no_such_feature', ['env-capture'])).toEqual({})
  })
})

describe('withWorkspaceEvidence', () => {
  it('returns the identical array when every settled stage already has evidence', () => {
    const stages = [stage('portify', 'done', { edits: 3 }), stage('run', 'pending')]
    expect(withWorkspaceEvidence({ featuresDir, logsDir }, FEATURE, stages)).toBe(stages)
  })

  it('fills only the gap, leaving recorded evidence untouched', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'app.env'), 'A=1\n')
    const stages = [stage('scaffold', 'done', { reused: true }), stage('env-capture', 'done')]
    const out = withWorkspaceEvidence({ featuresDir, logsDir }, FEATURE, stages, 'local')
    expect(out[0].evidence).toEqual({ reused: true })
    expect(out[0].evidenceSource).toBeUndefined()
    expect(out[1].evidence).toEqual({ captured: 1 })
    expect(out[1].evidenceSource).toBe('workspace')
  })
})

describe('workspaceStageEvidence — the any-env envset scan', () => {
  it('accepts the first non-empty envset when no env is named, skipping empties and stray files', () => {
    const envsets = path.join(featureDir, 'envsets')
    fs.mkdirSync(path.join(envsets, 'aaa-empty'), { recursive: true })
    fs.mkdirSync(path.join(envsets, 'bbb-full'), { recursive: true })
    fs.writeFileSync(path.join(envsets, 'envsets.config.json'), '{}')
    fs.writeFileSync(path.join(envsets, 'bbb-full', 'app.env'), 'A=1\n')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'])['env-capture'])
      .toEqual({ captured: 1 })
  })

  it('omits env-capture when there is no envsets dir at all', () => {
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'])['env-capture'])
      .toBeUndefined()
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'], 'local')['env-capture'])
      .toBeUndefined()
  })

  it('omits env-capture when every envset dir is empty, whatever files sit beside them', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    // A non-directory entry must be stepped over rather than counted — the
    // envsets.config.json declaration is not a capture.
    fs.writeFileSync(path.join(featureDir, 'envsets', 'envsets.config.json'), '{}')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['env-capture'])['env-capture'])
      .toBeUndefined()
  })
})

describe('workspaceStageEvidence — absent artifacts report nothing', () => {
  it('omits docs, prd-summary and portify when their artifacts are missing', () => {
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['docs', 'prd-summary', 'portify'])
    expect(ev['docs']).toBeUndefined()
    expect(ev['prd-summary']).toBeUndefined()
    expect(ev['portify']).toBeUndefined()
  })

  it('omits prd-summary when the summary holds no requirements', () => {
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), JSON.stringify({ requirements: [] }))
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['prd-summary'])['prd-summary'])
      .toBeUndefined()
  })

  it('omits run and heal when the feature has no settled run', () => {
    fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'runs', 'index.json'),
      JSON.stringify([{ runId: 'r-live', feature: FEATURE, startedAt: '2026-07-01T00:00:00.000Z', status: 'running' }]),
    )
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run', 'heal'])
    expect(ev['run']).toBeUndefined()
    expect(ev['heal']).toBeUndefined()
  })

  it('omits the export block when no completed archive exists', () => {
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['evaluation-export'])['evaluation-export'])
      .toBeUndefined()
  })
})

describe('workspaceStageEvidence — coverage, heal and export probes', () => {
  function writeSettledRun(runId: string, manifest?: Record<string, unknown>): string {
    fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
    fs.writeFileSync(
      path.join(logsDir, 'runs', 'index.json'),
      JSON.stringify([{ runId, feature: FEATURE, startedAt: '2026-07-01T02:45:00.000Z', status: 'passed' }]),
    )
    const runDir = path.join(logsDir, 'runs', runId)
    fs.mkdirSync(runDir, { recursive: true })
    if (manifest) fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest))
    return runDir
  }

  it('reports the live ledger — the number a "target met" sentence would have to be true about', () => {
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(featureDir, 'docs', '_prd-summary.json'),
      JSON.stringify({
        requirements: [
          { id: 'R1', kind: 'functional', title: 'one', text: 't1', pathTypes: ['happy'], variants: [] },
          { id: 'R2', kind: 'functional', title: 'two', text: 't2', pathTypes: ['sad'], variants: [] },
        ],
        variantDimension: null,
        docsHash: readDocsCollection(featureDir).docsHash,
        sourceDocs: [],
        generatedAt: '2026-07-01T00:00:00.000Z',
      }),
    )
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'a.spec.ts'), "test('x', () => {})\n")
    const ev = workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['specs-coverage'])['specs-coverage']
    expect(ev).toMatchObject({
      mappingState: 'absent',
      requirementCount: 2,
      testsWritten: 1,
      total: 2,
    })
    expect(typeof ev!.coveragePct).toBe('number')
    expect(typeof ev!.covered).toBe('number')
  })

  it('mirrors the run manifest for the heal half, including the give-up reason', () => {
    writeSettledRun('2026-07-01T0245-o456', { healCycles: 2, healEnd: { reason: 'max-cycles' } })
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['heal'])['heal'])
      .toEqual({ finalStatus: 'passed', healCycles: 2, healEnd: { reason: 'max-cycles' } })
  })

  it('omits heal cycles the manifest does not carry, rather than reporting zero', () => {
    writeSettledRun('2026-07-01T0245-o456', { status: 'passed' })
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['heal'])['heal'])
      .toEqual({ finalStatus: 'passed' })
  })

  it('omits heal when the run directory has no manifest to mirror', () => {
    writeSettledRun('2026-07-01T0245-o456')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['heal'])['heal']).toBeUndefined()
  })

  it('reports the run without counts when the summary artifact is absent', () => {
    writeSettledRun('2026-07-01T0245-o456')
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['run'])['run'])
      .toEqual({ runId: '2026-07-01T0245-o456', status: 'passed' })
  })

  it('points at the newest completed export archive', () => {
    const dir = path.join(logsDir, 'evaluation-exports')
    const task = (taskId: string, updatedAt: string) => ({
      taskId,
      runId: 'r1',
      feature: FEATURE,
      mode: 'raw',
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt,
      downloadReady: true,
      archiveBase: taskId,
    })
    const older = task('eval-older', '2026-07-01T01:00:00.000Z')
    const newer = task('eval-newer', '2026-07-02T01:00:00.000Z')
    fs.mkdirSync(path.join(dir, older.taskId), { recursive: true })
    fs.mkdirSync(path.join(dir, newer.taskId), { recursive: true })
    fs.writeFileSync(path.join(dir, older.taskId, 'task.json'), JSON.stringify(older))
    fs.writeFileSync(path.join(dir, newer.taskId, 'task.json'), JSON.stringify(newer))
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify([older, newer].map((t) => ({ id: t.taskId, createdAt: t.createdAt, taskId: t.taskId, runId: t.runId, feature: t.feature, status: t.status }))),
    )
    expect(workspaceStageEvidence({ featuresDir, logsDir }, FEATURE, ['evaluation-export'])['evaluation-export'])
      .toEqual({ taskId: 'eval-newer', runId: 'r1', mode: 'raw' })
  })
})

describe('stageEvidenceMissing — non-object evidence', () => {
  it('treats a primitive as present, so a probe never clobbers it', () => {
    expect(stageEvidenceMissing({ evidence: 'boot ok' })).toBe(false)
  })
})
