import Fastify from 'fastify'
import type { BenchmarkStore } from '../../logic/runtime/store'
import type { SabotageSkill } from '../../logic/runtime/skills'
import type { StartBenchmarkInput } from '../../logic/runtime/types'
import { benchmarkRoutes } from '../benchmarks'

export function fakeStore(over: Partial<BenchmarkStore> = {}): BenchmarkStore {
  return {
    list: () => [],
    get: () => null,
    save: () => {},
    renameFeature: () => 0,
    onEvent: () => {},
    offEvent: () => {},
    ...over,
  }
}

/** Registers the benchmark routes; every dep a test leaves out gets an inert default. */
export async function buildApp(deps: {
  store?: BenchmarkStore
  logsDir?: string
  featuresDir?: string
  projectRoot?: string
  startBenchmark?: (input: StartBenchmarkInput) => Promise<{ benchmarkId: string }>
  listSkills?: (feature: string) => SabotageSkill[]
  abortBenchmark?: (id: string) => void
  loadAgentSession?: (id: string) => { agent: string; sessionId: string; events: unknown[] } | null
}) {
  const app = Fastify()
  await app.register(benchmarkRoutes, {
    store: deps.store ?? fakeStore(),
    logsDir: deps.logsDir ?? '/logs',
    featuresDir: deps.featuresDir ?? '/features',
    projectRoot: deps.projectRoot,
    startBenchmark: deps.startBenchmark ?? (async () => ({ benchmarkId: 'b1' })),
    listSkills: deps.listSkills ?? (() => []),
    abortBenchmark: deps.abortBenchmark ?? (() => {}),
    loadAgentSession: deps.loadAgentSession ?? (() => null),
  })
  return app
}
