import { spawnSync } from 'child_process'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const allowDirty = process.argv.includes('--allow-dirty')
const cacheDir = path.join(os.tmpdir(), 'canary-lab-npm-cache')

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (!allowDirty) {
  const status = spawnSync('git', ['status', '--short'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  })

  if ((status.stdout ?? '').trim() !== '') {
    console.error('Refusing to publish with a dirty worktree. Re-run with --allow-dirty to override.')
    process.exit(1)
  }
}

run('npm', ['run', 'build'])
run('npm', ['pack', '--dry-run'])
run('npm', ['publish', ...process.argv.slice(2).filter((arg) => arg !== '--allow-dirty')])
