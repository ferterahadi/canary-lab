import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { command, sourceRoot } from './files'
import { runTests } from './evaluator'
import { writeRunbook } from './runtime'
import { trackTempDirs } from '../test-helpers/temp-dir'

const tempDir = trackTempDirs('study-output-')

it('keeps runbook and evaluator artifacts inside their roots beneath an unrelated package', async () => {
  const workspace = tempDir()
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}')
  const ancestorOutput = path.join(workspace, 'test-results')
  fs.mkdirSync(ancestorOutput)
  const sentinel = path.join(ancestorOutput, '.last-run.json')
  fs.writeFileSync(sentinel, 'unrelated workspace evidence')
  for (const mode of ['runbook', 'evaluator']) {
    const root = path.join(workspace, 'campaign', mode)
    const suite = path.join(root, 'suite')
    fs.mkdirSync(suite, { recursive: true })
    fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir')
    fs.writeFileSync(path.join(suite, 'playwright.config.ts'), 'export default { testDir: ".", workers: 1 }')
    fs.writeFileSync(path.join(suite, 'output.spec.ts'), `import { test, expect } from '@playwright/test'
test('writes local evidence', async ({}, testInfo) => {
  const fs = await import('node:fs')
  fs.writeFileSync(testInfo.outputPath('evidence.txt'), 'retained')
  expect(1).toBe(1)
})
`)
    if (mode === 'runbook') {
      const invocation = writeRunbook(root, {}, {}).test
      const result = await command('/bin/bash', ['-c', `${invocation} --reporter=json`], { cwd: root,
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(root, 'playwright.json') } })
      expect(result.code).toBe(0)
    } else {
      expect((await runTests(root, {})).passed).toEqual(['writes local evidence'])
    }
    const report = JSON.parse(fs.readFileSync(path.join(root, 'playwright.json'), 'utf8'))
    expect(report.config.projects[0].outputDir).toBe(path.join(root, 'test-results'))
    expect(fs.existsSync(path.join(root, 'test-results', '.last-run.json'))).toBe(true)
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('unrelated workspace evidence')
  }
}, 30_000)
