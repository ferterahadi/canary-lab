import fs from 'node:fs'
import path from 'node:path'
import type { Attempt, AttemptResult, ExecutionResult, StudyManifest } from './types'
import { canaryRunDir, changed, checked, command, copy, digest, hashes, json, readJson, sourceRoot, write } from './files'
import { dependencies, evaluate } from './evaluator'
import { dependencyFingerprint, sourceFingerprint } from './prepare'
import { schedule } from './scenarios'
import { report } from './report'
import { totalTokens } from './usage'
import { assertExperiment, preflightTokens } from './experiment'
import { verifyCodexToolArgs } from './tool-policy'
import { runtimePreflight } from './runtime-preflight'
import type { StudyAdapter } from './study-adapter'

export function loadStudy(root: string): StudyManifest {
  const actual = fs.realpathSync(root)
  const manifest = readJson<StudyManifest>(path.join(actual, 'study.json'))
  const domain = manifest.repository ? ['overlap', 'independent'] as const : undefined
  if (manifest.schemaVersion !== 1 || manifest.root !== actual || JSON.stringify(manifest.attempts) !== JSON.stringify(schedule(manifest.selection, manifest.design, domain && [...domain])) || manifest.budgetMs !== 900_000) {
    throw new Error('Invalid study manifest or study moved; prepare a new study')
  }
  assertExperiment(manifest)
  if (manifest.status === 'preparing') throw new Error('Preparation did not complete; inspect preparation evidence')
  return manifest
}
export function integrity(root: string, snapshot: string, suite: string): { changedFiles: string[]; contamination: string[] } {
  const appChanges = changed(hashes(snapshot), hashes(path.join(root, 'app')))
  const allowed = /^(catalog-service|inventory-service|checkout-service|shared)\/[^.][^]*\.(ts|js)$/
  const contamination = appChanges.filter((name) => !allowed.test(name) && name !== '.gitignore')
  if (fs.existsSync(path.join(root, 'app/.gitignore')) && fs.readFileSync(path.join(root, 'app/.gitignore'), 'utf8') !== '.state/\nnode_modules/\n') contamination.push('app/.gitignore')
  const protectedFiles = changed(hashes(suite), hashes(path.join(root, 'suite')))
  contamination.push(...protectedFiles.map((name) => `suite/${name}`))
  // Canary can run a private suite copy. Original-suite integrity alone cannot
  // establish that the tests the agent actually ran stayed unchanged.
  const runtimeSuite = path.join(canaryRunDir(root), 'suite')
  if (fs.existsSync(runtimeSuite)) {
    const before = hashes(suite); const after = hashes(runtimeSuite)
    for (const name of Object.keys(before).filter((file) => file.startsWith('e2e/') || file === 'playwright.config.ts')) {
      if (before[name] !== after[name]) contamination.push(`run/suite/${name}`)
    }
  }
  return { changedFiles: appChanges.filter((name) => allowed.test(name)), contamination }
}
export async function executeWorker(manifest: StudyManifest, attempt: Attempt, root: string, signal: AbortSignal): Promise<ExecutionResult> {
  const result = await command(process.execPath, ['--import', 'tsx', path.join(__dirname, 'worker.ts'), path.join(manifest.root, 'study.json'), attempt.id,
    ...(manifest.repository ? ['--owner-lease'] : [])], {
    cwd: sourceRoot, timeoutMs: manifest.budgetMs + 15_000, log: path.join(root, 'worker.log'), signal,
    parentLease: Boolean(manifest.repository),
  })
  const output = path.join(root, 'execution.json')
  const execution: ExecutionResult = fs.existsSync(output) ? readJson<ExecutionResult>(output)
    : { status: 'infrastructure-error', reason: 'Worker failed without an execution receipt', usage: null, testExecutions: null }
  if (signal.aborted) return { ...execution, status: 'interrupted', reason: 'Study interrupted' }
  if (result.timedOut) return { ...execution, status: 'timeout', reason: 'Worker exceeded wall-clock limit' }
  if (result.code !== 0) return { ...execution, status: 'infrastructure-error', reason: `Worker exit: ${result.code}; ${execution.reason}` }
  return execution
}

export async function runStudy(root: string, options: {
  resume?: boolean; signal?: AbortSignal; stopAfter?: number
  execute?: typeof executeWorker
  verify?: typeof evaluate
  checkFingerprints?: boolean
} = {}): Promise<StudyManifest> {
  const manifest = loadStudy(root)
  const adapter: StudyAdapter | undefined = manifest.repository
    ? (await import('./repository/campaign')).repositoryStudyAdapter : undefined
  if (options.stopAfter !== undefined && (!Number.isSafeInteger(options.stopAfter) || options.stopAfter < 1 || options.stopAfter > manifest.attempts.length)) {
    throw new Error('stopAfter must be a whole number within the frozen attempt schedule')
  }
  // A repeated staged command must not pay for preflight after reaching its
  // cumulative checkpoint. A higher checkpoint still uses the normal gates.
  if (options.stopAfter !== undefined && manifest.results.length >= options.stopAfter && !manifest.active) return manifest
  adapter?.authorize(manifest)
  const lock = path.join(root, 'study.lock')
  if (fs.existsSync(lock)) {
    const owner = readJson<{ pid: number }>(lock)
    let alive = true
    try { process.kill(owner.pid, 0) } catch { alive = false }
    if (alive || !options.resume) throw new Error('Study is locked; stop its owner or use --resume after it has exited')
    fs.unlinkSync(lock)
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
  const save = (): void => {
    manifest.revision = (manifest.revision ?? 0) + 1
    json(path.join(root, 'study.json'), manifest)
  }
  try {
    if (options.checkFingerprints !== false) {
      assertExperiment(manifest, true)
      if (adapter) await adapter.check(manifest)
      else if (manifest.sourceDigest !== sourceFingerprint() || manifest.frozenDigest !== digest(path.join(root, 'frozen')) ||
          manifest.dependencyDigest !== dependencyFingerprint(path.join(root, 'runtime/node_modules'))) throw new Error('Frozen inputs, dependencies, or study implementation changed; prepare again')
      for (const agent of manifest.design?.mode === 'replay' ? [] : ['codex', 'claude'] as const) {
        if (await checked(manifest.pins[agent].executable ?? agent, ['--version'], root) !== manifest.pins[agent].version) throw new Error(`${agent} CLI changed since preparation`)
      }
      if (adapter) await adapter.preflight(manifest)
      else if (manifest.design?.mode !== 'replay') await runtimePreflight(manifest)
      save()
    }
    if (manifest.active) {
      if (!options.resume) throw new Error('Previous attempt was interrupted; use --resume to preserve it and continue')
      if (manifest.repository) {
        const { reconcileRepositoryChecks } = await import('./repository/check-recovery')
        reconcileRepositoryChecks(root, manifest.active.attempt.id)
      }
      const savedReceipt = path.join(root, 'receipts', `${manifest.active.attempt.id}.json`)
      const recovered = fs.existsSync(savedReceipt) ? readJson<AttemptResult>(savedReceipt) : null
      const workerReceipt = path.join(root, 'attempts', manifest.active.attempt.id, 'execution.json')
      const execution = manifest.repository && fs.existsSync(workerReceipt) ? readJson<ExecutionResult>(workerReceipt) : null
      if (recovered && recovered.id !== manifest.active.attempt.id) throw new Error('Interrupted attempt receipt has a different identity')
      const preserved: AttemptResult = recovered ?? { ...manifest.active.attempt, outcome: 'interrupted', startedAt: manifest.active.startedAt,
        repairMs: null, verificationMs: 0, usage: execution?.usage ?? null, attribution: execution?.attribution, telemetry: execution?.telemetry,
        testExecutions: execution?.testExecutions ?? null, humanInterventions: 0, changedFiles: [],
        reason: 'Previous process exited without a receipt; elapsed time unavailable', evidence: `attempts/${manifest.active.attempt.id}` }
      json(savedReceipt, preserved)
      manifest.results.push(preserved)
      manifest.active = null; save()
    }
    manifest.status = 'running'; delete manifest.stopReason; save()
    for (const attempt of manifest.attempts) {
      if (manifest.results.some((result) => result.id === attempt.id)) continue
      if (options.signal?.aborted) break
      if (manifest.experiment) {
        const totals = manifest.design?.mode === 'replay' ? [0] : [preflightTokens(manifest), ...manifest.results.map((row) => totalTokens(row.agent, row.usage))]
        const failed = manifest.results.find((row) => row.outcome !== 'success')
        const violation = manifest.repository && manifest.results.find((row) => row.adherence?.status === 'violation')
        if (failed || violation || totals.includes(null) || totals.reduce<number>((n, value) => n + (value ?? 0), 0) >= manifest.experiment.maxTokens) {
          manifest.stopReason = failed ? `Stopped after ${failed.id}: ${failed.outcome}; investigate in a new campaign` : violation ?
            `Stopped after ${violation.id}: diagnosis policy violation; independent verdict preserved; investigate in a new campaign` :
            totals.includes(null) ? 'Usage unknown; cannot enforce dispatch ceiling' : 'Token dispatch ceiling reached'
          break
        }
      }
      if (options.stopAfter !== undefined && manifest.results.length >= options.stopAfter) {
        manifest.stopReason = `Paused after ${manifest.results.length} recorded attempts at the requested checkpoint`
        break
      }
      if (options.checkFingerprints !== false && (manifest.sourceDigest !== sourceFingerprint() ||
          manifest.dependencyVersions.node !== process.version || (manifest.design?.mode !== 'replay' && await checked(manifest.pins[attempt.agent].executable ?? attempt.agent, ['--version'], root) !== manifest.pins[attempt.agent].version))) {
        throw new Error('Implementation, Node, or agent CLI changed during the campaign; prepare a new study')
      }
      adapter?.authorize(manifest)
      if (adapter && options.checkFingerprints !== false) await adapter.check(manifest)
      const attemptRoot = path.join(root, 'attempts', attempt.id)
      if (options.checkFingerprints !== false && manifest.design?.mode !== 'replay' && attempt.agent === 'codex') await verifyCodexToolArgs(manifest.codexToolArgs, root, manifest.pins.codex.executable)
      if (fs.existsSync(attemptRoot)) throw new Error(`Attempt directory already exists without a receipt: ${attemptRoot}`)
      const dispatch = performance.now()
      const dispatchedAt = new Date().toISOString()
      const snapshot = path.join(root, 'frozen', attempt.scenario)
      const suite = path.join(root, 'frozen', attempt.workflow === 'canary' ? 'original-suite' : 'plain-suite')
      const startedAt = new Date().toISOString()
      manifest.active = { attempt, startedAt }; save()
      let started: number | null = null
      const receipt: AttemptResult = { ...attempt, startedAt, outcome: 'infrastructure-error', repairMs: null, verificationMs: 0,
        usage: null, testExecutions: null, humanInterventions: 0, changedFiles: [], reason: '', evidence: `attempts/${attempt.id}`,
        timing: { dispatchedAt, workerReturnedAt: null, evaluatorStartedAt: null, evaluatorCompletedAt: null, independentVerdictMs: null, elapsedMs: 0 } }
      try {
        if (adapter) await adapter.setup(manifest, attempt, attemptRoot)
        else {
          copy(snapshot, path.join(attemptRoot, 'app')); copy(suite, path.join(attemptRoot, 'suite')); dependencies(attemptRoot, root)
          write(path.join(attemptRoot, 'app/.gitignore'), '.state/\nnode_modules/\n')
          await checked('git', ['init', '-q'], path.join(attemptRoot, 'app'))
          await checked('git', ['add', '.'], path.join(attemptRoot, 'app'))
          await checked('git', ['-c', 'user.name=Study', '-c', 'user.email=study@example.invalid', 'commit', '-qm', 'Frozen broken snapshot'], path.join(attemptRoot, 'app'))
        }
        started = Date.now()
        receipt.startedAt = new Date().toISOString()
        manifest.active = { attempt, startedAt: receipt.startedAt }; save()
        const execution = await (options.execute ?? executeWorker)(manifest, attempt, attemptRoot, options.signal ?? new AbortController().signal)
        receipt.repairMs = Date.now() - started
        receipt.timing!.workerReturnedAt = new Date().toISOString()
        receipt.attribution = execution.attribution; receipt.adherence = execution.adherence
        receipt.telemetry = execution.telemetry; receipt.reason = execution.reason; receipt.usage = execution.usage; receipt.testExecutions = execution.testExecutions
        if (options.checkFingerprints !== false && (manifest.sourceDigest !== sourceFingerprint() || manifest.frozenDigest !== digest(path.join(root, 'frozen')))) {
          throw new Error('Study inputs changed during the attempt; its comparison is invalid')
        }
        if (adapter && options.checkFingerprints !== false) await adapter.check(manifest)
        const check = adapter ? adapter.integrity(manifest, attempt, attemptRoot) : integrity(attemptRoot, snapshot, suite)
        receipt.changedFiles = check.changedFiles
        const appRoot = path.join(attemptRoot, 'app')
        // Never run Git inside an agent-controlled .git directory: local hooks
        // and fsmonitor configuration can execute code outside its sandbox.
        const patchRoot = path.join(root, 'receipts', `${attempt.id}-snapshot`)
        copy(snapshot, path.join(patchRoot, 'before')); copy(appRoot, path.join(patchRoot, 'after'))
        const patch = await command('git', ['diff', '--no-index', '--binary', '--', 'before', 'after'], { cwd: patchRoot })
        if (patch.code !== 0 && patch.code !== 1) throw new Error(`Could not capture candidate patch: ${patch.stderr}`)
        write(path.join(root, 'receipts', `${attempt.id}.patch`), patch.stdout)
        if (check.contamination.length) { receipt.outcome = 'contaminated'; receipt.reason += `; protected edits: ${check.contamination.join(', ')}` }
        else if (execution.status !== 'finished') receipt.outcome = execution.status
        else {
          const verificationStart = Date.now()
          receipt.timing!.evaluatorStartedAt = new Date().toISOString()
          try {
            const repositoryVerdict = adapter ? await adapter.verify(manifest, attempt, attemptRoot, options.signal ?? new AbortController().signal) : undefined
            const evidence = adapter ? undefined : await (options.verify ?? evaluate)(root, appRoot, path.join(root, 'frozen/original-suite'), path.join(root, 'evaluation', attempt.id), true)
            receipt.timing!.evaluatorCompletedAt = new Date().toISOString()
            receipt.timing!.independentVerdictMs = performance.now() - dispatch
            receipt.outcome = (repositoryVerdict ? repositoryVerdict.success : evidence!.code === 0 && evidence!.roster.length === 7 && evidence!.passed.length === 7 && evidence!.extras === true) ? 'success' : 'failed'
            if (repositoryVerdict) receipt.reason += `; evidence: ${repositoryVerdict.evidence}`
            if (options.signal?.aborted) receipt.outcome = 'interrupted'
            receipt.reason += `; independent evaluator: ${receipt.outcome}`
          } finally { receipt.verificationMs = Date.now() - verificationStart }
        }
      } catch (error) {
        if (receipt.repairMs === null && started !== null) receipt.repairMs = Date.now() - started
        receipt.reason = String(error)
        receipt.outcome = options.signal?.aborted ? 'interrupted' : 'infrastructure-error'
      }
      receipt.timing!.elapsedMs = performance.now() - dispatch
      if (options.signal?.aborted) receipt.humanInterventions++
      json(path.join(root, 'receipts', `${attempt.id}.json`), receipt)
      manifest.results.push(receipt); manifest.active = null; save(); report(manifest)
      process.stdout.write(`${receipt.id}: ${receipt.outcome}\n`)
    }
    manifest.status = manifest.results.length === manifest.attempts.length ? 'complete' : 'ready'
    save(); report(manifest)
    return manifest
  } finally { fs.unlinkSync(lock) }
}
