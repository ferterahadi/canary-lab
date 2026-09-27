import fs from 'fs'
import { REPOSITORY_RECONCILE_MS, repositoryConsumerKey, type RepositoryConsumer } from '../../../../shared/repository-observation'
import type { RepoPrerequisite } from '../../../../shared/launcher/types'
import { readWorkingTree, resolveRepoPath } from './git-repo'
import { describeRepoCheckout } from './git-upstream'
import { repositoryWatchPaths, type RepositoryWatchPath } from './repository-watch-paths'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from './workspace-events'

export interface RepositoryObserver {
  readWorkingTree(cwd: string, scope: 'repository' | 'directory', consumer: RepositoryConsumer): ReturnType<typeof readWorkingTree>
  readRepo(repo: RepoPrerequisite, consumer: RepositoryConsumer, opts: { fetch?: boolean }): ReturnType<typeof describeRepoCheckout>
  dispose(): void
}

interface ObserverDeps {
  events: WorkspaceEventPublisher
  log: (message: string, error: unknown) => void
  watchPath?: typeof fs.watch
  watchPaths?: typeof repositoryWatchPaths
  readTree?: typeof readWorkingTree
  readRepo?: typeof describeRepoCheckout
  maxWatches?: number
}
interface Observation {
  cwd: string
  scope: 'repository' | 'directory'
  generation: number
  consumers: Map<string, { value: RepositoryConsumer; expires: number }>
  releases: Array<() => void>
  dirty: boolean
  retryAt: number
  preparing?: Promise<void>
  lease?: ReturnType<typeof setTimeout>
  debounce?: ReturnType<typeof setTimeout>
  firstChange?: number
  pending: Map<string, { started: number; promise: Promise<unknown> }>
}

const LEASE_MS = 90_000
const DEBOUNCE_MS = 250
const MAX_DEBOUNCE_MS = 1000

/** Demand-driven filesystem hints and concurrent display reads. Mutation guards
 * deliberately use the uncached Git primitives instead of this observer. */
export function createRepositoryObserver(deps: ObserverDeps): RepositoryObserver {
  const watchPath = deps.watchPath ?? fs.watch
  const watchPaths = deps.watchPaths ?? repositoryWatchPaths
  const readTree = deps.readTree ?? readWorkingTree
  const readRepo = deps.readRepo ?? describeRepoCheckout
  const observations = new Map<string, Observation>()
  const watches = new Map<string, { watcher: fs.FSWatcher; listeners: Map<Observation, RepositoryWatchPath[]> }>()
  let disposed = false

  const releaseWatches = (entry: Observation) => {
    for (const release of entry.releases) release()
    entry.releases = []
  }
  const release = (key: string, entry: Observation) => {
    observations.delete(key)
    clearTimeout(entry.lease)
    clearTimeout(entry.debounce)
    releaseWatches(entry)
  }
  const publish = (entry: Observation) => {
    entry.debounce = undefined
    entry.firstChange = undefined
    const consumers = [...entry.consumers.values()].filter((c) => c.expires > Date.now()).map((c) => c.value)
    if (consumers.length) publishWorkspaceEvent(deps.events, { type: 'repos-changed', consumers })
  }
  const changed = (entry: Observation, structural: boolean) => {
    entry.generation++
    entry.dirty ||= structural
    entry.firstChange ??= Date.now()
    clearTimeout(entry.debounce)
    entry.debounce = setTimeout(() => publish(entry), Math.min(DEBOUNCE_MS, Math.max(0, MAX_DEBOUNCE_MS - (Date.now() - entry.firstChange!))))
    entry.debounce.unref()
  }
  const attach = (entry: Observation, spec: RepositoryWatchPath) => {
    const key = JSON.stringify([spec.path, spec.recursive])
    let shared = watches.get(key)
    if (!shared) {
      if (watches.size >= (deps.maxWatches ?? 256)) throw new Error('Repository watcher budget exhausted')
      const listeners = new Map<Observation, RepositoryWatchPath[]>()
      const watcher = watchPath(spec.path, { persistent: false, recursive: spec.recursive }, (event, filename) => {
        for (const [target, specs] of listeners) {
          if (specs.some((s) => s.accepts(filename))) changed(target, event === 'rename' || !filename || spec.path !== target.cwd || filename.endsWith('.gitignore'))
        }
      })
      shared = { watcher, listeners }
      watches.set(key, shared)
      watcher.on('error', (error) => {
        deps.log('Repository watch failed; reads will retry observation', error)
        watches.delete(key)
        watcher.close()
        for (const target of listeners.keys()) {
          target.retryAt = Date.now() + REPOSITORY_RECONCILE_MS
          changed(target, true)
        }
      })
    }
    const owner = shared
    owner.listeners.set(entry, [...(owner.listeners.get(entry) ?? []), spec])
    entry.releases.push(() => {
      owner.listeners.delete(entry)
      if (!owner.listeners.size && watches.get(key) === owner) {
        watches.delete(key)
        owner.watcher.close()
      }
    })
  }
  const renew = (key: string, entry: Observation) => {
    clearTimeout(entry.lease)
    const expires = Math.min(...[...entry.consumers.values()].map((c) => c.expires))
    entry.lease = setTimeout(() => {
      for (const [id, consumer] of entry.consumers) if (consumer.expires <= Date.now()) entry.consumers.delete(id)
      if (entry.consumers.size) renew(key, entry)
      else release(key, entry)
    }, expires - Date.now())
    entry.lease.unref()
  }
  const observe = async (cwd: string, scope: Observation['scope'], consumer: RepositoryConsumer) => {
    const key = JSON.stringify([cwd, scope])
    let entry = observations.get(key)
    if (!entry) {
      entry = { cwd, scope, generation: 0, consumers: new Map(), releases: [], dirty: true, retryAt: 0, pending: new Map() }
      if (!disposed) observations.set(key, entry)
    }
    const current = entry
    if (disposed) return current
    current.consumers.set(repositoryConsumerKey(consumer), { value: consumer, expires: Date.now() + LEASE_MS })
    renew(key, current)
    if (current.dirty && Date.now() >= current.retryAt && !current.preparing) {
      current.dirty = false
      current.preparing = watchPaths(cwd, scope).then((specs) => {
        if (disposed || observations.get(key) !== current) return
        releaseWatches(current)
        for (const spec of specs) attach(current, spec)
      }).catch((error: unknown) => {
        current.dirty = true
        current.retryAt = Date.now() + REPOSITORY_RECONCILE_MS
        deps.log('Unable to observe repository; periodic reads remain available', error)
      }).finally(() => { current.preparing = undefined })
    }
    await current.preparing
    return current
  }
  const join = <T>(entry: Observation, identity: string, read: () => Promise<T>): Promise<T> => {
    const key = JSON.stringify([identity, entry.generation])
    const previous = entry.pending.get(key)
    if (previous && Date.now() - previous.started < REPOSITORY_RECONCILE_MS) return previous.promise as Promise<T>
    // A hung inspection must not capture every subsequent recovery request.
    const promise = read().finally(() => {
      if (entry.pending.get(key)?.promise === promise) entry.pending.delete(key)
    })
    entry.pending.set(key, { started: Date.now(), promise })
    return promise
  }
  return {
    async readWorkingTree(cwd, scope, consumer) {
      const entry = await observe(cwd, scope, consumer)
      return join(entry, 'tree', () => readTree(cwd, scope))
    },
    async readRepo(repo, consumer, opts) {
      const entry = await observe(resolveRepoPath(repo.localPath), 'repository', consumer)
      // An explicit remote fetch is an operation, not a reusable display read.
      if (opts.fetch) return readRepo(repo, opts)
      return join(entry, JSON.stringify([repo.branch, repo.track]), () => readRepo(repo, opts))
    },
    dispose() {
      disposed = true
      for (const [key, entry] of observations) release(key, entry)
    },
  }
}
