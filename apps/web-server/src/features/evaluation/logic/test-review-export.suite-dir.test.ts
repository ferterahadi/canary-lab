import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTestReviewPacket } from './test-review-export'
import { detail } from './__fixtures__/test-review-fixtures'

// The report renders the source the VERDICT executed. With a run-start copy in
// place (D9), an agent's later edit to the live spec must not appear as what the
// run checked — reading the live dir here would show a repaired-looking test
// beside a failure it never saw.

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-suite-')))
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

function spec(assertion: string): string {
  return `import { test, expect } from '@playwright/test'
test('passes checkout', async ({ page }) => {
  ${assertion}
})
`
}

describe('buildTestReviewPacket — which suite it reads', () => {
  it('reads the run-start copy while it exists, not the live spec edited since', () => {
    const featureDir = path.join(tmpDir, 'feature')
    const snapshotDir = path.join(tmpDir, 'logs', 'runs', 'run-1', 'suite')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.mkdirSync(snapshotDir, { recursive: true })
    fs.writeFileSync(path.join(snapshotDir, 'checkout.spec.ts'), spec("await expect(page.getByText('Paid')).toBeVisible()"))
    fs.writeFileSync(path.join(featureDir, 'checkout.spec.ts'), spec("await expect(page.getByText('Anything')).toBeAttached()"))
    const run = detail({ featureDir, eventLocation: `${path.join(snapshotDir, 'checkout.spec.ts')}:2` })
    run.manifest.suiteSnapshot = { kind: 'taken', dir: snapshotDir, takenAt: '2026-01-01T00:00:00.000Z', digest: 'd' }

    const packet = buildTestReviewPacket(run)

    expect(packet.tests[0].testBody).toContain("getByText('Paid')")
    expect(packet.tests[0].testBody).not.toContain('Anything')
  })

  it('falls back to the live dir when the copy is gone', () => {
    const featureDir = path.join(tmpDir, 'feature')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'checkout.spec.ts'), spec("await expect(page.getByText('Live')).toBeVisible()"))
    const run = detail({ featureDir, eventLocation: `${path.join(featureDir, 'checkout.spec.ts')}:2` })
    run.manifest.suiteSnapshot = { kind: 'taken', dir: path.join(tmpDir, 'vanished'), takenAt: '2026-01-01T00:00:00.000Z', digest: 'd' }

    expect(buildTestReviewPacket(run).tests[0].testBody).toContain("getByText('Live')")
  })
})
