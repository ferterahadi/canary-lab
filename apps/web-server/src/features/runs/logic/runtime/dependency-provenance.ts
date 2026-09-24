import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import type { RunDependencyProvenance, DependencyFingerprint } from '../../../../../../../shared/dependency-provenance'
import type { DependencyPreparation } from '../../../../../../../shared/launcher/types'
import { runGit } from '../../../../shared/git-repo'
import { linkNodeModules, sanitizeRepoFileName, type WorktreeHandle } from './repo-worktree'
import { redactDiagnosticText } from './diagnostic-redaction'

const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb']

export interface PrepareWorktreeDependenciesInput {
  handle: WorktreeHandle
  config?: DependencyPreparation
  /** Run-start proof requirements cannot disappear during an active repair. */
  requiredConfig?: DependencyPreparation
  runDir: string
  configurationError?: string
}

function preparationConfigError(config: DependencyPreparation | undefined, required: DependencyPreparation | undefined): string | undefined {
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) return 'dependencyPreparation must be an object.'
  if (config?.mode !== undefined && config.mode !== 'shared' && config.mode !== 'isolated') return 'dependencyPreparation.mode must be "shared" or "isolated".'
  if (config?.generatorInputs !== undefined && (!Array.isArray(config.generatorInputs) || config.generatorInputs.some((item) => typeof item !== 'string' || !item.trim()))) return 'dependencyPreparation.generatorInputs must contain non-empty file paths.'
  for (const key of ['prepareCommand', 'validateCommand'] as const) {
    if (config?.[key] !== undefined && (typeof config[key] !== 'string' || !config[key].trim())) return `dependencyPreparation.${key} must be a non-empty command.`
  }
  if (required?.mode === 'isolated' && config?.mode !== 'isolated') return 'Restore dependencyPreparation.mode "isolated" for this active run. Repair its worktree-local dependencies; do not downgrade dependency isolation to bypass the gate.'
  if (required?.validateCommand && !config?.validateCommand) return 'Restore dependencyPreparation.validateCommand for this active run and repair the rejected dependency state. Do not remove the validator to bypass the gate.'
  const removedInputs = Array.isArray(required?.generatorInputs)
    ? required.generatorInputs.filter((item) => !config?.generatorInputs?.includes(item))
    : []
  if (removedInputs.length > 0) return `Restore dependencyPreparation.generatorInputs for this active run: ${removedInputs.join(', ')}. Repair the input/dependency mismatch; do not remove measured inputs to bypass the gate.`
  return undefined
}

function sha256File(filePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

function fingerprint(base: string, relativePath: string): DependencyFingerprint {
  const fullPath = path.resolve(base, relativePath)
  return { path: relativePath, sha256: sha256File(fullPath) }
}

function nearestLockfile(start: string, boundary: string): DependencyFingerprint | null {
  let dir = path.resolve(start)
  const stop = path.resolve(boundary)
  while (dir === stop || dir.startsWith(`${stop}${path.sep}`)) {
    for (const name of LOCKFILES) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return { path: path.relative(stop, candidate), sha256: sha256File(candidate) }
    }
    if (dir === stop) break
    dir = path.dirname(dir)
  }
  return null
}

function packageManagerAt(root: string, lockfile: DependencyFingerprint | null): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { packageManager?: unknown }
    if (typeof pkg.packageManager === 'string' && pkg.packageManager.trim()) return pkg.packageManager.trim()
  } catch {
    // A package-manager identity is optional provenance, never a boot gate.
  }
  const name = lockfile?.path.split(path.sep).pop()
  if (name === 'pnpm-lock.yaml') return 'pnpm'
  if (name === 'yarn.lock') return 'yarn'
  if (name === 'package-lock.json') return 'npm'
  if (name === 'bun.lock' || name === 'bun.lockb') return 'bun'
  return null
}

function dependencyRealPath(dependencyPath: string): string | null {
  try { return fs.realpathSync(dependencyPath) } catch { return null }
}

/**
 * Run one target-owned preparation/validation command. Async on purpose: these
 * are the target's own `npm ci`/codegen steps, and a sync spawn would block the
 * single web-server event loop — no WebSocket pushes, REST replies or health
 * polling for every other in-flight run — for the command's whole wall clock.
 */
function runTargetCommand(
  command: string,
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; signal: string | null; failed: boolean }> {
  const shell = process.env.SHELL ?? '/bin/bash'
  return new Promise((resolve) => {
    execFile(shell, ['-lc', command], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const spawnError = error && typeof (error as { code?: unknown }).code !== 'number' ? error.message : undefined
      const exitCode = typeof (error as { code?: unknown } | null)?.code === 'number'
        ? (error as { code: number }).code
        : error ? null : 0
      const signal = (error as { signal?: string } | null)?.signal ?? null
      const output = redactDiagnosticText(`${stdout}${stderr}${spawnError ? `\n${spawnError}` : ''}`)
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, output)
      resolve({ exitCode, signal, failed: Boolean(error) })
    })
  })
}

function mismatch(
  left: DependencyFingerprint | null,
  right: DependencyFingerprint | null,
): boolean {
  return Boolean(left?.sha256 && right?.sha256 && left.sha256 !== right.sha256)
}

function generatorMismatch(
  source: DependencyFingerprint[],
  dependency: DependencyFingerprint[],
): boolean {
  return source.some((item, index) => {
    const peer = dependency[index]
    if (!peer) return true
    if (item.sha256 === null && peer.sha256 === null) return false
    return item.sha256 !== peer.sha256
  })
}

/**
 * Prepare one run worktree without inferring an ecosystem-specific generator.
 * Shared legacy state stays runnable but unknown. Only explicit, target-owned
 * evidence can make it compatible; any confirmed mismatch is returned for the
 * orchestrator to persist and block before service spawn.
 */
export async function prepareWorktreeDependencies(
  input: PrepareWorktreeDependenciesInput,
): Promise<RunDependencyProvenance> {
  const { handle, runDir } = input
  const configurationError = input.configurationError ?? preparationConfigError(input.config, input.requiredConfig)
  const config = configurationError ? {} : input.config ?? {}
  const mode = config.mode ?? 'shared'
  const dependencyPath = path.join(handle.worktreeRoot, 'node_modules')
  const logPath = path.join(runDir, `dependency-${sanitizeRepoFileName(handle.repoName)}.log`)

  const { error: rawLinkError } = mode === 'shared' && !configurationError ? linkNodeModules(handle) : {}
  const linkError = rawLinkError ? redactDiagnosticText(rawLinkError) : undefined

  const realDependencyPath = dependencyRealPath(dependencyPath)
  const realWorktreeRoot = fs.realpathSync(handle.worktreeRoot)
  const localRel = path.relative(handle.worktreeRoot, handle.localPath)
  const dependencyOwnerRoot = realDependencyPath ? path.dirname(realDependencyPath) : null
  const dependencyLocalPath = dependencyOwnerRoot ? path.join(dependencyOwnerRoot, localRel) : null
  const revision = await runGit(handle.worktreeRoot, ['rev-parse', 'HEAD'])
  const sourceRevision = revision.code === 0 ? revision.stdout.trim() || null : null
  const lockfile = nearestLockfile(handle.localPath, handle.worktreeRoot)
  const dependencyLockfile = dependencyOwnerRoot && dependencyLocalPath
    ? nearestLockfile(dependencyLocalPath, dependencyOwnerRoot)
    : null
  const generatorInputs = (config.generatorInputs ?? []).map((item) => fingerprint(handle.localPath, item))
  const dependencyGeneratorInputs = dependencyLocalPath
    ? (config.generatorInputs ?? []).map((item) => fingerprint(dependencyLocalPath, item))
    : []
  const base = {
    repoName: handle.repoName,
    sourceRevision,
    sourcePath: handle.sourceRoot,
    worktreePath: realWorktreeRoot,
    dependencyPath: fs.existsSync(dependencyPath) ? dependencyPath : null,
    dependencyRealPath: realDependencyPath,
    lockfile,
    dependencyLockfile,
    generatorInputs,
    dependencyGeneratorInputs,
    runtime: { node: process.version, packageManager: packageManagerAt(handle.worktreeRoot, lockfile) },
    mode,
  } satisfies Omit<RunDependencyProvenance, 'verdict'>

  if (configurationError) {
    return { ...base, verdict: 'incompatible', incompatibilityCause: 'configuration-invalid', remediation: redactDiagnosticText(configurationError) }
  }

  // Commands can replace dependencies and their inputs. Record the resulting
  // ownership/fingerprints, not a pre-command tree paired with a new verdict.
  const currentEvidence = () => {
    const realPath = dependencyRealPath(dependencyPath)
    const owner = realPath ? path.dirname(realPath) : null
    const localPath = owner ? path.join(owner, localRel) : null
    return {
      dependencyPath: fs.existsSync(dependencyPath) ? dependencyPath : null,
      dependencyRealPath: realPath,
      lockfile: nearestLockfile(handle.localPath, handle.worktreeRoot),
      dependencyLockfile: owner && localPath ? nearestLockfile(localPath, owner) : null,
      generatorInputs: (config.generatorInputs ?? []).map((item) => fingerprint(handle.localPath, item)),
      dependencyGeneratorInputs: localPath ? (config.generatorInputs ?? []).map((item) => fingerprint(localPath, item)) : [],
    }
  }

  if (mode === 'shared' && config.prepareCommand) {
    return {
      ...base,
      verdict: 'incompatible',
      incompatibilityCause: 'shared-prepare-command',
      remediation: 'A shared dependency tree is mutable. Move dependencyPreparation.prepareCommand to mode "isolated", or remove the command and validate the existing shared tree.',
    }
  }

  // A repair can switch a previously shared run to isolated mode. Its old
  // symlink must never let an isolated prepare command mutate another checkout.
  if (mode === 'isolated' && realDependencyPath && !realDependencyPath.startsWith(`${realWorktreeRoot}${path.sep}`)) {
    return {
      ...base, verdict: 'incompatible', incompatibilityCause: 'isolated-dependencies-required',
      remediation: 'Replace this worktree\'s external node_modules link with worktree-local dependencies before running isolated preparation. Do not modify the linked checkout.',
    }
  }

  // Each command gets its OWN log: they share a run directory, and a single
  // file meant the validation output truncated away the prepare output that
  // explained why validation had nothing coherent to check.
  const runStep = async (command: string, step: 'prepare' | 'validate') => {
    const stepLog = logPath.replace(/\.log$/, `-${step}.log`)
    const result = await runTargetCommand(command, handle.localPath, stepLog, {
      CANARY_DEPENDENCY_SOURCE_ROOT: handle.sourceRoot,
      CANARY_DEPENDENCY_WORKTREE_ROOT: handle.worktreeRoot,
      CANARY_DEPENDENCY_PATH: dependencyPath,
    })
    return {
      failed: result.failed || result.exitCode !== 0,
      validation: {
        command: redactDiagnosticText(command),
        cwd: handle.localPath,
        exitCode: result.exitCode,
        signal: result.signal,
        logPath: stepLog,
      },
    }
  }

  let preparationPassed = false
  let validation: RunDependencyProvenance['validation']
  if (mode === 'isolated' && config.prepareCommand) {
    const result = await runStep(config.prepareCommand, 'prepare')
    validation = result.validation
    if (result.failed) {
      return {
        ...base,
        ...currentEvidence(),
        verdict: 'incompatible',
        incompatibilityCause: 'prepare-failed',
        validation,
        remediation: 'Fix the target-owned prepare command or its inputs in this worktree, then request runner verification.',
      }
    }
    preparationPassed = true
  }

  if (config.validateCommand) {
    const result = await runStep(config.validateCommand, 'validate')
    validation = result.validation
    if (result.failed) {
      return {
        ...base,
        ...currentEvidence(),
        verdict: 'incompatible',
        incompatibilityCause: 'validation-failed',
        validation,
        remediation: 'Fix the dependency state rejected by the target-owned validator in this worktree, then request runner verification.',
      }
    }
  }

  Object.assign(base, currentEvidence())
  if (mode === 'isolated') {
    const isolatedRealPath = dependencyRealPath(dependencyPath)
    if (!isolatedRealPath || !(isolatedRealPath === realWorktreeRoot || isolatedRealPath.startsWith(`${realWorktreeRoot}${path.sep}`))) {
      return {
        ...base,
        dependencyPath: fs.existsSync(dependencyPath) ? dependencyPath : null,
        dependencyRealPath: isolatedRealPath,
        verdict: 'incompatible',
        incompatibilityCause: 'isolated-dependencies-required',
        ...(validation ? { validation } : {}),
        remediation: 'Isolated mode requires worktree-local dependencies. Add a target-owned prepareCommand that creates them without linking another checkout.',
      }
    }
    if (preparationPassed || config.validateCommand) {
      return { ...base, dependencyPath, dependencyRealPath: isolatedRealPath, verdict: 'compatible', validation: validation! }
    }
    return {
      ...base,
      dependencyPath,
      dependencyRealPath: isolatedRealPath,
      verdict: 'unknown',
      warning: 'Worktree-local dependencies exist, but no target-owned prepare or validation command proved generated-output coherence.',
      remediation: 'Add dependencyPreparation.prepareCommand or validateCommand for this repository.',
    }
  }

  const lockfileMismatch = mismatch(base.lockfile, base.dependencyLockfile)
  if (lockfileMismatch || generatorMismatch(base.generatorInputs, base.dependencyGeneratorInputs)) {
    return {
      ...base,
      verdict: 'incompatible',
      incompatibilityCause: lockfileMismatch ? 'lockfile-mismatch' : 'generator-input-mismatch',
      ...(validation ? { validation } : {}),
      remediation: 'The shared dependency checkout does not match this worktree. Prepare dependencies for this revision or use dependencyPreparation.mode "isolated".',
    }
  }

  return {
    ...base,
    verdict: 'unknown',
    ...(validation ? { validation } : {}),
    warning: linkError
      ? `Canary could not link the shared dependency tree: ${linkError}. The run may fail during boot.`
      : config.validateCommand
      ? 'Validation passed, but the shared dependency tree remains mutable while this run is active; Canary does not claim durable compatibility.'
      : 'Legacy shared dependencies have no target-owned compatibility proof. The run is allowed, but this state is unknown.',
    remediation: config.validateCommand
      ? 'Use dependencyPreparation.mode "isolated" when generated outputs must stay fixed for the run.'
      : 'Add generatorInputs plus validateCommand, or use isolated mode with a target-owned prepare command.',
  }
}
