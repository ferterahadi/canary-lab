import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { atomicWrite } from '../../../../../../../shared/lib/atomic-write'
import type { RunContext } from './run-context'
import { resolveSetTargets } from './env-switcher/switch'
import { buildRunPaths } from './run-paths'

interface ActiveRuntimeInputInventory {
  version: 1
  state: 'active'
  runId: string
  env: string
  capturedAt: string
  entries: Array<{ relativeTarget: string; storedAs: string; sha256: string }>
}

interface CleanedRuntimeInputInventory {
  version: 1
  state: 'cleaned'
  runId: string
  env: string
  capturedAt: string
  cleanedAt: string
  entries: Array<{ relativeTarget: string }>
}

type RuntimeInputInventory = ActiveRuntimeInputInventory | CleanedRuntimeInputInventory

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function snapshotRelativeTarget(ctx: RunContext, targetPath: string): string | null {
  const relative = path.relative(ctx.feature.featureDir, targetPath)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null
  return relative.split(path.sep).join('/')
}

function readInventory(ctx: RunContext): RuntimeInputInventory | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ctx.paths.suiteRuntimeInputsInventoryPath, 'utf8')) as RuntimeInputInventory
    if (parsed.version !== 1 || parsed.runId !== ctx.runId || parsed.env !== ctx.env || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

function writeInventory(ctx: RunContext, inventory: RuntimeInputInventory): void {
  atomicWrite(ctx.paths.suiteRuntimeInputsInventoryPath, `${JSON.stringify(inventory, null, 2)}\n`)
  fs.chmodSync(ctx.paths.suiteRuntimeInputsInventoryPath, 0o600)
}

function assertSafeFile(root: string, file: string, label: string): void {
  const relative = path.relative(root, file)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes its owned directory: ${file}`)
  }
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) throw new Error(`${label} traverses a symlink: ${cursor}`)
  }
}

function reusableInventory(ctx: RunContext, inventory: RuntimeInputInventory | null): ActiveRuntimeInputInventory | null {
  if (inventory?.state !== 'active') return null
  for (const entry of inventory.entries) {
    const stored = path.join(ctx.paths.suiteRuntimeInputsDir, entry.storedAs)
    try {
      assertSafeFile(ctx.paths.suiteRuntimeInputsDir, stored, 'Stored suite runtime input')
      const stat = fs.lstatSync(stored)
      if (!stat.isFile() || digest(fs.readFileSync(stored)) !== entry.sha256) return null
    } catch {
      return null
    }
  }
  return inventory
}

/** Capture the selected, already-resolved env targets into run-owned storage.
 * A crashed process can reuse these exact bytes; it never has to treat the
 * mutable shared target as the run's source of truth. Omitted envset slots stay
 * omitted because resolveSetTargets intentionally returns only present slots. */
export function prepareSuiteRuntimeInputs(ctx: RunContext): ActiveRuntimeInputInventory | null {
  if (!ctx.env) return null
  const reusable = reusableInventory(ctx, readInventory(ctx))
  if (reusable) return reusable

  fs.rmSync(ctx.paths.suiteRuntimeInputsDir, { recursive: true, force: true })
  fs.mkdirSync(ctx.paths.suiteRuntimeInputsDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(ctx.paths.suiteRuntimeInputsDir, 0o700)
  const entries: ActiveRuntimeInputInventory['entries'] = []
  try {
    for (const { slot, targetPath } of resolveSetTargets(ctx.feature.featureDir, ctx.env)) {
      const relativeTarget = snapshotRelativeTarget(ctx, targetPath)
      if (!relativeTarget) continue
      assertSafeFile(ctx.feature.featureDir, targetPath, `Selected envset target ${slot}`)
      const source = fs.lstatSync(targetPath, { throwIfNoEntry: false })
      if (!source) throw new Error(`Selected envset target ${slot} vanished before run setup: ${targetPath}`)
      // assertSafeFile above already rejects every symlink in the target path.
      if (!source.isFile()) {
        throw new Error(`Selected envset target ${slot} must be a regular file: ${targetPath}`)
      }
      const bytes = fs.readFileSync(targetPath)
      const storedAs = `${String(entries.length).padStart(3, '0')}.input`
      const stored = path.join(ctx.paths.suiteRuntimeInputsDir, storedAs)
      fs.writeFileSync(stored, bytes, { mode: 0o600 })
      fs.chmodSync(stored, 0o600)
      entries.push({ relativeTarget, storedAs, sha256: digest(bytes) })
    }
    const inventory: ActiveRuntimeInputInventory = {
      version: 1,
      state: 'active',
      runId: ctx.runId,
      env: ctx.env,
      capturedAt: new Date().toISOString(),
      entries,
    }
    writeInventory(ctx, inventory)
    return inventory
  } catch (error) {
    fs.rmSync(ctx.paths.suiteRuntimeInputsDir, { recursive: true, force: true })
    throw error
  }
}

export function suiteRuntimeInputTargets(ctx: RunContext): string[] {
  const inventory = readInventory(ctx)
  return inventory?.entries.map((entry) => entry.relativeTarget) ?? []
}

/** Review readers have only the retained suite path. Its parent is the run
 * directory, so they can recover the secret-free target inventory without a
 * live orchestrator or mutable envset config. */
export function suiteRuntimeInputTargetsForSnapshot(snapshotDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(snapshotDir), 'suite-runtime-inputs.json'), 'utf8')) as Partial<RuntimeInputInventory>
    if (raw.version !== 1 || !Array.isArray(raw.entries)) return []
    return raw.entries.flatMap((entry) => typeof entry.relativeTarget === 'string' ? [entry.relativeTarget] : [])
  } catch {
    return []
  }
}

/** Materialize envset targets that the retained suite snapshot intentionally
 * omits. They exist only while the run is active, so Playwright configs that
 * resolve `.env` from `__dirname` see the selected env without turning the
 * secret into retained review or verdict evidence. */
export function materializeSuiteRuntimeInputs(ctx: RunContext): string[] {
  if (!ctx.env || ctx.suiteDir === ctx.feature.featureDir) return []
  const inventory = reusableInventory(ctx, readInventory(ctx))
  if (!inventory) throw new Error('Selected suite runtime inputs are unavailable; restart setup before running tests.')
  const copied: string[] = []
  for (const entry of inventory.entries) {
    const destination = path.join(ctx.suiteDir, entry.relativeTarget)
    assertSafeFile(ctx.suiteDir, destination, 'Suite runtime input target')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    assertSafeFile(ctx.suiteDir, destination, 'Suite runtime input target')
    fs.copyFileSync(path.join(ctx.paths.suiteRuntimeInputsDir, entry.storedAs), destination)
    fs.chmodSync(destination, 0o600)
    copied.push(entry.relativeTarget)
  }
  return copied
}

export function removeSuiteRuntimeInputs(ctx: RunContext): void {
  cleanupSuiteRuntimeInputsForRun(ctx.runDir)
}

/** Crash-recovery cleanup for a run that no longer has an orchestrator. The
 * path-only inventory is deliberately sufficient to remove executable copies
 * and scrub the run-owned byte store without reading mutable envset config. */
export function cleanupSuiteRuntimeInputsForRun(runDir: string): void {
  const paths = buildRunPaths(runDir)
  let inventory: RuntimeInputInventory
  try {
    inventory = JSON.parse(fs.readFileSync(paths.suiteRuntimeInputsInventoryPath, 'utf8')) as RuntimeInputInventory
  } catch {
    fs.rmSync(paths.suiteRuntimeInputsDir, { recursive: true, force: true })
    return
  }
  if (inventory.version !== 1 || !Array.isArray(inventory.entries)) {
    throw new Error(`Invalid suite runtime input cleanup inventory: ${paths.suiteRuntimeInputsInventoryPath}`)
  }
  for (const entry of inventory.entries) {
    if (typeof entry.relativeTarget !== 'string') throw new Error('Invalid suite runtime input cleanup target')
    const target = path.join(paths.suiteSnapshotDir, entry.relativeTarget)
    assertSafeFile(paths.suiteSnapshotDir, target, 'Suite runtime input cleanup target')
    fs.rmSync(target, { force: true })
  }
  fs.rmSync(paths.suiteRuntimeInputsDir, { recursive: true, force: true })
  if (inventory.state === 'cleaned') return
  const cleaned: CleanedRuntimeInputInventory = {
    version: 1,
    state: 'cleaned',
    runId: inventory.runId,
    env: inventory.env,
    capturedAt: inventory.capturedAt,
    cleanedAt: new Date().toISOString(),
    entries: inventory.entries.map(({ relativeTarget }) => ({ relativeTarget })),
  }
  atomicWrite(paths.suiteRuntimeInputsInventoryPath, `${JSON.stringify(cleaned, null, 2)}\n`)
  fs.chmodSync(paths.suiteRuntimeInputsInventoryPath, 0o600)
}
