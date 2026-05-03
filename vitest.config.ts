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
        'apps/web-server/lib/wizard-agent-runner.ts',
        'apps/web-server/lib/open-browser-spawner.ts',
        // Pure re-export shim — the underlying implementation lives in
        // shared/lib/dotenv-edit and is exercised through the routes that
        // import this module.
        'apps/web-server/lib/dotenv-edit.ts',
        // Thin I/O glue inside the runtime: subprocess scripts (formatters)
        // and the node-pty wrapper can't be exercised deterministically
        // without a real TTY / native binding.
        'apps/web-server/lib/runtime/claude-formatter.ts',
        'apps/web-server/lib/runtime/codex-formatter.ts',
        'apps/web-server/lib/runtime/auto-heal.ts',
        'apps/web-server/lib/runtime/pty-spawner.ts',
        'apps/web-server/lib/runtime/**/types.ts',
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
        statements: 95,
        branches: 92,
        functions: 95,
        lines: 95,
      },
    },
  },
})
