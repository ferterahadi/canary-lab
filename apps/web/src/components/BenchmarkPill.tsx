// Benchmark pill: entry point as well as a status. Only rendered when the
// internal benchmark surface is enabled (?showBenchmark=true — see
// GlobalStatusBar). A sky pulse + "Benchmark running" label signals an active
// race; otherwise the crossed-swords glyph invites starting one.
export function BenchmarkPill({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1"
      title={active ? 'A benchmark is running — click to view' : 'Run a benchmark — race two repair agents on a sabotaged codebase'}
    >
      {active ? (
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'rgb(56,189,248)' }} />
      ) : (
        <span>⚔</span>
      )}
      <span style={{ fontSize: 12, fontWeight: 500 }}>{active ? 'Benchmark running' : 'Benchmark'}</span>
    </button>
  )
}
