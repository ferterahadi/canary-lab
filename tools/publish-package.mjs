import { spawnSync } from 'child_process'
import os from 'os'
import path from 'path'
import { REPO as repoRoot } from './lib/fs.mjs'
import { runOrExit } from './lib/run.mjs'

const allowDirty = process.argv.includes('--allow-dirty')
const cacheDir = path.join(os.tmpdir(), 'canary-lab-npm-cache')

function run(command, args) {
  runOrExit(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
    },
  })
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

run('npm', ['publish', ...process.argv.slice(2).filter((arg) => arg !== '--allow-dirty')])
