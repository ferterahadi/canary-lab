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
        // Integration-heavy run orchestration + the heaviest route handlers are
        // covered by dedicated behavior tests, but under the strict 100% gate
        // their defensive glue has branches that can't be exercised
        // deterministically: subprocess spawn/error events, git operations,
        // SIGINT/readline handlers, and fs/disk race guards. (The lighter
        // routes/logic modules — features, tests-draft, config-ast, ast-extractor,
        // auto-heal — ARE gated.) Only the runs orchestrator is excluded; the
        // portify/benchmark orchestrators stay gated.
        'apps/web-server/src/features/runs/logic/runtime/orchestrator.ts',
        'apps/web-server/src/features/runs/logic/runtime/log-enrichment.ts',
        'apps/web-server/src/features/runs/logic/runtime/env-switcher/switch.ts',
        'apps/web-server/src/features/config/routes/feature-config.ts',
        'apps/web-server/src/features/runs/routes/runs.ts',
        'apps/web-server/src/features/wizard/logic/wizard-agent-runner.ts',
        'apps/web-server/src/features/evaluation/logic/test-review-export.ts',
        'apps/web-server/src/shared/open-browser-spawner.ts',
        // Pure re-export shim — the underlying implementation lives in
        // shared/lib/dotenv-edit and is exercised through the routes that
        // import this module.
        'apps/web-server/src/features/config/logic/dotenv-edit.ts',
        // The benchmark runner is the I/O wiring behind the (separately tested)
        // BenchmarkOrchestrator/Race: it spawns the sabotage subprocess, creates
        // git worktrees, and drives real RunOrchestrators per arm. Same category
        // as runtime/orchestrator.ts above — exercised by behavior tests, not
        // unit-coverable without a real git repo + agent CLIs + TTY.
        'apps/web-server/src/features/benchmark/logic/runtime/runner.ts',
        'apps/web-server/src/features/runs/logic/runtime/pty-spawner.ts',
        'apps/web-server/src/features/**/logic/runtime/**/types.ts',
        // Race-condition and defence-in-depth guards: the uncovered branches
        // here are intentional closed-check / path-traversal / subprocess-timer
        // guards that can't be exercised deterministically through public APIs.
        'apps/web-server/src/features/agent-sessions/logic/agent-session-tailer.ts',
        'apps/web-server/src/features/runs/logic/playwright-list.ts',
        // Path-traversal hardening: the `outside-draft` return + the
        // `endsWith(sep)` branch are intentional defence-in-depth that the
        // earlier `..`/absolute-path rejection already makes unreachable.
        // Keeping the redundant guard is the point; it can't be covered
        // without removing the security check, so the file stays excluded.
        'apps/web-server/src/features/wizard/logic/draft-file-resolver.ts',
        // Type-only module (no executable code) — v8 reports it as 0/0/0/0.
        'apps/web/src/shared/api/types.ts',
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
