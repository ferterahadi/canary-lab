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
  ['canary-lab', 'init', 'smoke-project', '--package-spec', `file:${tarballPath}`],
  tempRoot,
)

const scaffoldPaths = [
  'package.json',
  'features/example_todo_api/feature.config.cjs',
  'features/broken_todo_api/feature.config.cjs',
]

const installedPackagePaths = [
  'node_modules/canary-lab/dist/apps/web-server/prompts/stage1-plan.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/stage2-spec.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/heal-agent.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/evaluation-rewrite.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/evaluation-rewrite.schema.json',
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
  'features/example_todo_api/src/config.ts',
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
