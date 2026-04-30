import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'scripts/**/*.test.ts',
      'shared/**/*.test.ts',
      'apps/**/*.test.ts',
    ],
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
        'shared/e2e-runner/heal-cycle.ts',
        'shared/e2e-runner/playwright-mcp-artifacts.ts',
        'shared/e2e-runner/runner-log.ts',
        'shared/launcher/foreground-pty.ts',
        // Web-server business logic. Bootstrap (server.ts), WebSocket
        // wiring (ws/), and CLI glue (scripts/ui-command.ts) are excluded
        // below — they're thin I/O wrappers around the modules covered here.
        'apps/web-server/lib/**/*.ts',
        'apps/web-server/routes/**/*.ts',
        // Frontend pure modules. React components are excluded — only the
        // API client, WebSocket wrapper, and pure utilities are gated.
        'apps/web/src/api/**/*.ts',
        'apps/web/src/lib/**/*.ts',
        // 0.9.x → 0.10.x migration: pure detection + report rendering.
        'scripts/upgrade-migration.ts',
        'scripts/upgrade-known-prompts.ts',
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
        'scripts/ui-command.ts',
        'apps/web-server/server.ts',
        'apps/web-server/ws/**',
        'apps/web-server/lib/wizard-agent-runner.ts',
        'apps/web-server/lib/open-browser-spawner.ts',
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
        statements: 92,
        branches: 92,
        functions: 92,
        lines: 92,
      },
    },
  },
})
