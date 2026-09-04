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
      // The scaffold's postinstall now downloads the Playwright browser, which
      // lands in the developer's shared browser cache — outside the throwaway
      // workspace, like the MCP registrations above. `canary-lab
      // install-browsers` honours this even though `playwright install` does not.
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
      ...extraEnv,
    },
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function childDirectories(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function snapshotFiles(root) {
  const snapshot = new Map()
  const visit = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(prefix, entry.name)
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full, rel)
      else if (entry.isFile()) snapshot.set(rel, fs.readFileSync(full))
    }
  }
  visit(root)
  return snapshot
}

function assertSnapshotUnchanged(root, before, label) {
  const after = snapshotFiles(root)
  if (after.size !== before.size) {
    throw new Error(`Smoke test failed: ${label} file count changed during upgrade`)
  }
  for (const [rel, bytes] of before) {
    if (!after.get(rel)?.equals(bytes)) {
      throw new Error(`Smoke test failed: ${label} changed during upgrade: ${rel}`)
    }
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

// Upgrade proof starts from the last supported npm release, not a hand-shaped
// fixture. A patch release must migrate a real 2.2.0 workspace without rewriting
// its suites or user-owned files, then leave the documented upgrade retryable.
const upgradeFromVersion = '2.2.0'
const releaseVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
const upgradeHarnessDir = path.join(tempRoot, 'upgrade-harness')
const upgradeProjectDir = path.join(upgradeHarnessDir, 'upgrade-project')
const upgradeHomeDir = path.join(tempRoot, 'upgrade-home')
const upgradeEnv = {
  CANARY_LAB_HOME: upgradeHomeDir,
  CANARY_LAB_AGENT_HOME: upgradeHomeDir,
}
fs.mkdirSync(upgradeHarnessDir, { recursive: true })
run('npm', ['init', '-y'], upgradeHarnessDir, upgradeEnv)
run(
  'npm',
  ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false', `canary-lab@${upgradeFromVersion}`],
  upgradeHarnessDir,
  upgradeEnv,
)
run(
  'npx',
  ['canary-lab', 'init', 'upgrade-project', '--package-spec', upgradeFromVersion, '--no-install'],
  upgradeHarnessDir,
  upgradeEnv,
)
run(
  'npm',
  ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'],
  upgradeProjectDir,
  upgradeEnv,
)

const baselineFeatureNames = [
  'storefront-journey',
  'workflow-workbench',
]
if (JSON.stringify(childDirectories(path.join(upgradeProjectDir, 'features'))) !== JSON.stringify(baselineFeatureNames)) {
  throw new Error(`Smoke test failed: npm ${upgradeFromVersion} no longer scaffolds the expected feature boundary`)
}

const userNote = 'keep this user-owned note through the patch upgrade\n'
const userFeatureNotePath = path.join(upgradeProjectDir, 'features', 'storefront-journey', 'USER-NOTES.md')
const userClaudePath = path.join(upgradeProjectDir, 'CLAUDE.md')
const userAgentsPath = path.join(upgradeProjectDir, 'AGENTS.md')
const userSkillPath = path.join(upgradeHomeDir, '.codex', 'skills', 'user-owned', 'SKILL.md')
fs.writeFileSync(userFeatureNotePath, userNote)
fs.writeFileSync(userClaudePath, `# Team notes\n\n${userNote}`)
fs.writeFileSync(userAgentsPath, `# Agent notes\n\n${userNote}`)
fs.mkdirSync(path.dirname(userSkillPath), { recursive: true })
fs.writeFileSync(userSkillPath, userNote)
fs.appendFileSync(path.join(upgradeProjectDir, '.gitignore'), '\n# User rule\nuser-private/\n')

const upgradePackagePath = path.join(upgradeProjectDir, 'package.json')
const upgradePackage = JSON.parse(fs.readFileSync(upgradePackagePath, 'utf8'))
const baselineStamp = fs.readFileSync(path.join(upgradeProjectDir, 'logs', '.canary-lab-version'), 'utf8').trim()
if (baselineStamp !== upgradeFromVersion) {
  throw new Error(`Smoke test failed: installed workspace stamp is ${baselineStamp || 'missing'}, expected ${upgradeFromVersion}`)
}
upgradePackage.scripts['user:keep'] = 'echo keep-me'
upgradePackage.userOwned = { keep: true }
fs.writeFileSync(upgradePackagePath, `${JSON.stringify(upgradePackage, null, 2)}\n`)
const featureSnapshot = snapshotFiles(path.join(upgradeProjectDir, 'features'))

for (const client of ['codex', 'claude']) {
  const packaged = childDirectories(
    path.join(upgradeProjectDir, 'node_modules', 'canary-lab', 'dist', 'agent-integrations', client, 'skills'),
  )
  const installed = childDirectories(path.join(upgradeHomeDir, `.${client}`, 'skills'))
    .filter((name) => name.startsWith('canary-lab'))
  if (JSON.stringify(installed) !== JSON.stringify(packaged)) {
    throw new Error(`Smoke test failed: ${upgradeFromVersion} ${client} skills do not match its package`)
  }
}

// An explicit `npm install <pkg>` does not reliably run the root workspace's
// postinstall. The UI updater can therefore swap the package without migrating
// the workspace. Exercise the first-start recovery from the packed release,
// then run the documented command once more to prove the migration is retryable.
run(
  'npm',
  ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false', `file:${tarballPath}`],
  upgradeProjectDir,
  upgradeEnv,
)
const recoveryModulePath = path.join(
  upgradeProjectDir,
  'node_modules',
  'canary-lab',
  'dist',
  'apps',
  'cli',
  'ui-command.js',
)
run(
  process.execPath,
  [
    '-e',
    `const { finishPendingWorkspaceUpgrade } = require(${JSON.stringify(recoveryModulePath)});` +
      `finishPendingWorkspaceUpgrade(${JSON.stringify(upgradeProjectDir)}, { log: console.log })` +
      `.then((ran) => { if (!ran) throw new Error('expected first-start upgrade recovery to run') })` +
      `.catch((error) => { console.error(error); process.exit(1) })`,
  ],
  upgradeProjectDir,
  upgradeEnv,
)
run('npx', ['canary-lab', 'upgrade', '--silent'], upgradeProjectDir, upgradeEnv)

const upgradedPackage = JSON.parse(fs.readFileSync(upgradePackagePath, 'utf8'))
const installedRelease = JSON.parse(
  fs.readFileSync(path.join(upgradeProjectDir, 'node_modules', 'canary-lab', 'package.json'), 'utf8'),
)
if (installedRelease.version !== releaseVersion) {
  throw new Error(`Smoke test failed: expected upgraded package ${releaseVersion}, got ${installedRelease.version}`)
}
if (upgradedPackage.scripts.postinstall !== 'canary-lab upgrade --silent && canary-lab install-browsers') {
  throw new Error('Smoke test failed: the upgraded postinstall no longer includes browser installation')
}
if (upgradedPackage.scripts['user:keep'] !== 'echo keep-me' || upgradedPackage.userOwned?.keep !== true) {
  throw new Error('Smoke test failed: upgrade changed user-owned package.json fields')
}
assertSnapshotUnchanged(path.join(upgradeProjectDir, 'features'), featureSnapshot, `${upgradeFromVersion} feature tree`)
for (const [file, expected] of [
  [userClaudePath, `# Team notes\n\n${userNote}`],
  [userAgentsPath, `# Agent notes\n\n${userNote}`],
  [userSkillPath, userNote],
]) {
  if (fs.readFileSync(file, 'utf8') !== expected) {
    throw new Error(`Smoke test failed: upgrade changed user-owned file ${file}`)
  }
}
const upgradedGitignore = fs.readFileSync(path.join(upgradeProjectDir, '.gitignore'), 'utf8')
if (!upgradedGitignore.includes('user-private/') || !upgradedGitignore.includes('features/*/envsets/*/*')) {
  throw new Error('Smoke test failed: upgrade lost user .gitignore rules or envset secret protection')
}
const stamp = fs.readFileSync(path.join(upgradeProjectDir, 'logs', '.canary-lab-version'), 'utf8').trim()
if (stamp !== releaseVersion) {
  throw new Error(`Smoke test failed: upgraded workspace stamp is ${stamp || 'missing'}, expected ${releaseVersion}`)
}

for (const client of ['codex', 'claude']) {
  const packaged = childDirectories(
    path.join(upgradeProjectDir, 'node_modules', 'canary-lab', 'dist', 'agent-integrations', client, 'skills'),
  )
  const installed = childDirectories(path.join(upgradeHomeDir, `.${client}`, 'skills'))
    .filter((name) => name.startsWith('canary-lab'))
  if (JSON.stringify(installed) !== JSON.stringify(packaged)) {
    throw new Error(`Smoke test failed: ${client} skills did not refresh from ${upgradeFromVersion} to ${releaseVersion}`)
  }
}

for (const feature of baselineFeatureNames) {
  run(
    'npx',
    ['playwright', 'test', '--list', '--config', `features/${feature}/playwright.config.ts`],
    upgradeProjectDir,
    upgradeEnv,
  )
}

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

// The scaffold ships its own demonstration (R89): the storefront product repo
// AND the suite that exercises it, so a first-time user can press Run and watch
// fail -> repair -> green without authoring anything. `npm run demo` adds
// nothing on top — it runs this same `init` — so anything missing from this
// list is missing from the product tour too.
const scaffoldPaths = [
  'package.json',
  'features/README.md',
  'demo-app/package.json',
  'demo-app/README.md',
  'demo-app/REQUIREMENTS.md',
  'demo-app/catalog-service/server.ts',
  'demo-app/inventory-service/server.ts',
  'demo-app/checkout-service/server.ts',
  'features/storefront-journey/feature.config.cjs',
  'features/storefront-journey/playwright.config.ts',
  'features/storefront-journey/e2e/storefront.spec.ts',
  'features/storefront-journey/e2e/helpers/api.ts',
  // Requirements + coverage ship with the suite: the collected source doc and
  // the generated summary its `@req-*` tags map onto. Without these two the
  // Requirements and Test-authoring stages read as never started on a fresh
  // scaffold, and the coverage ledger has nothing to score against.
  // The envset the suite declares in `envs: ['local']`. npm strips `.gitignore`
  // from a tarball but not `.env`, so this is the one place that proves it.
  'features/storefront-journey/envsets/envsets.config.json',
  'features/storefront-journey/envsets/local/storefront-journey.env',
  // The recorded boot the scaffold ships so Suite setup reports figures before
  // the user runs anything. Under a `logs/` path, so it needs both the repo's
  // .gitignore exception and this assertion to prove it survives the tarball.
  'logs/runs/index.json',
  'logs/runs/2026-08-07T0900-s7bk/manifest.json',
  'logs/runs/2026-08-07T0900-s7bk/lifecycle-events.jsonl',
  // The saved port-ification behind Parallel readiness — its double-boot proof
  // and its diff. Seeded the same way, and its paths are rewritten to this
  // workspace by init, which the assertion below checks.
  'logs/portify/index.json',
  'logs/portify/portify-2026-08-07T0910-q2mx/portify.json',
  'features/storefront-journey/docs/storefront-journey-prd.md',
  'features/storefront-journey/docs/_prd-summary.json',
  'features/storefront-journey/docs/_prd-summary.md',
  // The focused workbench gives Author/Coverage/Verify/Portify real, prepared
  // material without disturbing the repair demo's ten-defect contract chain.
  'workflow-app/package.json',
  'workflow-app/README.md',
  'workflow-app/REQUIREMENTS.md',
  'workflow-app/server.ts',
  'features/workflow-workbench/feature.config.cjs',
  'features/workflow-workbench/playwright.config.ts',
  'features/workflow-workbench/verification.configs.json',
  'features/workflow-workbench/e2e/workflow.spec.ts',
  'features/workflow-workbench/envsets/envsets.config.json',
  'features/workflow-workbench/envsets/local/workflow-workbench.env',
  'features/workflow-workbench/envsets/production/workflow-workbench.env',
  'features/workflow-workbench/docs/workflow-workbench-prd.md',
  'features/workflow-workbench/docs/_prd-summary.json',
  'features/workflow-workbench/docs/_prd-summary.md',
  // The Flight demo's target: un-onboarded on purpose, so a Flight has a repo
  // to conduct from Repo scan through Evaluation. No suite ships for it.
  'flight-app/package.json',
  'flight-app/README.md',
  'flight-app/REQUIREMENTS.md',
  'flight-app/lending-service/server.ts',
]

// One prompt per agent-spawning path that ships, plus a schema sidecar — the
// asset-copy step is only proven by the tarball. (The retired internal wizard's
// stage1/stage2 prompts used to stand in here; the flight pipeline's scout and
// specs-coverage cover the same ground now.)
const installedPackagePaths = [
  // The public feature-support exports keep their declarations and the two
  // declarations those surfaces reference. Internal declarations are omitted
  // below because consumers cannot import those paths through package exports.
  'node_modules/canary-lab/dist/shared/configs/loadEnv.d.ts',
  'node_modules/canary-lab/dist/shared/configs/playwright.base.d.ts',
  'node_modules/canary-lab/dist/shared/e2e-runner/log-marker-fixture.d.ts',
  'node_modules/canary-lab/dist/shared/e2e-runner/repo-path-overrides.d.ts',
  'node_modules/canary-lab/dist/shared/launcher/types.d.ts',
  'node_modules/canary-lab/dist/shared/readable-tests/types.d.ts',
  'node_modules/canary-lab/dist/apps/web-server/prompts/scout.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/specs-coverage.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/portify.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/prd-summary.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/heal-agent.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/evaluation-rewrite.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/evaluation-rewrite.schema.json',
  'node_modules/canary-lab/dist/apps/web-server/prompts/fix-commit-message.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/fix-commit-message.schema.json',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-repair-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-verify-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-author-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-coverage-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-export-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-flight-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-portify-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-compact-instructions.md',
  'node_modules/canary-lab/dist/apps/web-server/prompts/mcp-lifecycle-instructions.md',
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
  // The four toy samples retired in 2.0.0 when the demo storefront replaced
  // them — a scaffold still carrying one means a stale template shipped.
  'features/example_todo_api/feature.config.cjs',
  'features/broken_todo_api/feature.config.cjs',
  'features/flaky_orders_api/feature.config.cjs',
  'features/tricky_checkout_api/feature.config.cjs',
  // Earlier 2.0.0 drafts shipped partially onboarded demo suites under these
  // names. The suite that ships now is `storefront-journey` (asserted above);
  // any of these reappearing means a stale template shipped.
  'features/demo_catalog/feature.config.cjs',
  'features/demo_inventory/feature.config.cjs',
  'features/demo_storefront/feature.config.cjs',
]) {
  if (fs.existsSync(path.join(projectDir, relPath))) {
    throw new Error(`Smoke test failed: deprecated path still present: ${relPath}`)
  }
}

// The seeded portify record ships workspace-RELATIVE paths (no machine path can
// be published); init resolves them against the new project. A record left
// relative points the Ports tab and the config drill-through at directories
// that don't exist, and nothing else in the scaffold would catch it.
{
  const record = JSON.parse(
    fs.readFileSync(path.join(projectDir, 'logs/portify/portify-2026-08-07T0910-q2mx/portify.json'), 'utf8'),
  )
  const paths = [record.featureDir, ...record.repos.map((r) => r.path)]
  for (const p of paths) {
    if (!path.isAbsolute(p) || !fs.existsSync(p)) {
      throw new Error(`Smoke test failed: seeded portify path not re-homed onto the workspace: ${p}`)
    }
  }
}

run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], projectDir)

for (const relPath of installedPackagePaths) {
  const fullPath = path.join(projectDir, relPath)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Smoke test failed: missing ${relPath}`)
  }
}

for (const relPath of [
  // Browser-only libraries are already compiled into dist/apps/web/dist; a
  // consumer install must not fetch a second copy and its dependency graph.
  'node_modules/react-markdown',
  'node_modules/remark-gfm',
  // Representative private declarations pin the npm ignore boundary without
  // coupling the smoke gate to every internal source file.
  'node_modules/canary-lab/dist/apps/cli/cli.d.ts',
  'node_modules/canary-lab/dist/apps/web-server/src/server.d.ts',
]) {
  if (fs.existsSync(path.join(projectDir, relPath))) {
    throw new Error(`Smoke test failed: package-only path should be omitted: ${relPath}`)
  }
}

run('npx', ['canary-lab', 'new', 'feature', 'smoke_feature', '--description', 'Smoke test feature'], projectDir)
