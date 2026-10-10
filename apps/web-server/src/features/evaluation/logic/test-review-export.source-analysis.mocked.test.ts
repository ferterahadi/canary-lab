import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { loadSourceTests } from './test-review/source-analysis'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

// The extractor and the report's own walker agree on every test in today's
// workspace; this pins what the report does on the day they don't.
vi.mock('../../../shared/ast-extractor', () => ({
  extractTestsFromSource: (file: string) => ({ file, tests: [], parseError: 'unreadable' }),
}))

const tempDir = trackTempDirs('cl-review-mocked-')

describe('a test the extractor cannot read', () => {
  it('keeps its body and checks, without an extracted test', () => {
    const featureDir = tempDir()
    fs.mkdirSync(path.join(featureDir, 'e2e'))
    const spec = path.join(featureDir, 'e2e', 'a.spec.ts')
    fs.writeFileSync(spec, "import { test, expect } from '@playwright/test'\ntest('opens', async ({ page }) => {\n  await expect(page).toHaveTitle('Shop')\n})\n")
    const source = loadSourceTests(featureDir).get(`${spec}:2`)!
    expect(source.bodySource).toContain("toHaveTitle('Shop')")
    expect(source.assertions).toHaveLength(1)
    expect(source).not.toHaveProperty('extracted')
  })
})
