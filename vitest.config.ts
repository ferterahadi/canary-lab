import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Mirrors apps/web/vite.config.ts. `projects` entries are standalone configs, so a
// root-level `resolve` would not reach them — each project declares its own. Only
// apps/web uses these aliases; server/CLI code is emitted by tsc, which leaves
// specifiers untouched, so an alias there would ship unresolvable to dist/.
const webAliases = {
  '@': path.resolve(import.meta.dirname, 'apps/web/src'),
  '@shared': path.resolve(import.meta.dirname, 'shared'),
}

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
        resolve: { alias: webAliases },
        test: {
          name: 'node',
          // Filters expected stderr noise that bypasses onConsoleLog (direct
          // process.stderr.write + unhandled-rejection dumps). See file header.
          setupFiles: ['./vitest.setup.ts'],
          include: [
            'apps/cli/**/*.test.ts',
            'shared/**/*.test.ts',
            'tools/**/*.test.ts',
            'apps/web-server/**/*.test.{ts,tsx}',
            'apps/web/**/*.test.ts',
          ],
          exclude: [
            'apps/web/src/shared/lib/workspace-view-state.test.ts',
            // Needs real localStorage, not a stub — see the dom project below.
            'apps/web/src/features/flights/lib/group-open-state.test.ts',
            'apps/web/src/shared/state/demo-launcher.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        resolve: { alias: webAliases },
        test: {
          name: 'dom',
          setupFiles: ['./vitest.setup.ts'],
          include: [
            'apps/web/**/*.test.tsx',
            'apps/web/src/shared/lib/workspace-view-state.test.ts',
            'apps/web/src/features/flights/lib/group-open-state.test.ts',
            'apps/web/src/shared/state/demo-launcher.test.ts',
          ],
          environment: 'happy-dom',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage threshold scope: every module that decides something. The
      // server's runtime business logic, its route handlers and registrars, the
      // whole MCP layer (the external-agent API), the cross-cutting `shared/`
      // tree, and the frontend's non-component modules.
      //
      // What is deliberately OUT, and why — each of these is a decision, not a
      // backlog item:
      //   • `apps/web/**/components`, `shared/ui`, `shared/shell` — 155 files of
      //     markup. At 100% BRANCH coverage a component test stops asserting
      //     behaviour and starts asserting markup. See the note further down.
      //   • `server.ts` and the `ws/` transports — thin I/O glue whose behaviour
      //     is proven through the routes and stores they hand off to.
      //   • `apps/cli/**` shims, `tools/**` scripts, the node-pty wrapper.
      // `tools/check-conventions.mjs` holds a file-count floor so this scope
      // cannot shrink back without someone raising the floor on purpose.
      include: [
        // Web-server business logic + route handlers (feature `logic/` and
        // `routes/`) plus the web-server-local shared infra.
        'apps/web-server/src/features/**/logic/**/*.ts',
        'apps/web-server/src/features/**/routes/**/*.ts',
        'apps/web-server/src/shared/**/*.ts',
        // The MCP layer: the transport, the profile/tool tables, the shared
        // result helpers, and every tool group. This is the whole external-agent
        // surface — the tools ARE the product's API — and it was outside the gate
        // only because it landed as one 2740-line `tools.ts` that nothing could
        // unit-test. The tool-groups split fixed that, so it is gated now.
        'apps/web-server/src/mcp/**/*.ts',
        // Run-loop logic that happens to sit beside `index.ts` rather than under
        // `logic/`: the route-deps factory, the stream wiring, the scheduler
        // wrapper, the local-heal restart and the heal-agent choice. Same KIND of
        // code as the gated `logic/` tree — enumerated rather than globbed so a
        // future thin-glue file in this directory is a deliberate addition.
        'apps/web-server/src/features/runs/pick-heal-agent.ts',
        'apps/web-server/src/features/runs/restart-local-heal.ts',
        'apps/web-server/src/features/runs/run-scheduling.ts',
        'apps/web-server/src/features/runs/run-stream-wiring.ts',
        'apps/web-server/src/features/runs/runs-route-deps.ts',
        // Each feature's registrar — it wires that feature's routes and jobs onto
        // Fastify from the ServerContext, so a mistake here takes the whole
        // feature offline at boot. NOT re-export barrels.
        'apps/web-server/src/features/*/index.ts',
        // The DI context every registrar above reads.
        'apps/web-server/src/server-context.ts',
        // Cross-cutting root `shared/` tree: consumed by the CLI, the server and
        // the web app alike, and published as `canary-lab/feature-support/*`.
        //
        // Enumerated per subtree rather than written as `shared/**/*.ts`, because
        // these patterns are matched UNANCHORED against every file a test loads —
        // and `*.ts` also matches `.tsx`. A bare `shared/**/*.ts` therefore also
        // swallows `apps/web/src/shared/**`, dragging ~25 React components into
        // the gate. None of the names below collide with a component directory.
        'shared/cli-ui/**/*.ts',
        'shared/configs/**/*.ts',
        'shared/coverage/**/*.ts',
        'shared/e2e-runner/**/*.ts',
        'shared/flights/**/*.ts',
        'shared/launcher/**/*.ts',
        'shared/lib/**/*.ts',
        'shared/runtime/**/*.ts',
        'shared/code-display-format.ts',
        'shared/feature-scaffold.ts',
        'shared/portify-overlay.ts',
        'shared/run-mode.ts',
        'shared/run-state.ts',
        'shared/verification.ts',
        // Frontend non-component modules: the API client, the pure utilities,
        // and every `state/` tree — the stores, the context providers and the
        // hooks that own socket lifecycles, fetch orchestration and navigation.
        // A provider is state with a JSX wrapper, not markup, so it is gated
        // like the reducer beside it: its tests drive fake sockets and stubbed
        // API calls and assert observable behaviour, never rendered output.
        //
        // What stays out is `features/*/components`, `shared/ui` and
        // `shared/shell` — 155 files of actual markup. That exclusion is a
        // decision, not a backlog item: reaching 100% BRANCH coverage there
        // means a component test stops asserting behaviour and starts asserting
        // markup, which is the kind of test that breaks on every restyle and
        // catches nothing. The logic worth pinning gets extracted into the
        // gated modules instead; that is what `features/*/lib`,
        // `features/*/utils` and `features/*/state` are for. Revisit only if
        // component bugs start reaching users, and then by extracting more
        // logic rather than by lowering the threshold for one directory.
        'apps/web/src/shared/api/**/*.ts',
        'apps/web/src/shared/lib/**/*.ts',
        // Sits directly in `shared/`, not in `shared/lib/`, which is the only
        // reason it was never gated: it is the same kind of pure module, and the
        // stable test ids it derives are what make one badge mean the same test
        // in the Tests column, Playback and the Coverage Ledger.
        'apps/web/src/shared/test-numbering.ts',
        'apps/web/src/shared/state/**/*.ts',
        // Enumerated per feature rather than as `**/state/**`: these patterns
        // are matched UNANCHORED (see the note above), so the `apps/web/src/`
        // prefix is what keeps them off the server's own trees.
        'apps/web/src/features/benchmark/state/**/*.ts',
        'apps/web/src/features/evaluation/state/**/*.ts',
        'apps/web/src/features/flights/state/**/*.ts',
        'apps/web/src/features/portify/state/**/*.ts',
        'apps/web/src/features/runs/state/**/*.ts',
        'apps/web/src/features/wizard/state/**/*.ts',
        // The per-feature equivalents of the two lines above. These are the same
        // KIND of module — pure functions and socket/type wrappers, no JSX — and
        // they were outside the gate only because the shared versions were moved
        // first. Sixteen of the seventeen were already at 100% without being
        // asked to be; enumerated per directory rather than as
        // `features/*/{lib,utils,api}` because these patterns match UNANCHORED
        // (see the note above), and a bare `**/utils/**` would also swallow the
        // server's.
        'apps/web/src/features/flights/lib/**/*.ts',
        'apps/web/src/features/runs/utils/**/*.ts',
        'apps/web/src/features/benchmark/api/**/*.ts',
        'apps/web/src/features/evaluation/api/**/*.ts',
        'apps/web/src/features/runs/api/**/*.ts',
        'apps/web/src/shared/shell/McpPromoContext.tsx',
        // 0.9.x → 0.10.x migration: pure detection + report rendering.
        'apps/cli/upgrade-migration.ts',
        'apps/cli/upgrade-known-prompts.ts',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Test-only fixtures (e.g. fake coverage agents injected via deps seams).
        '**/__fixtures__/**',
        // No per-file exclusions. Every file the `include` patterns above reach
        // is measured at 100/100/100/100 — the run-loop runtime modules, the
        // config route groups, the env-switcher CLI, playwright-list and the
        // shared workspace WebSocket stream all carry real tests rather than a
        // line in this list. An exclusion here would keep the percentage at 100
        // while covering less, so prefer deleting an unreachable arm or making
        // the state unrepresentable in the type; `tools/check-conventions.mjs`
        // holds a file-count floor (MIN_GATED_FILES) so scope can't silently
        // shrink.
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
