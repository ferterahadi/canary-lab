import { spawnSync } from 'child_process'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const cacheDir = path.join(os.tmpdir(), 'canary-lab-npm-cache')

const result = spawnSync('npm', ['pack', '--dry-run'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_cache: cacheDir,
  },
})

process.exit(result.status ?? 1)
