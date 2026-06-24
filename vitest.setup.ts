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
