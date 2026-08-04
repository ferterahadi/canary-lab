// Filters expected test noise written directly to process.stderr — lines that
// bypass vitest's console capture (and therefore vitest.config's onConsoleLog):
// subprocess diagnostics via process.stderr.write and Node's unhandled-rejection
// dumps from fire-and-forget fetches in HTTP-fallback tests.
//
// The act() warning flood is handled separately in vitest.config.ts
// (onConsoleLog), since React routes those through console.error.
//
// To see the raw logs again, run with VITEST_VERBOSE=1 — this filter no-ops.
const EXPECTED_STDERR_NOISE: { match: (s: string) => boolean; tag: string }[] = [
  {
    match: (s) => s.includes('[playwright-list]') && s.includes('boom'),
    tag: 'playwright-list fixture failure',
  },
  {
    match: (s) => s.includes('ECONNREFUSED') && s.includes(':3000'),
    tag: 'ECONNREFUSED :3000 (HTTP-fallback path under test)',
  },
]

// Machine-wide kill guard. Run/boot teardown signals process GROUPS via
// `process.kill(-pid)`, and orchestrator tests hand it fake ptys with small
// placeholder pids — negating one turns the group kill into a broadcast:
// kill(-1) SIGTERMs every process the user may signal (on 2026-08-04 it
// twice logged out the whole machine mid-suite), kill(0) is our own group,
// pid 1 is launchd. No test may signal any of those, so refuse every target
// below 2 for the entire worker. This complements the per-file
// `vi.spyOn(process, 'kill')` convention rather than replacing it: a spy is
// gone after `vi.restoreAllMocks()`, while the 2s SIGKILL-fallback timers the
// teardown schedules are unref'd and fire AFTER the test's mocks are restored
// — restoration lands back on this wrapper, which still blocks. New test
// files are covered without opting in.
const KILL_GUARD = Symbol.for('canary-lab.test.killGuard')
if (!(process.kill as unknown as Record<symbol, boolean>)[KILL_GUARD]) {
  const realKill = process.kill.bind(process)
  const guarded = ((pid: number, signal?: string | number) => {
    if (!(Number.isInteger(pid) && pid > 1)) {
      throw new Error(
        `vitest.setup.ts blocked process.kill(${pid}): a group/broadcast signal from a test can kill real processes`,
      )
    }
    return realKill(pid, signal)
  }) as typeof process.kill
  ;(guarded as unknown as Record<symbol, boolean>)[KILL_GUARD] = true
  process.kill = guarded
}

if (!process.env.VITEST_VERBOSE) {
  const announced = new Set<string>()
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    const text = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? ''
    const hit = EXPECTED_STDERR_NOISE.find((n) => n.match(text))
    if (hit) {
      if (!announced.has(hit.tag)) {
        announced.add(hit.tag)
        realWrite(`· suppressed expected noise: ${hit.tag} (VITEST_VERBOSE=1 to show)\n`)
      }
      // Swallow: invoke the write callback (if any) so callers don't hang.
      const cb = rest.find((a) => typeof a === 'function')
      if (cb) cb()
      return true
    }
    return (realWrite as any)(chunk, ...rest)
  }) as typeof process.stderr.write
}
