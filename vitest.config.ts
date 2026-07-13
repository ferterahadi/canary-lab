import { defineConfig } from 'vitest/config'

// Known, intentional test noise. Each entry collapses a class of expected
// log lines (asserted-around or deliberately provoked by tests) into a single
// short tag, printed once per worker instead of hundreds of full stack dumps.
// To see the raw logs again, run with VITEST_VERBOSE=1 (e.g.
// `VITEST_VERBOSE=1 npx vitest run`) — that disables this filter entirely.
const EXPECTED_LOG_NOISE: { match: (log: string) => boolean; tag: string }[] = [
  { match: (l) => l.includes('act(...)'), tag: 'React act() warning' },
  {
    match: (l) => l.includes('ECONNREFUSED') && l.includes(':3000'),
    tag: 'ECONNREFUSED :3000 (HTTP-fallback path under test)',
  },
  {
    match: (l) => l.includes('[playwright-list] exit 2: boom'),
    tag: 'playwright-list fixture failure',
  },
]
const announcedNoise = new Set<string>()

export default defineConfig({
  test: {
    bail: 1,
    onConsoleLog(log) {
      if (process.env.VITEST_VERBOSE) return undefined // full raw logs
      const hit = EXPECTED_LOG_NOISE.find((n) => n.match(log))
      if (!hit) return undefined // unknown log — always print
      if (!announcedNoise.has(hit.tag)) {
        announcedNoise.add(hit.tag)
        process.stdout.write(
          `· suppressed expected noise: ${hit.tag} (VITEST_VERBOSE=1 to show)\n`,
        )
      }
      return false // drop the raw line
    },
    projects: [
      {
        test: {
          name: 'node',
          // Filters expected stderr noise that bypasses onConsoleLog (direct
          // process.stderr.write + unhandled-rejection dumps). See file header.
          setupFiles: ['./vitest.setup.ts'],
          include: [
            'scripts/**/*.test.ts',
            'shared/**/*.test.ts',
            'tools/**/*.test.ts',
            'apps/web-server/**/*.test.{ts,tsx}',
            'apps/web/**/*.test.ts',
          ],
          exclude: [
            'apps/web/src/shared/lib/workspace-view-state.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dom',
          setupFiles: ['./vitest.setup.ts'],
          include: [
            'apps/web/**/*.test.tsx',
            'apps/web/src/shared/lib/workspace-view-state.test.ts',
          ],
          environment: 'happy-dom',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage threshold scope is intentionally narrow: server runtime
      // business logic + the web-server's own lib/routes layer + the
      // frontend's pure API/util modules. Thin I/O glue (`server.ts`,
      // `ws/`, the formatter scripts, the node-pty wrapper) and the CLI
      // shims are excluded below.
      include: [
        // Web-server business logic + route handlers (feature `logic/` and
        // `routes/`) plus the web-server-local shared infra.
        'apps/web-server/src/features/**/logic/**/*.ts',
        'apps/web-server/src/features/**/routes/**/*.ts',
        'apps/web-server/src/shared/**/*.ts',
        // Frontend pure modules. React components are excluded — only the
        // API client, pure utilities, and benchmark state are gated.
        'apps/web/src/shared/api/**/*.ts',
        'apps/web/src/shared/lib/**/*.ts',
        'apps/web/src/features/benchmark/state/**/*.ts',
        'apps/web/src/shared/shell/McpPromoContext.tsx',
        // 0.9.x → 0.10.x migration: pure detection + report rendering.
        'scripts/upgrade-migration.ts',
        'scripts/upgrade-known-prompts.ts',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Test-only fixtures (e.g. fake coverage agents injected via deps seams).
        '**/__fixtures__/**',
        'apps/web-server/server.ts',
        // WebSocket transport glue (thin I/O), incl. the shared workspace stream.
        'apps/web-server/src/features/**/ws/**',
        'apps/web-server/src/shared/ws/**',
        'apps/web/dist/**',
        'dist/**',
        'templates/**',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
