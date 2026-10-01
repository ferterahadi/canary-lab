import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'

const repo = path.resolve(import.meta.dirname, '..')
let temp: string
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-contract-')) })
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }) })

// Feed deliberate source drift to the actual checker without modifying the checkout.
it.each([
  ['apps/web/src/shared/api/portify.ts', "export interface PortifyIndexEntry { workflowId: string }", 'PortifyIndexEntry'],
  ['apps/web-server/src/features/portify/logic/runtime/types.ts', "export type PortifyStatus = 'editing'", 'PortifyStatus'],
  ['apps/web/src/features/portify/state/portify-state.ts', 'bypass', 'PortifyIndexEntry'],
  ['apps/web-server/src/features/portify/logic/runtime/store.ts', 'bypass', 'PortifyIndexEntry'],
])('rejects drift in %s: %s', (file, mutation, typeName) => {
  const checker = fs.readFileSync(path.join(repo, 'tools/check-wire-contracts.mjs'), 'utf8')
    .replace("const REPO = path.resolve(import.meta.dirname, '..')", `const REPO = ${JSON.stringify(repo)}`)
    .replace("return readFileSync(path.join(REPO, rel), 'utf8')", `
      const source = readFileSync(path.join(REPO, rel), 'utf8')
      if (rel !== ${JSON.stringify(file)}) return source
      return ${mutation === 'bypass'
        ? "source.replace(/portifyIndexEntry\\(/g, 'localProjection(')"
        : `source + ${JSON.stringify('\n' + mutation)}`}
    `)
  const script = path.join(temp, 'check.mjs')
  fs.writeFileSync(script, checker)
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(typeName)
  expect(result.stderr).toContain(mutation === 'bypass' ? 'must use it' : 'without a local mirror')
})
