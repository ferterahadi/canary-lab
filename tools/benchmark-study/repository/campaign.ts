import fs from 'node:fs'
import path from 'node:path'
import { checked, copy, digest, hashes, inside, json, readJson, sha, sourceRoot } from '../files'
import { dependencyFingerprint, sourceFingerprint, validatePins } from '../prepare'
import { schedule } from '../scenarios'
import { configurationDigest, policyDigests, preflightTokens } from '../experiment'
import { totalTokens } from '../usage'
import { report } from '../report'
import { resolveCodexToolArgs } from '../tool-policy'
import { resolveAgentBinary } from '../../../apps/web-server/src/features/agent-sessions/logic/agent-binary'
import type { Agent, ModelPin, StudyDesign, StudyManifest, StudySelection } from '../types'
import type { StudyAdapter } from '../study-adapter'
import { loadRepositoryStudy } from './adapter'
import { evaluateRepositoryCandidate, verifyCandidateSource } from './candidate'
import { repositoryCacheDigest, repositoryCacheEntries } from './dependencies'
import { assertionDiagnostics } from './check-broker'
import { writeRepositoryFailureContext } from './failure-context'
import { childAuditIdentity, freezeChildAudit, verifyChildAuditIdentity } from './child-audit'
import { freezeChildReadGuard } from './child-read-guard'
import { loadStudy } from '../study'

export function verifyRepositoryContinuation(selection: StudySelection | undefined, design: StudyDesign, sourceCommit: string,
  pins: Record<Agent, ModelPin>, maxTokens: number): void {
  const continuation = selection?.continuation
  if (!continuation) return
  const file = path.join(continuation.sourceStudy, 'study.json')
  if (sha(fs.readFileSync(file)) !== continuation.sourceManifestSha256) throw new Error('Continuation source manifest changed')
  const previous = loadStudy(continuation.sourceStudy)
  if (previous.active || previous.status === 'running' || !previous.repository || previous.selection?.continuation ||
      previous.repository.sourceCommit !== sourceCommit || JSON.stringify(previous.design) !== JSON.stringify(design) ||
      JSON.stringify(previous.selection) !== JSON.stringify({ agent: selection.agent, ...(selection.scenario ? { scenario: selection.scenario } : {}) }) ||
      JSON.stringify(previous.results.map((result) => result.id)) !== JSON.stringify(continuation.recordedAttemptIds) ||
      JSON.stringify(previous.pins) !== JSON.stringify(pins)) {
    throw new Error('Continuation must retain the stopped campaign design, pins and every recorded outcome')
  }
  const usage = previous.results.map((result) => totalTokens(result.agent, result.usage))
  const preflight = preflightTokens(previous)
  if (preflight === null || usage.some((tokens) => tokens === null) || !previous.experiment ||
      maxTokens > previous.experiment.maxTokens - preflight - usage.reduce<number>((sum, tokens) => sum + (tokens ?? 0), 0)) {
    throw new Error('Continuation cannot replace unknown usage or increase the remaining token allowance')
  }
}

export function assertRepositoryAuthorization(manifest: StudyManifest): void {
  if (!manifest.repository || manifest.repository.kind !== 'unfamiliar-repository-campaign' || manifest.repository.authorizationRequired !== true ||
      !manifest.experiment || configurationDigest(manifest) !== manifest.experiment.configurationDigest) {
    throw new Error('Repository campaign configuration is invalid or changed')
  }
  if (manifest.design?.mode === 'replay') return
  const file = path.join(manifest.root, 'source-transfer-approval.json')
  if (!fs.existsSync(file)) throw new Error('Repository source transfer and paid execution are not approved; freeze and review the campaign first')
  const approval = readJson<{ configurationDigest: string; sourceTransfer: boolean; paidExecution: boolean; approvedAt: string }>(file)
  if (!manifest.experiment || approval.configurationDigest !== manifest.experiment.configurationDigest ||
      approval.sourceTransfer !== true || approval.paidExecution !== true || !Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new Error('Repository approval does not authorize this frozen campaign')
  }
}

export async function prepareRepositoryCampaign(options: { study: string; playwrightNodeModules: string; yarnCacheFolder: string;
  design: StudyDesign; pins: Record<Agent, { model: string; effort: string }>; selection?: StudySelection; maxTokens: number; maxChecks: number }): Promise<StudyManifest> {
  const local = loadRepositoryStudy(options.study)
  if (local.status !== 'validated' || !local.validation || !local.validationRuntime) throw new Error('Campaign preparation requires a validated local repository study')
  if (fs.existsSync(path.join(local.root, 'study.json'))) throw new Error('A campaign already exists for this study; prepare a new local study')
  if (options.design.mode !== 'replay' && !options.design.variants) throw new Error('Live repository campaigns require explicit diagnosis variants')
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || !Number.isSafeInteger(options.maxChecks) || options.maxChecks < 1 || options.maxChecks > 100) {
    throw new Error('A positive token dispatch ceiling and 1–100 checks per attempt are required')
  }
  const attempts = schedule(options.selection, options.design, ['overlap', 'independent'])
  const started = Date.now()
  if (options.design.mode !== 'replay') validatePins(options.pins)
  const pins = {} as Record<Agent, ModelPin>
  for (const agent of ['codex', 'claude'] as const) {
    if (options.design.mode === 'replay') { pins[agent] = { model: 'scripted', effort: 'none', version: 'no-cloud-agent' }; continue }
    const resolved = resolveAgentBinary(agent)
    if (!resolved) throw new Error(`Cannot resolve ${agent} CLI`)
    const executable = fs.realpathSync(resolved)
    pins[agent] = { ...options.pins[agent], executable, version: await checked(executable, ['--version'], local.root) }
  }
  verifyRepositoryContinuation(options.selection, options.design, local.sourceCommit, pins, options.maxTokens)
  const modules = fs.realpathSync(options.playwrightNodeModules)
  const cache = fs.realpathSync(options.yarnCacheFolder)
  const cacheEntries = repositoryCacheEntries(cache, [path.join(local.root, 'attempts/clean/source/yarn.lock'), path.join(local.root, 'frozen/fixture/host/yarn.lock')])
  if (inside(local.root, modules) || inside(local.root, cache) || inside(modules, local.root) || inside(cache, local.root)) {
    throw new Error('Campaign dependency inputs must not overlap the study')
  }
  if (!fs.existsSync(path.join(modules, '@playwright/test/cli.js'))) throw new Error('Playwright runtime is unavailable')
  fs.cpSync(modules, path.join(local.root, 'runtime/node_modules'), { recursive: true, verbatimSymlinks: true })
  for (const scenario of ['overlap', 'independent'] as const) {
    const source = path.join(local.root, 'attempts', scenario, 'source')
    const previous = options.selection?.continuation && path.join(options.selection.continuation.sourceStudy, 'frozen', scenario)
    // Validation rebuilds source maps with absolute paths. Retain the original
    // frozen bytes after confirming the actual source inputs are identical.
    if (previous && verifyCandidateSource(source, previous).changedSourceFiles.length) throw new Error('Continuation source inputs changed')
    copy(previous || source, path.join(local.root, 'frozen', scenario))
  }
  for (const agent of new Set(attempts.map((attempt) => attempt.agent))) for (const scenario of ['overlap', 'independent']) {
    writeRepositoryFailureContext(path.join(local.root, 'frozen/diagnosis', agent, scenario),
      assertionDiagnostics(path.join(local.root, 'evaluation', scenario, 'playwright.json')), agent, pins[agent])
  }
  const childAudit = options.design.mode !== 'replay' && attempts.some((attempt) => attempt.agent === 'codex') ? childAuditIdentity(pins.codex.model) : undefined
  if (childAudit) { verifyChildAuditIdentity(childAudit); freezeChildAudit(local.root, childAudit) }
  if (options.design.mode !== 'replay') freezeChildReadGuard(local.root)
  const manifest: StudyManifest = { schemaVersion: 1, status: 'ready', root: local.root, createdAt: new Date().toISOString(),
    sourceWorkspace: local.sourceCheckout, sourceRevision: await checked('git', ['rev-parse', 'HEAD'], sourceRoot), sourceDigest: sourceFingerprint(),
    dependencyDigest: dependencyFingerprint(path.join(local.root, 'runtime/node_modules')),
    dependencyVersions: { node: process.version, yarn: local.yarnVersion, playwright: readJson<{ version: string }>(path.join(modules, '@playwright/test/package.json')).version },
    pins, budgetMs: 900_000, preparationMs: Date.now() - started, preparation: { repositoryValidation: local.validation },
    snapshots: Object.fromEntries(['overlap', 'independent'].map((scenario) => [scenario, digest(path.join(local.root, 'frozen', scenario))])),
    frozenDigest: digest(path.join(local.root, 'frozen')), attempts, design: options.design, selection: options.selection, results: [], active: null,
    codexToolArgs: options.design.mode === 'replay' ? [] : await resolveCodexToolArgs(local.root, pins.codex.executable),
    repository: { kind: 'unfamiliar-repository-campaign', localManifestDigest: sha(fs.readFileSync(path.join(local.root, 'repository-study.json'))),
      sourceCommit: local.sourceCommit, fixtureRoot: local.fixtureRoot, sourceCheckout: local.sourceCheckout, yarnCacheFolder: cache,
      yarnCacheDigest: repositoryCacheDigest(cache, cacheEntries), yarnCacheEntries: cacheEntries,
      expectedRoster: local.validation.clean.roster, maxChecks: options.maxChecks,
      authorizationRequired: true, ...(childAudit ? { childAudit } : {}) } }
  manifest.experiment = { configurationDigest: '', promptDigests: policyDigests(manifest), maxTokens: options.maxTokens }
  manifest.experiment.configurationDigest = configurationDigest(manifest)
  if (options.selection?.continuation) {
    const previous = loadStudy(options.selection.continuation.sourceStudy)
    if (JSON.stringify(manifest.snapshots) !== JSON.stringify(previous.snapshots) ||
        manifest.dependencyDigest !== previous.dependencyDigest || manifest.repository!.yarnCacheDigest !== previous.repository!.yarnCacheDigest ||
        manifest.repository!.maxChecks !== previous.repository!.maxChecks) {
      throw new Error('Continuation cannot change frozen source snapshots, dependencies or check limits')
    }
  }
  manifest.preparationMs = Date.now() - started
  json(path.join(local.root, 'study.json'), manifest)
  report(manifest)
  return manifest
}

export const repositoryStudyAdapter: StudyAdapter = {
  authorize: assertRepositoryAuthorization,
  async preflight(manifest) {
    // Preparation's oracle and native isolation receipts remain evidence, not
    // paid preflight authorization. This hook makes no provider calls.
    const local = loadRepositoryStudy(manifest.root)
    if (local.status !== 'validated' || !local.isolation || Object.values(local.isolation).some((row) => row.osSandbox !== 'passed')) {
      throw new Error('Repository local validation and isolation are incomplete')
    }
  },
  async check(manifest) {
    const repository = manifest.repository!
    verifyRepositoryContinuation(manifest.selection, manifest.design!, repository.sourceCommit, manifest.pins, manifest.experiment!.maxTokens)
    if (repository.childAudit) verifyChildAuditIdentity(repository.childAudit)
    loadRepositoryStudy(manifest.root)
    if (repository.kind !== 'unfamiliar-repository-campaign' || repository.authorizationRequired !== true ||
        repository.localManifestDigest !== sha(fs.readFileSync(path.join(manifest.root, 'repository-study.json'))) ||
        manifest.sourceDigest !== sourceFingerprint() || manifest.frozenDigest !== digest(path.join(manifest.root, 'frozen')) ||
        manifest.dependencyDigest !== dependencyFingerprint(path.join(manifest.root, 'runtime/node_modules')) ||
        repository.yarnCacheDigest !== repositoryCacheDigest(repository.yarnCacheFolder, repository.yarnCacheEntries)) {
      throw new Error('Repository campaign inputs changed; prepare a new study')
    }
  },
  async setup(manifest, attempt, root) {
    copy(path.join(manifest.root, 'frozen', attempt.scenario), path.join(root, 'app'))
    copy(path.join(manifest.root, 'frozen/diagnosis', attempt.agent, attempt.scenario), root)
  },
  integrity(manifest, attempt, root) {
    try {
      const context = path.join(manifest.root, 'frozen/diagnosis', attempt.agent, attempt.scenario)
      for (const [name, expected] of Object.entries(hashes(context)).filter(([name]) => name !== 'diagnosis-ledger.json')) {
        const file = path.join(root, name)
        if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || sha(fs.readFileSync(file)) !== expected) {
          throw new Error(`Protected failure context changed: ${name}`)
        }
      }
      const check = verifyCandidateSource(path.join(root, 'app'), path.join(manifest.root, 'attempts', attempt.scenario, 'source'))
      return { changedFiles: check.changedSourceFiles, contamination: [] }
    } catch (error) { return { changedFiles: [], contamination: [String(error)] } }
  },
  async verify(manifest, attempt, root, signal) {
    const evaluationId = `${attempt.id}-independent`
    const receipt = await evaluateRepositoryCandidate({ study: manifest.root, scenario: attempt.scenario as 'overlap' | 'independent',
      candidate: path.join(root, 'app'), playwrightNodeModules: path.join(manifest.root, 'runtime/node_modules'),
      yarnCacheFolder: manifest.repository!.yarnCacheFolder, signal, campaign: { attemptId: attempt.id, evaluationId } })
    const success = receipt.status === 'passed' && receipt.code === 0 && receipt.skipped.length === 0 && receipt.failed.length === 0 &&
      JSON.stringify(receipt.roster) === JSON.stringify(manifest.repository!.expectedRoster) && receipt.passed.length === receipt.roster.length
    json(path.join(manifest.root, 'evaluation', attempt.id, 'verdict.json'), receipt)
    return { success, evidence: `evaluation/${attempt.id}/verdict.json` }
  },
}
