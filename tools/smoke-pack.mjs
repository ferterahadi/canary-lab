import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-lab-smoke-'))
const cacheDir = path.join(os.tmpdir(), 'canary-lab-npm-cache')

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
      // Keep the smoke run's workspace registry + active-server records inside
      // the throwaway temp dir so it never pollutes the real ~/.canary-lab
      // (stale `smoke-project` entries used to skew MCP bridge port resolution).
      // CANARY_LAB_HOME covers the registry/active-server reads; setup/upgrade
      // resolve the registry write through CANARY_LAB_AGENT_HOME, so pin both.
      CANARY_LAB_HOME: tempRoot,
      CANARY_LAB_AGENT_HOME: tempRoot,
      // CANARY_LAB_HOME only redirects our own registry/active-server records.
      // `claude mcp add` / `codex mcp add` (and Claude Desktop) write to the
      // real user client configs, which would leave a dangling temp `cli.js`
      // entry after this throwaway install is removed. Skip client registration
      // so the smoke run never touches the developer's live MCP clients.
      CANARY_LAB_SKIP_CLIENT_MCP: '1',
      ...extraEnv,
    },
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

// Both freshness checks must run BEFORE the build: `npm run build` regenerates
// AGENTS.md and .codex/skills, so a check placed after it can only ever pass.
// Run first, they assert what's committed already matches the source of truth.
run('node', ['tools/gen-agents-md.mjs', '--check'], repoRoot)
run('node', ['tools/gen-codex-skills.mjs', '--check'], repoRoot)

// Conventions + boundaries run here, not only in CI and the Claude edit hook,
// because CONTRIBUTING.md points everyone at `npm run smoke:pack` before a PR.
// The hook is Claude-only and CI needs a push; this is the one gate a human or a
// Codex session actually runs locally. Both are sub-second.
run('node', ['tools/check-conventions.mjs'], repoRoot)
run('node', ['tools/check-feature-boundaries.mjs'], repoRoot)
// ESLint covers only what needs a type checker or the React plugin (see
// eslint.config.mjs); 3.7s, so it belongs in the same local gate.
run('npx', ['eslint', '.'], repoRoot)

run('npm', ['run', 'build'], repoRoot)
run('npm', ['pack', '--pack-destination', tempRoot], repoRoot)

const tarballName = fs.readdirSync(tempRoot).find((entry) => entry.endsWith('.tgz'))
if (!tarballName) {
  throw new Error('No tarball produced by npm pack')
}

const tarballPath = path.join(tempRoot, tarballName)
const projectDir = path.join(tempRoot, 'smoke-project')

run('npm', ['init', '-y'], tempRoot)
run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false', `file:${tarballPath}`], tempRoot)
run(
  'npx',
  // --no-install: the smoke run installs deps itself below (and never needs the
  // Playwright chromium download); let `init` just scaffold.
  ['canary-lab', 'init', 'smoke-project', '--package-spec', `file:${tarballPath}`, '--no-install'],
  tempRoot,
)

// The demo storefront is deliberately a bare product repository. It has no
// pre-authored feature because the public demo must begin at Repo scan and let
// the tester conduct every Flight stage. A missing app contract or service here
// is a demo that silently did not ship.
const scaffoldPaths = [
  'package.json',
  'features/README.md',
  'demo-app/package.json',
  'demo-app/README.md',
  'demo-app/REQUIREMENTS.md',
  'demo-app/catalog-service/server.ts',
  'demo-app/inventory-service/server.ts',
  'demo-app/checkout-service/server.ts',
]

// One prompt per agent-spawning path that ships, plus a schema sidecar — the
// asset-copy step is only proven by the tarball. (The retired internal wizard's
// stage1/stage2 prompts used to stand in here; the flight pipeline's scout and
// specs-coverage cover the same ground now.)
const installedPackagePaths = [
  'node_modules/canary-lab/dist/apps/web-server/prompts/scout.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/specs-coverage.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/portify.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/prd-summary.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/heal-agent.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/evaluation-rewrite.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/evaluation-rewrite.schema.json',
  'node_modules/canary-lab/dist/apps/web-server/prompts/fix-commit-message.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/fix-commit-message.schema.json',
]

for (const relPath of scaffoldPaths) {
  const fullPath = path.join(projectDir, relPath)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Smoke test failed: missing ${relPath}`)
  }
}

for (const relPath of [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/skills/heal-loop.md',
  '.claude/skills/self-fixing-loop.md',
  '.claude/skills/env-import.md',
  '.claude/skills/canary-lab-feature.md',
  '.codex/heal-loop.md',
  '.codex/self-fixing-loop.md',
  '.codex/env-import.md',
  '.codex/canary-lab-feature.md',
  // The four toy samples retired in 1.6.0 when the demo storefront replaced
  // them — a scaffold still carrying one means a stale template shipped.
  'features/example_todo_api/feature.config.cjs',
  'features/broken_todo_api/feature.config.cjs',
  'features/flaky_orders_api/feature.config.cjs',
  'features/tricky_checkout_api/feature.config.cjs',
  // Earlier 1.6.0 drafts shipped partially onboarded demo suites. They bypassed
  // the beginning of a Flight, so the canonical scaffold must not retain them.
  'features/demo_catalog/feature.config.cjs',
  'features/demo_inventory/feature.config.cjs',
  'features/demo_storefront/feature.config.cjs',
]) {
  if (fs.existsSync(path.join(projectDir, relPath))) {
    throw new Error(`Smoke test failed: deprecated path still present: ${relPath}`)
  }
}

run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], projectDir)

for (const relPath of installedPackagePaths) {
  const fullPath = path.join(projectDir, relPath)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Smoke test failed: missing ${relPath}`)
  }
}

run('npx', ['canary-lab', 'new', 'feature', 'smoke_feature', '--description', 'Smoke test feature'], projectDir)
