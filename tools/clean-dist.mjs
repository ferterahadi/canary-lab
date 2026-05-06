import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
fs.rmSync(path.join(repoRoot, 'dist'), { recursive: true, force: true })
