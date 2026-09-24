import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function smokeTestReadability(cli, root) {
  const dir = path.join(root, 'readability-smoke')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'example.spec.ts')
  const source = "test('@req-R1 preserves its assertion', () => { const first = 1, second = first + 1; expect(second).toBe(2) })\n"
  fs.writeFileSync(file, source)
  const check = (args, status) => {
    const result = spawnSync(process.execPath, [cli, 'test-readability', file, '--json', ...args], { cwd: root, encoding: 'utf8' })
    if (result.status !== status) throw new Error(`Readability smoke expected exit ${status}: ${result.stderr}\n${result.stdout}`)
    return JSON.parse(result.stdout)
  }
  const before = check([], 1)
  if (before.needsChanges !== 1 || fs.readFileSync(file, 'utf8') !== source) {
    throw new Error('Readability audit must detect the declaration without writing source')
  }
  const fixed = check(['--fix'], 0)
  const content = fs.readFileSync(file, 'utf8')
  if (fixed.changed !== 1 || !content.includes('const first = 1\n  const second = first + 1')
    || !content.includes("test('@req-R1 preserves its assertion'") || !content.includes('expect(second).toBe(2)')) {
    throw new Error('Packaged readability cleanup changed the test contract or missed the declaration')
  }
  if (check([], 0).needsChanges !== 0 || check(['--fix'], 0).changed !== 0) {
    throw new Error('Packaged readability cleanup must be idempotent')
  }
  console.log('✔ packaged test-readability: audit, safe fix, preserved assertion, idempotence')
}
