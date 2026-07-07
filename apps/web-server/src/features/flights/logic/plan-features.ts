import crypto from 'crypto'
import path from 'path'
import {
  FileBackedTaskStore,
  type TaskIndexEntry,
} from '../../../../../../shared/lib/file-backed-task-store'
import {
  deriveFeatureSlug,
  type PlanFeaturesResult,
  type PlanFeaturesTask,
  type PlannedFeature,
} from '../../../../../../shared/flights/types'
import { renderPrompt } from '../../../shared/prompts'
import { defaultSpawnAgent, extractJson, type FlightAgentSpawner } from './stages/context'

// Pre-flight intent breakdown — the agent task behind the new-flight dialog's
// "Plan flight" step. One file-backed task per repo set (non-blocking ·
// persistent · recoverable · single-flight, the async-task contract): POST
// attaches to a running task for the same inputs instead of double-spawning;
// a server restart marks orphans failed; the dialog polls the record and
// tails the agent session via the workflow ref the spawner parks in the
// task's record dir.

export interface PlanFeaturesDeps {
  logsDir: string
  /** Injected in tests; defaults to the flight's claude spawner. */
  spawnAgent?: FlightAgentSpawner
  now?: () => string
}

function indexEntryOf(t: PlanFeaturesTask): TaskIndexEntry {
  return {
    id: t.taskId,
    createdAt: t.createdAt,
    repoPaths: t.repoPaths,
    status: t.status,
    updatedAt: t.updatedAt,
  }
}

export class PlanFeaturesStore {
  private readonly store: FileBackedTaskStore<PlanFeaturesTask>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<PlanFeaturesTask>({
      logsDir,
      dirName: 'flight-plans',
      recordFile: 'plan.json',
      idOf: (t) => t.taskId,
      indexEntryOf,
      sortNewestFirst: true,
      reconcile: {
        isInterrupted: (t) => t.status === 'running',
        mark: (t, now) => ({
          ...t,
          status: 'failed',
          error: 'Interrupted by server restart — plan again',
          updatedAt: now,
        }),
      },
    })
  }

  list(): TaskIndexEntry[] {
    return this.store.list()
  }

  get(taskId: string): PlanFeaturesTask | null {
    return this.store.get(taskId)
  }

  save(task: PlanFeaturesTask): void {
    this.store.save(task)
  }

  recordDir(taskId: string): string {
    return this.store.recordDir(taskId)
  }

  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }
}

function sameRepoSet(a: string[], b: string[]): boolean {
  const norm = (paths: string[]) => [...paths].map((p) => path.resolve(p)).sort().join('\n')
  return norm(a) === norm(b)
}

/** Normalize + sanity-check the agent's JSON. Throws on a shape the launch
 *  step couldn't act on — the task then fails with the parse story intact. */
export function normalizePlanResult(raw: PlanFeaturesResult): PlanFeaturesResult {
  if (!raw || !Array.isArray(raw.features) || raw.features.length === 0) {
    throw new Error('plan agent returned no features')
  }
  const features: PlannedFeature[] = raw.features.slice(0, 8).map((f) => {
    const name = deriveFeatureSlug(String(f?.name ?? ''))
    const description = String(f?.description ?? '').trim()
    if (!description) throw new Error(`planned feature "${name}" has no description`)
    return {
      name,
      description,
      ...(f.scope ? { scope: String(f.scope).trim() } : {}),
      ...(f.group ? { group: deriveFeatureSlug(String(f.group)) } : {}),
    }
  })
  const names = new Set(features.map((f) => f.name))
  if (names.size !== features.length) throw new Error('plan agent proposed duplicate feature names')
  const split = features.length > 1
  return { split, features }
}

/** Attach-or-start: a running task for the same repo set + intent is returned
 *  as-is (the dialog re-opening mid-plan attaches instead of double-spawning);
 *  otherwise a new task is created and the agent kicked off detached. */
export function startPlanFeatures(
  args: { repoPaths: string[]; description: string },
  store: PlanFeaturesStore,
  deps: PlanFeaturesDeps,
): PlanFeaturesTask {
  const now = deps.now ?? (() => new Date().toISOString())
  const running = store
    .list()
    .filter((e) => e.status === 'running')
    .map((e) => store.get(e.id))
    .find(
      (t): t is PlanFeaturesTask =>
        !!t && sameRepoSet(t.repoPaths, args.repoPaths) && t.description === args.description,
    )
  if (running) return running

  const task: PlanFeaturesTask = {
    taskId: `fp_${crypto.randomBytes(6).toString('hex')}`,
    repoPaths: args.repoPaths,
    description: args.description,
    status: 'running',
    createdAt: now(),
    updatedAt: now(),
  }
  store.save(task)
  void runPlanAgent(task, store, deps)
  return task
}

async function runPlanAgent(
  task: PlanFeaturesTask,
  store: PlanFeaturesStore,
  deps: PlanFeaturesDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString())
  const spawn = deps.spawnAgent ?? defaultSpawnAgent
  const settle = (patch: Partial<PlanFeaturesTask>) => {
    const cur = store.get(task.taskId)
    // Reconcile may have failed the task while the agent ran — don't resurrect.
    if (!cur || cur.status !== 'running') return
    store.save({ ...cur, ...patch, updatedAt: now() })
  }
  try {
    const prompt = renderPrompt('plan-features.md', {
      repoPaths: task.repoPaths.join('\n'),
      description: task.description,
    })
    const { text } = await spawn({
      prompt,
      cwd: task.repoPaths[0],
      stageDir: store.recordDir(task.taskId),
    })
    const result = normalizePlanResult(extractJson<PlanFeaturesResult>(text))
    settle({ status: 'done', result })
  } catch (err) {
    settle({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
  }
}
