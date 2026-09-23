import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'

// Historical shipped bytes identify legacy installations without guessing from
// a skill's name. Custom instructions never match this migration catalogue.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const revisions = execFileSync('git', ['rev-list', 'HEAD', '--', 'agent-integrations'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
const hashes = {}
for (const revision of revisions) {
  const files = execFileSync('git', ['ls-tree', '-r', revision, '--', 'agent-integrations'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  for (const line of files) {
    const match = line.match(/^\d+ blob ([\da-f]+)\tagent-integrations\/(?:codex|claude)\/skills\/([^/]+)\/(.+)$/)
    if (!match) continue
    const [, blob, skill, file] = match
    const content = execFileSync('git', ['cat-file', 'blob', blob], { cwd: root })
    const digest = createHash('sha256').update(content).digest('hex')
    const values = (hashes[skill] ??= {})[file] ??= []
    if (!values.includes(digest)) values.push(digest)
  }
}
fs.writeFileSync(path.join(root, 'agent-integrations', 'skill-fingerprints.json'), `${JSON.stringify(hashes, null, 2)}\n`)
