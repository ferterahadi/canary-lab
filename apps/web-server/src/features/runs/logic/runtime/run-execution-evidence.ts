import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { RunExecutionEvidence } from '../../../../../../../shared/run-collaboration'
import { atomicWriteJson } from '../../../../../../../shared/lib/atomic-write'
import { suiteReviewFiles } from './suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from './suite-runtime-inputs'
import { readManifest } from './manifest'
import type { PlaywrightRerunSelection } from './rerun-targets'
import type { RunContext } from './run-context'

/** Save only reviewable bytes. Runtime inputs and envset backups are secrets,
 * and must never become immutable history alongside authored source. */
export function retainRunSource(runDir: string, suiteDir: string): string {
  const { before } = suiteReviewFiles(suiteDir, suiteDir, suiteRuntimeInputTargetsForSnapshot(suiteDir))
  const hash = createHash('sha256')
  for (const [name, bytes] of [...before].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([name, bytes.length])).update(bytes)
  const version = hash.digest('hex')
  const target = path.join(runDir, 'history', 'sources', version)
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const staging = fs.mkdtempSync(path.join(path.dirname(target), '.source-'))
    try {
      for (const [name, bytes] of before) {
        const file = path.join(staging, name)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, bytes)
      }
      fs.renameSync(staging, target)
    } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  }
  return version
}

function evidencePath(runDir: string, index: number): string {
  return path.join(runDir, 'history', 'executions', `${index}.json`)
}

export function beginExecutionEvidence(ctx: RunContext, index: number, selection?: PlaywrightRerunSelection): RunExecutionEvidence {
  const evidence: RunExecutionEvidence = {
    index, ...(fs.existsSync(ctx.suiteDir) ? { sourceVersion: retainRunSource(ctx.runDir, ctx.suiteDir) } : {}), startedAt: new Date().toISOString(),
    selection: selection ? 'targeted' : 'full-suite',
    ...(selection?.kind === 'targets' ? { targets: [...selection.targets] } : selection?.kind === 'grep' ? { grep: selection.grep } : {}), outputPath: `history/executions/${index}.stdout.log`,
  }
  atomicWriteJson(evidencePath(ctx.runDir, index), evidence)
  fs.writeFileSync(path.join(ctx.runDir, evidence.outputPath), '')
  return evidence
}

export function finishExecutionEvidence(ctx: RunContext, evidence: RunExecutionEvidence, exitCode: number): void {
  const summaryPath = `history/executions/${evidence.index}.summary.json`
  if (fs.existsSync(ctx.paths.summaryPath)) fs.copyFileSync(ctx.paths.summaryPath, path.join(ctx.runDir, summaryPath))
  atomicWriteJson(evidencePath(ctx.runDir, evidence.index), {
    ...evidence, endedAt: new Date().toISOString(), exitCode,
    ...(fs.existsSync(path.join(ctx.runDir, summaryPath)) ? { summaryPath } : {}),
  })
}

export function readExecutionEvidence(runDir: string): RunExecutionEvidence[] {
  const dir = path.join(runDir, 'history', 'executions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name)).flatMap((name) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as RunExecutionEvidence] }
    catch { return [] /* An incomplete evidence record must not invent an execution. */ }
  }).sort((a, b) => a.index - b.index)
}

/** Older runs lack per-attempt records. Retain the last available output without
 * claiming that today's snapshot proves which bytes that historical attempt ran. */
export function retainLegacyExecution(ctx: RunContext): void {
  const manifest = readManifest(ctx.paths.manifestPath)
  const index = manifest?.playwrightExecutions ?? 0
  if (!fs.existsSync(ctx.paths.summaryPath) || fs.existsSync(evidencePath(ctx.runDir, index))) return
  const outputPath = `history/executions/${index}.stdout.log`
  const summaryPath = `history/executions/${index}.summary.json`
  fs.mkdirSync(path.dirname(evidencePath(ctx.runDir, index)), { recursive: true })
  fs.copyFileSync(ctx.paths.summaryPath, path.join(ctx.runDir, summaryPath))
  if (fs.existsSync(ctx.paths.playwrightStdoutPath)) fs.copyFileSync(ctx.paths.playwrightStdoutPath, path.join(ctx.runDir, outputPath))
  else fs.writeFileSync(path.join(ctx.runDir, outputPath), '')
  atomicWriteJson(evidencePath(ctx.runDir, index), {
    index, recovered: true, selection: 'unavailable', outputPath, summaryPath,
    ...(manifest?.endedAt ? { endedAt: manifest.endedAt } : {}),
  } satisfies RunExecutionEvidence)
}
