import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetail } from './run-store'

let tmpDir: string
let spawnCalls: Array<{ command: string; args: string[]; child: FakeChild }> = []
let availableAgents: string[] = []

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-review-agent-')))
  spawnCalls = []
  availableAgents = []
  vi.resetModules()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('evaluation rewrite agent path', () => {
  it('returns null when no rewrite agents are available', async () => {
    mockAgentModules()
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail(), 'deterministic', tmpDir)).resolves.toBeNull()
    expect(spawnCalls).toEqual([])
  })

  it('applies Codex text-slot rewrites from output-last-message JSON', async () => {
    availableAgents = ['codex']
    mockAgentModules(({ args, child }) => {
      const outputPath = args[args.indexOf('--output-last-message') + 1]
      fs.writeFileSync(outputPath, JSON.stringify({
        slots: [
          { id: 'featureTitle', text: 'Localized checkout' },
          { id: 'summary', text: 'Readable summary.' },
          { id: 'cases.0.title', text: 'Readable case title' },
          { id: 'cases.0.flowSteps.0.title', text: 'Readable first step' },
          { id: 'cases.0.flowSteps.0.detail', text: 'Readable step detail.' },
          { id: 'cases.0.confidence', text: 'Readable confidence.' },
          { id: 'cases.0.unknown', text: 'Ignored text' },
          { id: 'cases.0.whyItMatters', text: '   ' },
          { id: 42, text: 'Ignored invalid slot' },
        ],
      }))
      child.close(0)
    })
    const onOutput = vi.fn()
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    const rewrite = await generateEvaluationRewriteWithAgent(detail(), 'codex', tmpDir, { onOutput })

    expect(spawnCalls[0].command).toBe('codex')
    expect(spawnCalls[0].args).toContain('--output-schema')
    expect(spawnCalls[0].child.stdinText).toContain('Return strict JSON')
    expect(rewrite?.featureTitle).toBe('Localized checkout')
    expect(rewrite?.summary).toBe('Readable summary.')
    expect(rewrite?.cases[0]).toMatchObject({
      title: 'Readable case title',
      confidence: 'Readable confidence.',
    })
    expect(rewrite?.cases[0].flowSteps?.[0]).toMatchObject({
      title: 'Readable first step',
      detail: 'Readable step detail.',
    })
    expect(rewrite?.cases[0].whyItMatters.trim()).not.toBe('')
    expect(onOutput).toHaveBeenCalledWith('[agent:codex] localized rewrite completed\n')
  })

  it('falls back from unparseable Claude output to a parsed Codex rewrite', async () => {
    availableAgents = ['claude', 'codex']
    mockAgentModules(({ command, child }) => {
      if (command === 'claude') {
        child.stdout.emit('data', 'not json')
        child.stderr.emit('data', 'warning\n')
        child.close(0)
        return
      }
      child.stdout.emit('data', JSON.stringify({
        summary: 'Parsed rewrite summary.',
        cases: [{
          title: 'Parsed case',
          whatWasChecked: 'Parsed check.',
          whyItMatters: 'Parsed impact.',
          confidence: 'Parsed confidence.',
        }],
      }))
      child.close(0)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    const rewrite = await generateEvaluationRewriteWithAgent(detail(), 'claude', tmpDir)

    expect(spawnCalls.map((call) => call.command)).toEqual(['claude', 'codex'])
    expect(rewrite?.summary).toBe('Parsed rewrite summary.')
    expect(rewrite?.cases[0].title).toBe('Parsed case')
  })

  it('rejects when every available agent fails or returns unusable output', async () => {
    availableAgents = ['claude', 'codex']
    mockAgentModules(({ command, child }) => {
      if (command === 'claude') {
        child.stdout.emit('data', '')
        child.close(0)
        return
      }
      child.stderr.emit('data', 'bad flag')
      child.close(2)
    })
    const { generateEvaluationRewriteWithAgent } = await import('./test-review-export')

    await expect(generateEvaluationRewriteWithAgent(detail(), 'auto', tmpDir)).rejects.toThrow(
      /claude: unparseable output: <empty output>.*codex: evaluation rewrite agent failed with exit code 2/s,
    )
  })
})

function mockAgentModules(onSpawn?: (ctx: { command: string; args: string[]; child: FakeChild }) => void): void {
  vi.doMock('./runtime/auto-heal', () => ({
    pickAvailableHealAgent: (preferred?: string) => {
      if (preferred === 'claude' || preferred === 'codex') return availableAgents.includes(preferred) ? preferred : null
      return availableAgents[0] ?? null
    },
  }))
  vi.doMock('child_process', () => ({
    spawn: (command: string, args: string[]) => {
      const child = new FakeChild()
      spawnCalls.push({ command, args, child })
      setTimeout(() => onSpawn?.({ command, args, child }), 0)
      return child
    },
  }))
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdinText = ''
  stdin = {
    end: (text = '') => {
      this.stdinText += text
    },
  }
  killed: string[] = []

  kill(signal: string): void {
    this.killed.push(signal)
  }

  close(code: number, signal: string | null = null): void {
    this.emit('close', code, signal)
  }
}

function detail(): RunDetail {
  const spec = path.join(tmpDir, 'e2e', 'checkout.spec.ts')
  fs.mkdirSync(path.dirname(spec), { recursive: true })
  fs.writeFileSync(spec, `import { test, expect } from '@playwright/test'

test('passes checkout', async ({ page }) => {
  await expect(page.getByText('Checkout')).toBeVisible()
})
`)
  return {
    runId: 'run-1',
    manifest: {
      runId: 'run-1',
      feature: 'checkout',
      featureDir: tmpDir,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:05.000Z',
      status: 'passed',
      healCycles: 0,
      services: [],
    },
    summary: {
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-passes-checkout'],
      failed: [],
    },
    playbackEvents: [{
      type: 'test-end',
      time: '2026-01-01T00:00:05.000Z',
      test: {
        name: 'test-case-passes-checkout',
        title: 'passes checkout',
        location: `${spec}:3`,
      },
      status: 'passed',
      passed: true,
      durationMs: 5000,
      retry: 0,
    }],
  }
}
