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

for (const relPath of [
  'package.json',
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/skills/env-import.md',
  '.codex/env-import.md',
  'features/example_todo_api/feature.config.cjs',
  'features/broken_todo_api/feature.config.cjs',
]) {
  const fullPath = path.join(projectDir, relPath)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Smoke test failed: missing ${relPath}`)
  }
}

for (const mdFile of ['CLAUDE.md', 'AGENTS.md']) {
  const content = fs.readFileSync(path.join(projectDir, mdFile), 'utf-8')
  for (const expected of [
    '<!-- managed:canary-lab:start -->',
    '<!-- managed:canary-lab:end -->',
    '<!-- heal-prompt:start -->',
    '<!-- heal-prompt:end -->',
    'When the user says `self heal`, follow the `heal-prompt` block below.',
    'logs/heal-index.md',
    'logs/e2e-summary.json',
    'logs/.restart',
    'logs/.rerun',
    'Prefer exact slice paths from `heal-index.md` before broad repo search.',
    'Avoid broad repo grep when the index or slice already points to a likely file or service.',
  ]) {
    if (!content.includes(expected)) {
      throw new Error(`Smoke test failed: ${mdFile} missing ${expected}`)
    }
  }
  for (const removed of ['## Quick Start', '## Context Files', '## Importing Env Files', 'Before editing, group related failures by file']) {
    if (content.includes(removed)) {
      throw new Error(`Smoke test failed: ${mdFile} still includes ${removed}`)
    }
  }
}

for (const relPath of [
  '.claude/skills/heal-loop.md',
  '.claude/skills/self-fixing-loop.md',
  '.codex/heal-loop.md',
  '.codex/self-fixing-loop.md',
  'features/example_todo_api/src/config.ts',
]) {
  if (fs.existsSync(path.join(projectDir, relPath))) {
    throw new Error(`Smoke test failed: deprecated path still present: ${relPath}`)
  }
}

run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], projectDir)
run('npx', ['canary-lab', 'new-feature', 'smoke_feature', 'Smoke test feature'], projectDir)
