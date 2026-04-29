import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage threshold scope is intentionally narrow: the new
      // business-logic modules introduced (or modified) in the orchestrator
      // refactor. The CLI shim (`runner.ts`), the AppleScript-free auto-heal
      // glue (`auto-heal.ts`), and the node-pty wrapper (`pty-spawner.ts`)
      // are excluded — they're thin I/O glue and can't be exercised
      // deterministically without a real TTY/native binding.
      include: [
        'shared/e2e-runner/orchestrator.ts',
        'shared/e2e-runner/log-enrichment.ts',
        'shared/e2e-runner/run-id.ts',
        'shared/e2e-runner/run-paths.ts',
        'shared/e2e-runner/manifest.ts',
        'shared/e2e-runner/retention.ts',
        'shared/launcher/foreground-pty.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'shared/**/types.ts',
        'shared/configs/**',
        'shared/runtime/**',
        'shared/e2e-runner/runner.ts',
        'shared/e2e-runner/auto-heal.ts',
        'shared/e2e-runner/pty-spawner.ts',
        'scripts/cli.ts',
        'apps/**',
        'dist/**',
        'templates/**',
      ],
      thresholds: {
        statements: 92,
        branches: 92,
        functions: 92,
        lines: 92,
      },
    },
  },
})
