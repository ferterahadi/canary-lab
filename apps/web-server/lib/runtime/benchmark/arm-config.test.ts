import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { baselinePlaywrightSpawner, buildBaselineHealPrompt } from './arm-config'
import type { PlaywrightSpawner } from '../orchestrator'

describe('baselinePlaywrightSpawner', () => {
  it('prepends CANARY_LAB_BENCHMARK_MODE=baseline to the Playwright command (per-child, parallel-safe)', () => {
    const base: PlaywrightSpawner = () => ({
      command: 'npx playwright test --reporter=summary.js,list',
      cwd: '/feat',
    })
    const inv = baselinePlaywrightSpawner(base)({} as Parameters<PlaywrightSpawner>[0])
    expect(inv.command).toBe(
      'CANARY_LAB_BENCHMARK_MODE=baseline npx playwright test --reporter=summary.js,list',
    )
    expect(inv.cwd).toBe('/feat')
  })

  it('passes the spawner args through to the wrapped spawner unchanged', () => {
    let seen: unknown
    const base: PlaywrightSpawner = (args) => {
      seen = args
      return { command: 'cmd', cwd: '/x' }
    }
    const args = { feature: { foo: 1 }, paths: {} } as unknown as Parameters<PlaywrightSpawner>[0]
    baselinePlaywrightSpawner(base)(args)
    expect(seen).toBe(args)
  })
})

describe('buildBaselineHealPrompt', () => {
  let runDir: string
  beforeEach(() => {
    runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-armcfg-')))
  })

  it('is minimal: fix app code, tests read-only, Playwright only — and omits Canary curated context', () => {
    const build = buildBaselineHealPrompt({ runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'mcp') })
    expect(prompt.toLowerCase()).toContain('playwright')
    expect(prompt.toLowerCase()).toContain('do not edit')
    // The differentiator: baseline does NOT get the harness's curated context.
    expect(prompt).not.toContain('heal-index')
    expect(prompt).not.toContain('trace-extract')
  })

  it('persists the prompt to <runDir>/heal-prompt.md', () => {
    const build = buildBaselineHealPrompt({ runDir })
    const prompt = build({ cycle: 0, outputDir: path.join(runDir, 'mcp') })
    expect(fs.readFileSync(path.join(runDir, 'heal-prompt.md'), 'utf-8')).toBe(prompt)
  })
})
