import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'scripts/**/*.test.ts',
      'shared/**/*.test.ts',
      'apps/**/*.test.{ts,tsx}',
      'tools/**/*.test.ts',
    ],
    environment: 'node',
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
        // Web-server runtime — was `shared/e2e-runner/...` until the
        // 0.11 cleanup; now lives next to its only consumer.
        'apps/web-server/lib/**/*.ts',
        'apps/web-server/routes/**/*.ts',
        // Frontend pure modules. React components are excluded — only the
        // API client, WebSocket wrapper, and pure utilities are gated.
        'apps/web/src/api/**/*.ts',
        'apps/web/src/lib/**/*.ts',
        'apps/web/src/state/**/*.ts',
        // 0.9.x → 0.10.x migration: pure detection + report rendering.
        'scripts/upgrade-migration.ts',
        'scripts/upgrade-known-prompts.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'shared/**',
        'scripts/cli.ts',
        'scripts/ui-command.ts',
        'apps/web-server/server.ts',
        'apps/web-server/ws/**',
        // Integration-heavy orchestration + the heaviest route handlers are
        // covered by dedicated behavior tests, but under the strict 100% gate
        // their defensive glue has branches that can't be exercised
        // deterministically: subprocess spawn/error events, git operations,
        // SIGINT/readline handlers, and fs/disk race guards. (The lighter
        // routes/lib modules — features, tests-draft, config-ast, ast-extractor,
        // auto-heal — ARE gated; see them under include above.)
        'apps/web-server/lib/runtime/orchestrator.ts',
        'apps/web-server/lib/runtime/log-enrichment.ts',
        'apps/web-server/lib/runtime/env-switcher/switch.ts',
        'apps/web-server/routes/feature-config.ts',
        'apps/web-server/routes/runs.ts',
        'apps/web-server/lib/wizard-agent-runner.ts',
        'apps/web-server/lib/test-review-export.ts',
        'apps/web-server/lib/open-browser-spawner.ts',
        // Pure re-export shim — the underlying implementation lives in
        // shared/lib/dotenv-edit and is exercised through the routes that
        // import this module.
        'apps/web-server/lib/dotenv-edit.ts',
        // The benchmark runner is the I/O wiring behind the (separately tested)
        // BenchmarkOrchestrator/Race: it spawns the sabotage subprocess, creates
        // git worktrees, and drives real RunOrchestrators per arm. Same category
        // as runtime/orchestrator.ts above — exercised by behavior tests, not
        // unit-coverable without a real git repo + agent CLIs + TTY.
        'apps/web-server/lib/runtime/benchmark/runner.ts',
        'apps/web-server/lib/runtime/pty-spawner.ts',
        'apps/web-server/lib/runtime/**/types.ts',
        // Port-ification git/subprocess wiring — same category as
        // benchmark/runner.ts and runtime/orchestrator.ts above. runner.ts
        // drives git worktrees + the subprocess agent + the verifier; git-ops.ts
        // is raw git plumbing (worktree add/checkout/commit/diff/branch -D).
        // Exercised by behavior tests (portify/runner.test.ts, git-ops.test.ts)
        // but their defensive git-failure / `||`-fallback branches can't be
        // driven deterministically under the strict 100% gate.
        'apps/web-server/lib/runtime/portify/runner.ts',
        'apps/web-server/lib/runtime/portify/git-ops.ts',
        // Race-condition and defence-in-depth guards: the uncovered branches
        // here are intentional closed-check / path-traversal / subprocess-timer
        // guards that can't be exercised deterministically through public APIs.
        'apps/web-server/lib/agent-session-tailer.ts',
        'apps/web-server/lib/playwright-list.ts',
        // Path-traversal hardening: the `outside-draft` return + the
        // `endsWith(sep)` branch are intentional defence-in-depth that the
        // earlier `..`/absolute-path rejection already makes unreachable.
        // Keeping the redundant guard is the point; it can't be covered
        // without removing the security check, so the file stays excluded.
        'apps/web-server/lib/draft-file-resolver.ts',
        'apps/web/src/components/**',
        'apps/web/src/pages/**',
        'apps/web/src/main.tsx',
        'apps/web/src/App.tsx',
        'apps/web/vite.config.ts',
        'apps/web/dist/**',
        'apps/web/src/api/types.ts',
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
