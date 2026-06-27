import { spawn } from 'child_process'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../shared/lib/file-backed-task-store'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

// Background driver + single-flight gate for the self-update job: it runs
// `npm install <pkg>@latest` in the workspace root, which swaps the installed
// canary-lab package in place and fires the project's `postinstall`
// (`canary-lab upgrade --silent`) so MCP/agent registrations self-heal. The
// RUNNING server keeps the old code in memory until the user restarts
// `canary-lab ui` — hence the job's terminal state is "done, restart to apply",
// not "live".
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
      statusOf: (m) => m.status,
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

const defaultInstall: InstallRunner = ({ cwd, packageName, onOutput }) =>
  new Promise<number>((resolve) => {
    const child = spawn('npm', ['install', `${packageName}@latest`], {
      cwd,
      env: process.env,
    })
    child.stdout?.on('data', (d) => onOutput(d.toString()))
    child.stderr?.on('data', (d) => onOutput(d.toString()))
    child.on('error', (err) => {
      onOutput(`\n[spawn error] ${err instanceof Error ? err.message : String(err)}\n`)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })

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
      : { ...manifest, status: 'failed', endedAt: now(), error: `npm install exited with code ${code}` }
    store.save(manifest)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'version-changed' })
  })()

  return { manifest, completion }
}
