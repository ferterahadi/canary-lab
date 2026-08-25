import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../shared/lib/file-backed-task-store'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

// Background driver + single-flight gate for the self-update job: it runs
// `npm install <pkg>@latest` in the workspace root, then invokes the newly
// installed CLI's `upgrade --silent` itself. An explicit `npm install <pkg>`
// does not reliably run the root workspace's postinstall, so treating install
// success as migration success leaves skills, MCP paths, browser binaries, and
// the version stamp stale. The RUNNING server keeps the old code in memory
// until the user restarts `canary-lab ui` — hence the terminal state remains
// "done, restart to apply", not "live".
//
// Singleton: there is at most one update job ever (fixed id), so a fresh attempt
// overwrites the previous record. Single-flight refuses a second concurrent run.

export const UPDATE_JOB_ID = 'current'

export type UpdateJobStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface UpdateJobManifest {
  jobId: string
  status: UpdateJobStatus
  /** The version we're installing toward (the registry `latest` at start). */
  targetVersion: string
  startedAt: string
  endedAt?: string
  log: string
  error?: string
}

export interface UpdateJobStoreEvent {
  kind: 'changed' | 'removed'
}

export class UpdateJobStore {
  private readonly listeners = new Set<(event: UpdateJobStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<UpdateJobManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<UpdateJobManifest>({
      logsDir,
      dirName: 'version-update',
      recordFile: 'job.json',
      idOf: (m) => m.jobId,
      indexEntryOf: (m) => ({ id: m.jobId, createdAt: m.startedAt, status: m.status }),
      reconcile: {
        isInterrupted: (m) => m.status === 'running',
        mark: (m, now) => ({
          ...m,
          status: 'aborted',
          endedAt: m.endedAt ?? now,
          error: m.error ?? 'Interrupted by server restart',
        }),
      },
    })
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind }))
  }

  current(): UpdateJobManifest | null {
    return this.store.get(UPDATE_JOB_ID)
  }

  save(manifest: UpdateJobManifest): void {
    this.store.save(manifest)
  }

  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }

  onEvent(fn: (event: UpdateJobStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: UpdateJobStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: UpdateJobStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}

export class UpdateJobConflictError extends Error {
  readonly statusCode = 409
  constructor() {
    super('an update is already in progress')
    this.name = 'UpdateJobConflictError'
  }
}

/** Injectable runner — resolves to the child process exit code. */
export type InstallRunner = (args: {
  cwd: string
  packageName: string
  onOutput: (chunk: string) => void
}) => Promise<number>

function runLoggedCommand(
  command: string,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
    })
    let settled = false
    const settle = (code: number) => {
      if (settled) return
      settled = true
      resolve(code)
    }
    child.stdout?.on('data', (d) => onOutput(d.toString()))
    child.stderr?.on('data', (d) => onOutput(d.toString()))
    child.on('error', (err) => {
      onOutput(`\n[spawn error] ${err instanceof Error ? err.message : String(err)}\n`)
      settle(1)
    })
    child.on('close', (code) => settle(code ?? 1))
  })
}

function installedCliPath(cwd: string, packageName: string): string | null {
  try {
    const packageRoot = path.join(cwd, 'node_modules', packageName)
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'))
    const bin = typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin?.['canary-lab'] ?? Object.values(pkg.bin ?? {}).find((value) => typeof value === 'string')
    return typeof bin === 'string' ? path.resolve(packageRoot, bin) : null
  } catch {
    return null
  }
}

const defaultInstall: InstallRunner = async ({ cwd, packageName, onOutput }) => {
  onOutput(`[install] npm install ${packageName}@latest\n`)
  const installCode = await runLoggedCommand(
    'npm',
    ['install', `${packageName}@latest`],
    cwd,
    onOutput,
  )
  if (installCode !== 0) return installCode

  const cliPath = installedCliPath(cwd, packageName)
  if (!cliPath) {
    onOutput(`\n[upgrade error] could not find the installed ${packageName} CLI\n`)
    return 1
  }

  onOutput('\n[upgrade] refreshing the workspace, browsers, and agent integrations\n')
  return runLoggedCommand(
    process.execPath,
    [cliPath, 'upgrade', '--silent'],
    cwd,
    onOutput,
  )
}

export interface StartUpdateJobArgs {
  projectRoot: string
  packageName: string
  targetVersion: string
}

export interface UpdateJobRunnerDeps {
  store: UpdateJobStore
  now?: () => string
  run?: InstallRunner
  workspaceEvents?: WorkspaceEventPublisher
}

export interface StartUpdateJobResult {
  manifest: UpdateJobManifest
  /** Resolves when the install settles (used by tests; ignored by REST). */
  completion: Promise<void>
}

export function startUpdateJob(args: StartUpdateJobArgs, deps: UpdateJobRunnerDeps): StartUpdateJobResult {
  const now = deps.now ?? (() => new Date().toISOString())
  const run = deps.run ?? defaultInstall
  const { store } = deps

  // Single-flight: refuse a second concurrent install (the on-disk record is the
  // lock — a second tab / an agent / a restart all see it).
  if (store.current()?.status === 'running') throw new UpdateJobConflictError()

  let manifest: UpdateJobManifest = {
    jobId: UPDATE_JOB_ID,
    status: 'running',
    targetVersion: args.targetVersion,
    startedAt: now(),
    log: '',
  }
  store.save(manifest)

  const append = (chunk: string) => {
    manifest = { ...manifest, log: manifest.log + chunk }
    store.save(manifest)
  }

  const completion = (async () => {
    let code: number
    try {
      code = await run({ cwd: args.projectRoot, packageName: args.packageName, onOutput: append })
    } catch (err) {
      code = 1
      append(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`)
    }
    manifest = code === 0
      ? { ...manifest, status: 'done', endedAt: now() }
      : { ...manifest, status: 'failed', endedAt: now(), error: `update exited with code ${code}` }
    // No publish here: the settle IS the event (store-event-bridge, wired in
    // routes/version.ts).
    store.save(manifest)
  })()

  return { manifest, completion }
}
