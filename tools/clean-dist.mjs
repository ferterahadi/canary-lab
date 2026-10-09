import fs from 'node:fs'
import path from 'node:path'
import { REPO as repoRoot } from './lib/fs.mjs'

fs.rmSync(path.join(repoRoot, 'dist'), { recursive: true, force: true })
