import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
  STAGE2_TEMPLATE,
  buildWizardArgs,
  resolveWizardSessionId,
  buildPlanPrompt,
  buildSpecPrompt,
  createTeeSink,
  formatPlan,
  formatRepos,
  loadTemplate,
  substitute,
} from './wizard-agent-spawner'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-spawner-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('substitute', () => {
  it('replaces known placeholders', () => {
    expect(substitute('hello {{name}}!', { name: 'world' })).toBe('hello world!')
  })

  it('replaces multiple placeholders', () => {
    expect(substitute('{{a}} + {{b}} = {{c}}', { a: '1', b: '2', c: '3' })).toBe(
      '1 + 2 = 3',
    )
  })

  it('leaves unknown placeholders untouched', () => {
    expect(substitute('hi {{unknown}}', { name: 'x' })).toBe('hi {{unknown}}')
  })

  it('handles empty replacements', () => {
    expect(substitute('a={{x}}', { x: '' })).toBe('a=')
  })
})

describe('formatRepos', () => {
  it('returns "(none)" for empty list', () => {
    expect(formatRepos([])).toBe('(none)')
  })

  it('formats a single repo as a bullet line', () => {
    expect(formatRepos([{ name: 'app', localPath: '/p/app' }])).toBe(
      '- app (/p/app)',
    )
  })

  it('joins multiple repos with newlines', () => {
    const out = formatRepos([
      { name: 'a', localPath: '/p/a' },
      { name: 'b', localPath: '/p/b', branch: 'feature/demo' },
    ])
    expect(out).toBe('- a (/p/a)\n- b (/p/b) branch=feature/demo')
  })
})

describe('formatPlan', () => {
  it('pretty-prints JSON', () => {
    const out = formatPlan([{ step: 'do thing' }])
    expect(out).toContain('"step": "do thing"')
    expect(out.split('\n').length).toBeGreaterThan(1)
  })
})

describe('loadTemplate', () => {
  it('reads stage 1 prompt template', () => {
    const t = loadTemplate(STAGE1_TEMPLATE)
    expect(t).toContain('{{prdText}}')
    expect(t).toContain('{{repos}}')
    expect(t).toContain('<plan-output>')
    expect(t).toContain('<intent-summary>')
    expect(t).toContain('</intent-summary>')
    expect(t).toContain('plan-output marker not found')
    expect(t).toContain('output bare JSON')
    expect(t).toContain('Group by test intent')
    expect(t).toContain('spec-file boundaries')
  })

  it('reads stage 1 diff-only prompt template', () => {
    const t = loadTemplate(STAGE1_DIFF_TEMPLATE)
    expect(t).toContain('{{prdText}}')
    expect(t).toContain('{{repos}}')
    expect(t).toContain('<plan-output>')
    expect(t).toContain('<intent-summary>')
    expect(t).toContain('Inferred from local diff (no PRD provided).')
    expect(t).toContain('plan-output marker not found')
    expect(t).toContain('Committed branch changes')
    expect(t).toContain('Use available refs in this order')
    expect(t.indexOf('local parent')).toBeLessThan(t.indexOf('origin/main'))
    expect(t).toContain('regression-safety-first')
  })

  it('reads stage 2 prompt template', () => {
    const t = loadTemplate(STAGE2_TEMPLATE)
    expect(t).toContain('{{featureName}}')
    expect(t).toContain('{{plan}}')
    expect(t).toContain("test('<plan step>'")
    expect(t).toContain('Do not wrap a generated test body in a same-named')
    expect(t).toContain('infer')
    expect(t).toContain('startCommands')
    expect(t).toContain('healthCheck')
    expect(t).toContain('Use `startCommands: []` only when no defensible local command or readiness probe can be inferred')
    expect(t).toContain('Envsets are named runtime environments')
    expect(t).toContain('filename markers like')
    expect(t).toContain('envsets/prod/foo.env.dev')
    expect(t).toContain('Choose the spec-file split yourself')
    expect(t).toContain('multiple focused `e2e/*.spec.ts` files')
    expect(t).toContain('playwright.config.ts')
    expect(t).toContain('<dev-dependencies>')
    expect(t).toContain('"appRoots"')
    expect(t).toContain('"slots"')
    expect(t).toContain('"feature"')
    expect(t).toContain('<file path=')
  })
})

describe('buildPlanPrompt', () => {
  it('substitutes prdText and repos using the real template', () => {
    const out = buildPlanPrompt({
      prdText: 'Login flow PRD',
      repos: [{ name: 'app', localPath: '/p/app' }],
    })
    expect(out).toContain('Login flow PRD')
    expect(out).toContain('- app (/p/app)')
    expect(out).toContain('<plan-output>')
    expect(out).toContain('<intent-summary>')
    expect(out).not.toContain('{{prdText}}')
    expect(out).not.toContain('{{repos}}')
  })

  it('uses an injected template when provided', () => {
    const out = buildPlanPrompt({
      prdText: 'X',
      repos: [],
      template: 'PRD={{prdText}};REPOS={{repos}}',
    })
    expect(out).toBe('PRD=X;REPOS=(none)')
  })

  it('substitutes prdText and repos into the diff-only template', () => {
    const out = buildPlanPrompt({
      prdText: '',
      repos: [{ name: 'app', localPath: '/p/app' }],
      template: loadTemplate(STAGE1_DIFF_TEMPLATE),
    })
    expect(out).toContain('- app (/p/app)')
    expect(out).toContain('diff-mode planning')
    expect(out).not.toContain('{{prdText}}')
    expect(out).not.toContain('{{repos}}')
  })
})

describe('buildSpecPrompt', () => {
  it('substitutes plan and repos', () => {
    const out = buildSpecPrompt({
      featureName: 'login_flow',
      plan: [{ step: 'open page' }],
      repos: [{ name: 'app', localPath: '/p' }],
      template: 'F={{featureName}}|P={{plan}}|R={{repos}}',
    })
    expect(out).toContain('login_flow')
    expect(out).toContain('"step": "open page"')
    expect(out).toContain('- app (/p)')
  })

  it('works against the real stage 2 template (direct test structure preserved)', () => {
    const out = buildSpecPrompt({
      featureName: 'login_flow',
      plan: [],
      repos: [],
    })
    expect(out).toContain('login_flow')
    expect(out).toContain("test('<plan step>'")
    expect(out).toContain('Do not wrap a generated test body in a same-named')
    expect(out).toContain("test('Open the cart'")
    expect(out).not.toContain("test.step('Open the cart'")
    expect(out).toContain('Stale assertion shapes to avoid')
    expect(out).toContain('Use `startCommands: []` only when no defensible local command or readiness probe can be inferred')
    expect(out).toContain('Envsets are named runtime environments')
    expect(out).toContain('envsets/prod/foo.env.dev')
    expect(out).toContain('Choose the spec-file split yourself')
    expect(out).toContain('multiple focused `e2e/*.spec.ts` files')
    expect(out).toContain('<dev-dependencies>')
    expect(out).toContain('"appRoots"')
    expect(out).toContain('"slots": ["login_flow.env"]')
    expect(out).toContain('$CANARY_LAB_PROJECT_ROOT/features/login_flow/.env')
    expect(out).toContain('<file path=')
  })
})

const CLAUDE_BASE = ['-p', 'hi', '--dangerously-skip-permissions', '--output-format=stream-json', '--include-partial-messages', '--verbose']

describe('buildWizardArgs', () => {
  it('builds headless agentic claude args with stream-json (for liveness)', () => {
    expect(buildWizardArgs('claude', 'hi')).toEqual(CLAUDE_BASE)
    expect(buildWizardArgs('claude', 'hi')).not.toContain('--resume')
    expect(buildWizardArgs('claude', 'hi')).not.toContain('--session-id')
  })

  it('pins the claude session id when provided', () => {
    expect(buildWizardArgs('claude', 'hi', { pinSessionId: 'sess-42' })).toEqual([
      ...CLAUDE_BASE, '--session-id', 'sess-42',
    ])
  })

  it('resumes the claude session for the spec stage (over a pin)', () => {
    expect(buildWizardArgs('claude', 'hi', { resumeSessionId: 'sess-123', pinSessionId: 'ignored' })).toEqual([
      ...CLAUDE_BASE, '--resume', 'sess-123',
    ])
  })

  it('builds headless agentic codex exec args — no --json', () => {
    expect(buildWizardArgs('codex', 'hi')).toEqual(['exec', '--skip-git-repo-check', '--full-auto', 'hi'])
    expect(buildWizardArgs('codex', 'hi')).not.toContain('--json')
  })

  it('resumes the codex session for the spec stage', () => {
    expect(buildWizardArgs('codex', 'hi', { resumeSessionId: 'thread-123' })).toEqual([
      'exec', 'resume', '--skip-git-repo-check', '--full-auto', 'thread-123', 'hi',
    ])
  })
})

describe('resolveWizardSessionId', () => {
  it('returns the pinned claude id', () => {
    expect(resolveWizardSessionId({ agent: 'claude', cwd: tmp, pinSessionId: 'sess-9', spawnedAt: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ kind: 'claude', id: 'sess-9' })
  })

  it('returns null for claude without a pinned id', () => {
    expect(resolveWizardSessionId({ agent: 'claude', cwd: tmp, spawnedAt: '2026-01-01T00:00:00.000Z' })).toBeNull()
  })

  it('returns null for codex when no session log matches the cwd', () => {
    expect(resolveWizardSessionId({ agent: 'codex', cwd: tmp, spawnedAt: '2026-01-01T00:00:00.000Z' })).toBeNull()
  })

  it('returns the codex session ref when a matching session log exists (line 167 true branch)', () => {
    // locateCodexSessionLog uses os.homedir() for the sessions root. Redirect it
    // to a tmp dir so we can create a matching session log without touching ~.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-spawner-home-'))
    const sessionDir = path.join(fakeHome, '.codex', 'sessions', '2026', '01', '01')
    fs.mkdirSync(sessionDir, { recursive: true })
    const sessionFile = path.join(sessionDir, 'sess-codex-xyz.jsonl')
    const meta = {
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'session_meta',
      payload: { id: 'sess-codex-xyz', cwd: fs.realpathSync(tmp), timestamp: '2026-01-01T00:00:01.000Z' },
    }
    fs.writeFileSync(sessionFile, JSON.stringify(meta) + '\n')
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
    try {
      const ref = resolveWizardSessionId({ agent: 'codex', cwd: tmp, spawnedAt: '2026-01-01T00:00:00.000Z' })
      expect(ref).toEqual({ kind: 'codex', id: 'sess-codex-xyz' })
    } finally {
      spy.mockRestore()
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

describe('createTeeSink', () => {
  it('writes chunks to the log file and accumulates the stream', () => {
    const logPath = path.join(tmp, 'agent.log')
    const sink = createTeeSink({ logPath })
    sink.push('hello ')
    sink.push('world')
    expect(sink.fullStream()).toBe('hello world')
    expect(fs.readFileSync(logPath, 'utf8')).toBe('hello world')
  })

  it('truncates an existing log file on construction', () => {
    const logPath = path.join(tmp, 'agent.log')
    fs.writeFileSync(logPath, 'stale content', 'utf8')
    const sink = createTeeSink({ logPath })
    sink.push('fresh')
    expect(fs.readFileSync(logPath, 'utf8')).toBe('fresh')
  })

  it('creates parent directories as needed', () => {
    const logPath = path.join(tmp, 'nested', 'deep', 'agent.log')
    const sink = createTeeSink({ logPath })
    sink.push('x')
    expect(fs.existsSync(logPath)).toBe(true)
    expect(fs.readFileSync(logPath, 'utf8')).toBe('x')
  })

  it('survives a transient append failure without losing the accumulated stream', () => {
    const logPath = path.join(tmp, 'agent.log')
    const sink = createTeeSink({ logPath })
    sink.push('first')
    // Delete the file so the next append fails on some platforms; on others
    // appendFileSync will recreate it. Either way the in-memory accumulator
    // must continue to record the chunk.
    fs.rmSync(logPath, { force: true })
    sink.push('second')
    expect(sink.fullStream()).toBe('firstsecond')
  })
})
