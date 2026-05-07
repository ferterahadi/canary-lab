import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaneBroker } from './pane-broker'
import {
  STAGE1_DIFF_TEMPLATE,
  STAGE1_TEMPLATE,
  STAGE2_TEMPLATE,
  buildClaudeArgs,
  buildClaudeCommand,
  buildClaudeResumeArgs,
  buildCodexArgs,
  buildCodexCommand,
  buildCodexResumeArgs,
  buildPlanPrompt,
  buildSpecPrompt,
  buildWizardCommand,
  createTeeSink,
  paneIdForDraft,
  formatPlan,
  formatRepos,
  formatSkills,
  loadTemplate,
  shellQuote,
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
      { name: 'b', localPath: '/p/b' },
    ])
    expect(out).toBe('- a (/p/a)\n- b (/p/b)')
  })
})

describe('formatPlan', () => {
  it('pretty-prints JSON', () => {
    const out = formatPlan([{ step: 'do thing' }])
    expect(out).toContain('"step": "do thing"')
    expect(out.split('\n').length).toBeGreaterThan(1)
  })
})

describe('formatSkills', () => {
  it('returns placeholder for empty list', () => {
    expect(formatSkills([])).toBe('(no skills selected)')
  })

  it('emits framed blocks per skill, trimming content', () => {
    const out = formatSkills([
      { id: 'user:foo', content: '\n\nbody of foo  \n\n' },
      { id: 'plugin:bar', content: 'body of bar' },
    ])
    expect(out).toContain('--- skill: user:foo ---')
    expect(out).toContain('body of foo')
    expect(out).toContain('--- skill: plugin:bar ---')
    expect(out).toContain('body of bar')
    expect(out).toContain('--- end skill ---')
  })
})

describe('loadTemplate', () => {
  it('reads stage 1 prompt template', () => {
    const t = loadTemplate(STAGE1_TEMPLATE)
    expect(t).toContain('{{prdText}}')
    expect(t).toContain('{{repos}}')
    expect(t).toContain('<plan-output>')
    expect(t).toContain('The `<plan-output>` wrapper is mandatory')
    expect(t).toContain('plan-output marker not found')
    expect(t).toContain('Do not output bare JSON')
    expect(t).toContain('Preserve scenario boundaries')
    expect(t).toContain('spec-file boundaries')
  })

  it('reads stage 1 diff-only prompt template', () => {
    const t = loadTemplate(STAGE1_DIFF_TEMPLATE)
    expect(t).toContain('{{prdText}}')
    expect(t).toContain('{{repos}}')
    expect(t).toContain('<plan-output>')
    expect(t).toContain('The `<plan-output>` wrapper is mandatory')
    expect(t).toContain('plan-output marker not found')
    expect(t).toContain('branch + worktree diff')
    expect(t).toContain('Prefer the local parent branch')
    expect(t.indexOf('local parent')).toBeLessThan(t.indexOf('origin/main'))
    expect(t).toContain('Regression safety first')
  })

  it('reads stage 2 prompt template', () => {
    const t = loadTemplate(STAGE2_TEMPLATE)
    expect(t).toContain('{{featureName}}')
    expect(t).toContain('{{plan}}')
    expect(t).toContain('{{skills}}')
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
    expect(out).toContain('The `<plan-output>` wrapper is mandatory')
    expect(out).toContain('exactly one literal `<plan-output>` open marker')
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
    expect(out).toContain('diff-only planning')
    expect(out).not.toContain('{{prdText}}')
    expect(out).not.toContain('{{repos}}')
  })
})

describe('buildSpecPrompt', () => {
  it('substitutes plan, skills, and repos', () => {
    const out = buildSpecPrompt({
      featureName: 'login_flow',
      plan: [{ step: 'open page' }],
      skills: [{ id: 'user:s1', content: 'rule body' }],
      repos: [{ name: 'app', localPath: '/p' }],
      template: 'F={{featureName}}|P={{plan}}|S={{skills}}|R={{repos}}',
    })
    expect(out).toContain('login_flow')
    expect(out).toContain('"step": "open page"')
    expect(out).toContain('user:s1')
    expect(out).toContain('rule body')
    expect(out).toContain('- app (/p)')
  })

  it('works against the real stage 2 template (direct test structure preserved)', () => {
    const out = buildSpecPrompt({
      featureName: 'login_flow',
      plan: [],
      skills: [],
      repos: [],
    })
    expect(out).toContain('login_flow')
    expect(out).toContain("test('<plan step>'")
    expect(out).toContain('Do not wrap a generated test body in a same-named')
    expect(out).toContain("test('Open the login page'")
    expect(out).not.toContain("test.step('Open the login page'")
    expect(out).toContain('Use local evidence such as')
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

describe('shellQuote / buildClaudeArgs / buildClaudeCommand', () => {
  it('quotes simple strings safely', () => {
    expect(shellQuote('hello')).toBe(`'hello'`)
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('passes prompt as positional arg with -p', () => {
    expect(buildClaudeArgs('hi')).toEqual([
      '--dangerously-skip-permissions',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
      '-p',
      'hi',
    ])
    expect(buildClaudeArgs('hi')).not.toContain('--resume')
    expect(buildClaudeArgs('hi')).not.toContain('--continue')
  })

  it('builds claude resume args for spec generation', () => {
    expect(buildClaudeResumeArgs('hi', 'sess-123')).toEqual([
      '--dangerously-skip-permissions',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose',
      '--resume',
      'sess-123',
      '-p',
      'hi',
    ])
  })

  it('builds a bash-safe command line', () => {
    const cmd = buildClaudeCommand(`hello "world" it's me`)
    expect(cmd.startsWith('set -o pipefail; claude ')).toBe(true)
    expect(cmd).toContain(`--output-format=stream-json`)
    expect(cmd).toContain(`wizard-claude-formatter.js`)
    expect(cmd).toContain(`'-p'`)
    // Embedded single quote must be escaped via the standard close/escape/open trick.
    expect(cmd).toContain(`'\\''`)
  })

  it('honors a custom claude binary path', () => {
    const cmd = buildClaudeCommand('hi', '/opt/bin/claude')
    expect(cmd.startsWith('set -o pipefail; /opt/bin/claude ')).toBe(true)
  })

  it('builds a claude resume command when a session id is supplied', () => {
    const cmd = buildClaudeCommand('hi', 'claude', 'sess-123')
    expect(cmd).toContain(`'--resume' 'sess-123'`)
    expect(cmd).not.toContain('--no-session-persistence')
  })
})

describe('buildCodexArgs / buildCodexCommand / buildWizardCommand', () => {
  it('builds codex exec args', () => {
    expect(buildCodexArgs('hi')).toEqual(['exec', '--skip-git-repo-check', '--full-auto', '--json', 'hi'])
  })

  it('builds codex resume args for spec generation', () => {
    expect(buildCodexResumeArgs('hi', 'thread-123')).toEqual([
      'exec',
      'resume',
      '--skip-git-repo-check',
      '--full-auto',
      '--json',
      'thread-123',
      'hi',
    ])
  })

  it('builds a bash-safe codex command line', () => {
    const cmd = buildCodexCommand(`hello it's me`)
    expect(cmd.startsWith('set -o pipefail; codex ')).toBe(true)
    expect(cmd).toContain(`'exec'`)
    expect(cmd).toContain(`'--json'`)
    expect(cmd).toContain(`wizard-codex-formatter.js`)
    expect(cmd).toContain(`'\\''`)
  })

  it('dispatches by agent', () => {
    expect(buildWizardCommand('claude', 'hi')).toMatch(/^set -o pipefail; claude /)
    expect(buildWizardCommand('codex', 'hi')).toMatch(/^set -o pipefail; codex /)
  })

  it('dispatches resume by agent', () => {
    expect(buildWizardCommand('claude', 'hi', { resumeSessionId: 'sess-123' }))
      .toContain(`'--resume' 'sess-123'`)
    expect(buildWizardCommand('codex', 'hi', { resumeSessionId: 'thread-123' }))
      .toContain(`'exec' 'resume'`)
  })
})

describe('paneIdForDraft', () => {
  it('namespaces draft pane ids by stage', () => {
    expect(paneIdForDraft('d-1', 'planning')).toBe('draft:d-1:planning')
    expect(paneIdForDraft('d-1', 'generating')).toBe('draft:d-1:generating')
  })

  it('defaults to planning for compatibility', () => {
    expect(paneIdForDraft('d-1')).toBe('draft:d-1:planning')
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

  it('pushes chunks to the broker when paneId+broker are supplied', () => {
    const logPath = path.join(tmp, 'agent.log')
    const broker = new PaneBroker()
    const sink = createTeeSink({ logPath, broker, paneId: 'draft:d1' })
    sink.push('chunk-1')
    sink.push('chunk-2')
    expect(broker.snapshot('draft:d1')).toBe('chunk-1chunk-2')
  })

  it('does not push to broker when paneId is missing', () => {
    const logPath = path.join(tmp, 'agent.log')
    const broker = new PaneBroker()
    const sink = createTeeSink({ logPath, broker })
    sink.push('x')
    // No pane was ever opened — broker has no panes.
    expect(broker.paneIds()).toEqual([])
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
