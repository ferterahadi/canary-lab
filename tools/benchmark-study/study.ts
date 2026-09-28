import fs from 'node:fs'
import path from 'node:path'
import type { Attempt, AttemptResult, ExecutionResult, StudyManifest } from './types'
import { canaryRunDir, changed, checked, command, copy, digest, hashes, json, readJson, sourceRoot, write } from './files'
import { dependencies, evaluate } from './evaluator'
import { dependencyFingerprint, sourceFingerprint } from './prepare'
import { schedule } from './scenarios'
import { report } from './report'
import { verifyCodexToolArgs } from './tool-policy'
import { runtimePreflight } from './runtime-preflight'

export function loadStudy(root: string): StudyManifest {
  const actual = fs.realpathSync(root)
  const manifest = readJson<StudyManifest>(path.join(actual, 'study.json'))
  if (manifest.schemaVersion !== 1 || manifest.root !== actual || JSON.stringify(manifest.attempts) !== JSON.stringify(schedule(manifest.selection, manifest.design)) || manifest.budgetMs !== 900_000) {
    throw new Error('Invalid study manifest or study moved; prepare a new study')
  }
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
  const result = await command(process.execPath, ['--import', 'tsx', path.join(__dirname, 'worker.ts'), path.join(manifest.root, 'study.json'), attempt.id], {
    cwd: sourceRoot, timeoutMs: manifest.budgetMs + 15_000, log: path.join(root, 'worker.log'), signal,
  })
  const output = path.join(root, 'execution.json')
  if (signal.aborted) return { status: 'interrupted', reason: 'Study interrupted', usage: null, testExecutions: null }
  if (result.timedOut) return { status: 'timeout', reason: 'Worker exceeded wall-clock limit', usage: null, testExecutions: null }
  if (result.code !== 0 || !fs.existsSync(output)) return { status: 'infrastructure-error', reason: 'Worker failed without an execution receipt', usage: null, testExecutions: null }
  return readJson<ExecutionResult>(output)
}

export async function runStudy(root: string, options: {
  resume?: boolean; signal?: AbortSignal
  execute?: typeof executeWorker
  verify?: typeof evaluate
  checkFingerprints?: boolean
} = {}): Promise<StudyManifest> {
  const manifest = loadStudy(root)
  const lock = path.join(root, 'study.lock')
  if (fs.existsSync(lock)) {
    const owner = readJson<{ pid: number }>(lock)
    let alive = true
    try { process.kill(owner.pid, 0) } catch { alive = false }
    if (alive || !options.resume) throw new Error('Study is locked; stop its owner or use --resume after it has exited')
    fs.unlinkSync(lock)
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
  const save = (): void => json(path.join(root, 'study.json'), manifest)
  try {
    if (options.checkFingerprints !== false) {
      if (manifest.sourceDigest !== sourceFingerprint() || manifest.frozenDigest !== digest(path.join(root, 'frozen')) ||
          manifest.dependencyDigest !== dependencyFingerprint(path.join(root, 'runtime/node_modules'))) throw new Error('Frozen inputs, dependencies, or study implementation changed; prepare again')
      for (const agent of manifest.design?.mode === 'replay' ? [] : ['codex', 'claude'] as const) {
        if (await checked(manifest.pins[agent].executable ?? agent, ['--version'], root) !== manifest.pins[agent].version) throw new Error(`${agent} CLI changed since preparation`)
      }
      if (manifest.design?.mode !== 'replay') await runtimePreflight(manifest)
      save()
    }
    if (manifest.active) {
      if (!options.resume) throw new Error('Previous attempt was interrupted; use --resume to preserve it and continue')
      const savedReceipt = path.join(root, 'receipts', `${manifest.active.attempt.id}.json`)
      const recovered = fs.existsSync(savedReceipt) ? readJson<AttemptResult>(savedReceipt) : null
      if (recovered && recovered.id !== manifest.active.attempt.id) throw new Error('Interrupted attempt receipt has a different identity')
      const preserved: AttemptResult = recovered ?? { ...manifest.active.attempt, outcome: 'interrupted', startedAt: manifest.active.startedAt,
        repairMs: null, verificationMs: 0, usage: null, testExecutions: null, humanInterventions: 0, changedFiles: [],
        reason: 'Previous process exited without a receipt; elapsed time unavailable', evidence: `attempts/${manifest.active.attempt.id}` }
      json(savedReceipt, preserved)
      manifest.results.push(preserved)
      manifest.active = null; save()
    }
    manifest.status = 'running'; save()
    for (const attempt of manifest.attempts) {
      if (manifest.results.some((result) => result.id === attempt.id)) continue
      if (options.signal?.aborted) break
      if (options.checkFingerprints !== false && (manifest.sourceDigest !== sourceFingerprint() ||
          manifest.dependencyVersions.node !== process.version || (manifest.design?.mode !== 'replay' && await checked(manifest.pins[attempt.agent].executable ?? attempt.agent, ['--version'], root) !== manifest.pins[attempt.agent].version))) {
        throw new Error('Implementation, Node, or agent CLI changed during the campaign; prepare a new study')
      }
      const attemptRoot = path.join(root, 'attempts', attempt.id)
      if (options.checkFingerprints !== false && manifest.design?.mode !== 'replay' && attempt.agent === 'codex') await verifyCodexToolArgs(manifest.codexToolArgs, root, manifest.pins.codex.executable)
      if (fs.existsSync(attemptRoot)) throw new Error(`Attempt directory already exists without a receipt: ${attemptRoot}`)
      const snapshot = path.join(root, 'frozen', attempt.scenario)
      const suite = path.join(root, 'frozen', attempt.workflow === 'canary' ? 'original-suite' : 'plain-suite')
      copy(snapshot, path.join(attemptRoot, 'app')); copy(suite, path.join(attemptRoot, 'suite')); dependencies(attemptRoot, root)
      write(path.join(attemptRoot, 'app/.gitignore'), '.state/\nnode_modules/\n')
      await checked('git', ['init', '-q'], path.join(attemptRoot, 'app'))
      await checked('git', ['add', '.'], path.join(attemptRoot, 'app'))
      await checked('git', ['-c', 'user.name=Study', '-c', 'user.email=study@example.invalid', 'commit', '-qm', 'Frozen broken snapshot'], path.join(attemptRoot, 'app'))
      const startedAt = new Date().toISOString()
      manifest.active = { attempt, startedAt }; save()
      const started = Date.now()
      const receipt: AttemptResult = { ...attempt, startedAt, outcome: 'infrastructure-error', repairMs: 0, verificationMs: 0,
        usage: null, testExecutions: null, humanInterventions: 0, changedFiles: [], reason: '', evidence: `attempts/${attempt.id}` }
      try {
        const execution = await (options.execute ?? executeWorker)(manifest, attempt, attemptRoot, options.signal ?? new AbortController().signal)
        receipt.repairMs = Date.now() - started
        receipt.telemetry = execution.telemetry; receipt.reason = execution.reason; receipt.usage = execution.usage; receipt.testExecutions = execution.testExecutions
        if (options.checkFingerprints !== false && (manifest.sourceDigest !== sourceFingerprint() || manifest.frozenDigest !== digest(path.join(root, 'frozen')))) {
          throw new Error('Study inputs changed during the attempt; its comparison is invalid')
        }
        const check = integrity(attemptRoot, snapshot, suite)
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
          try {
            const evidence = await (options.verify ?? evaluate)(root, appRoot, path.join(root, 'frozen/original-suite'), path.join(root, 'evaluation', attempt.id), true)
            receipt.outcome = evidence.code === 0 && evidence.roster.length === 7 && evidence.passed.length === 7 && evidence.extras === true ? 'success' : 'failed'
            if (options.signal?.aborted) receipt.outcome = 'interrupted'
            receipt.reason += `; independent evaluator: ${receipt.outcome}`
          } finally { receipt.verificationMs = Date.now() - verificationStart }
        }
      } catch (error) {
        receipt.repairMs ||= Date.now() - started
        receipt.reason = String(error)
        receipt.outcome = options.signal?.aborted ? 'interrupted' : 'infrastructure-error'
      }
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
