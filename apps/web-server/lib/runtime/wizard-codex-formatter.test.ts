import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanCommand,
  elapsed,
  formatCommandOutput,
  handleCompleted,
  handleLine,
  inspectionSummary,
  parseInspectionCommand,
  parseReadCommand,
  summarizeOutput,
  tag,
  truncate,
} from './wizard-codex-formatter'

let writes: string[]
let spy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  writes = []
  spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
})

afterEach(() => {
  spy.mockRestore()
})

describe('wizard codex formatter', () => {
  it('formats helper output without ANSI', () => {
    expect(elapsed()).toMatch(/^\d+:\d{2}$/)
    expect(tag()).toMatch(/^\[\d+:\d{2}\]$/)
    expect(truncate('abcdef', 4)).toBe('abc...')
    expect(cleanCommand("/bin/zsh -lc 'npm test'")).toBe('npm test')
    expect(cleanCommand('/bin/bash -c "echo hi"')).toBe('echo hi')
    expect(cleanCommand('git status')).toBe('git status')
    expect(summarizeOutput('')).toBe('(no output)')
    expect(summarizeOutput('\nfirst\nsecond')).toBe('first')
    expect(formatCommandOutput('first\nsecond')).toContain('second')
    expect(formatCommandOutput('   ')).toBeNull()
    expect(parseReadCommand('cat README.md')?.label).toBe('README.md')
    expect(parseReadCommand("sed -n '10,20p' apps/web/server.ts")?.label).toBe('apps/web/server.ts L10-20')
    expect(parseInspectionCommand('ls apps/web')).toEqual({ kind: 'List', label: 'apps/web' })
    expect(parseInspectionCommand('find apps -name "*.ts"')?.kind).toBe('Glob')
    expect(parseInspectionCommand('rg "secret" apps')?.kind).toBe('Grep')
    // `test -f file && actual-command` guard prefix (line 73-74) and the
    // sed-pattern slice form (line 82-85). Both arms had zero hits.
    expect(parseInspectionCommand('test -f apps/web/server.ts && cat apps/web/server.ts'))
      .toEqual({ kind: 'Read', label: 'apps/web/server.ts' })
    expect(parseInspectionCommand("sed -n '/start/,/end/p' apps/web/server.ts"))
      .toEqual({ kind: 'Read', label: 'apps/web/server.ts (pattern slice)' })
    expect(parseReadCommand('npm test')).toBeNull()
    expect(inspectionSummary('Read', 'abc')).toBe('Number of characters: 3')
    expect(inspectionSummary('List', 'a\nb\n')).toBe('Number of files: 2')
    expect(inspectionSummary('Glob', 'a\nb\n')).toBe('Number of files: 2')
    expect(inspectionSummary('Grep', 'a:1\nb:2\n')).toBe('Number of matches: 2')
    expect(inspectionSummary('Inspect', 'source body')).toBe('Content read.')
  })

  it('ignores empty, invalid, and incomplete payloads', () => {
    handleLine('')
    handleLine('not json')
    handleLine(JSON.stringify({ type: 'item.completed' }))
    expect(writes).toEqual([])
  })

  it('ignores unknown line types without emitting output', () => {
    handleLine(JSON.stringify({ type: 'unknown.event', stuff: 1 }))
    expect(writes).toEqual([])
  })

  it('prints inspection label without output line when a read-style command succeeds with empty output', () => {
    handleLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'cat empty.txt',
        exit_code: 0,
        aggregated_output: '',
      },
    }))
    const out = writes.join('')
    expect(out).toContain('Read empty.txt (ok)')
    expect(out).not.toContain('Number of characters')
  })

  it('prints thread progress without ANSI', () => {
    handleLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread-123456' }))
    expect(writes.join('')).toContain('[[canary-lab:wizard-session agent=codex id=thread-123456]]')
    expect(writes.join('')).toContain('thread thread-1')
    expect(writes.join('')).not.toContain('\u001b')
  })

  it('uses fallback thread label when the id is missing', () => {
    handleLine(JSON.stringify({ type: 'thread.started' }))
    expect(writes.join('')).toContain('thread started')
  })

  it('emits agent messages raw so wizard markers remain parseable', () => {
    handleLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '<file path="generated/example.spec.ts">\ntest("x", async () => {})\n</file>',
      },
    }))
    const out = writes.join('')
    expect(out).toContain('<file path="generated/example.spec.ts">')
    expect(out).toContain('test("x"')
    expect(out).not.toContain('│')
    expect(out).not.toContain('\u001b')
  })

  it('skips blank agent messages and prints reasoning text', () => {
    handleCompleted({ type: 'agent_message' })
    handleCompleted({ type: 'agent_message', text: '   ' })
    handleCompleted({ type: 'reasoning', text: 'thinking about a fix\nmore detail' })
    handleCompleted({ type: 'reasoning' })
    handleCompleted({ type: 'reasoning', text: '' })
    const out = writes.join('')
    expect(out).toContain('thinking thinking about a fix')
  })

  it('prints command states and full output', () => {
    handleCompleted({
      type: 'command_execution',
    })
    handleCompleted({
      type: 'command_execution',
      command: "/bin/zsh -lc 'npm run test'",
      exit_code: 0,
      aggregated_output: 'pass\nsecond line',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'npm run dev',
      exit_code: null,
      aggregated_output: '',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'npm run lint',
      exit_code: 2,
      aggregated_output: 'lint failed',
    })
    const out = writes.join('')
    expect(out).toContain('command  (running)')
    expect(out).toContain('command npm run test (ok)')
    expect(out).toContain('output pass')
    expect(out).toContain('second line')
    expect(out).toContain('command npm run dev (running)')
    expect(out).toContain('command npm run lint (exit 2)')
    expect(out).toContain('lint failed')
  })

  it('summarizes successful read-like command output while keeping the read target visible', () => {
    handleCompleted({
      type: 'command_execution',
      command: 'cat README.md',
      exit_code: 0,
      aggregated_output: '# Secret read body\nDo not display this line',
    })
    handleCompleted({
      type: 'command_execution',
      command: "sed -n '10,20p' apps/web/server.ts",
      exit_code: 0,
      aggregated_output: 'const secret = true',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'head -n 5 package.json',
      exit_code: 0,
      aggregated_output: '{ "private": true }',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'tail -20 logs/run.log',
      exit_code: 0,
      aggregated_output: 'last log line',
    })
    const out = writes.join('')
    expect(out).toContain('Read README.md (ok)')
    expect(out).toContain('Read apps/web/server.ts L10-20 (ok)')
    expect(out).toContain('Read package.json (ok)')
    expect(out).toContain('Read logs/run.log (ok)')
    expect(out.match(/Number of characters:/g)).toHaveLength(4)
    expect(out).not.toContain('Secret read body')
    expect(out).not.toContain('const secret')
    expect(out).not.toContain('"private"')
    expect(out).not.toContain('last log line')
  })

  it('summarizes Bash head and cat file reads without displaying source lines', () => {
    handleCompleted({
      type: 'command_execution',
      command: 'head -40 ~/Documents/tiktok-portal/api/jobs/index.ts',
      exit_code: 0,
      aggregated_output: [
        'import { requireN8nAuth } from "../../lib/auth";',
        'export default {',
        '  async fetch(request: Request): Promise<Response> {',
      ].join('\n'),
    })
    handleCompleted({
      type: 'command_execution',
      command: 'cat ~/Documents/tiktok-portal/api/approvals/\\[token\\].ts',
      exit_code: 0,
      aggregated_output: [
        'import { approvePost, getApproval } from "../../lib/service";',
        'export default {',
        '  async fetch(request: Request): Promise<Response> {',
      ].join('\n'),
    })

    const out = writes.join('')
    expect(out).toContain('Read ~/Documents/tiktok-portal/api/jobs/index.ts (ok)')
    expect(out).toContain('Read ~/Documents/tiktok-portal/api/approvals/\\[token\\].ts (ok)')
    expect(out.match(/Number of characters:/g)).toHaveLength(2)
    expect(out).not.toContain('requireN8nAuth')
    expect(out).not.toContain('approvePost')
    expect(out).not.toContain('async fetch')
  })

  it('keeps failed Bash file-read errors visible', () => {
    handleCompleted({
      type: 'command_execution',
      command: 'head -40 ~/Documents/tiktok-portal/api/approvals/[token].ts',
      exit_code: 1,
      aggregated_output: '(eval):1: no matches found: /Users/fernandi/Documents/tiktok-portal/api/approvals/[token].ts',
    })

    const out = writes.join('')
    expect(out).toContain('Read ~/Documents/tiktok-portal/api/approvals/[token].ts (exit 1)')
    expect(out).toContain('no matches found')
    expect(out).toContain('/Users/fernandi/Documents/tiktok-portal/api/approvals/[token].ts')
  })

  it('uses the fallback summary for unknown inspection-style Codex commands', () => {
    handleCompleted({
      type: 'command_execution',
      command: 'if test -d apps; then find apps -type f; fi',
      exit_code: 0,
      aggregated_output: 'apps/web/src/main.tsx\napps/web/src/App.tsx',
    })

    const out = writes.join('')
    expect(out).toContain('Inspect if test -d apps; then find apps -type f; fi (ok)')
    expect(out).toContain('Content read.')
    expect(out).not.toContain('apps/web/src/main.tsx')
  })

  it('summarizes listing and grep output without displaying its contents', () => {
    handleCompleted({
      type: 'command_execution',
      command: 'ls apps/web',
      exit_code: 0,
      aggregated_output: 'src\nvite.config.ts',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'find apps -name "*.ts"',
      exit_code: 0,
      aggregated_output: 'apps/a.ts\napps/b.ts',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'rg "secret" apps',
      exit_code: 0,
      aggregated_output: 'apps/a.ts:secret\napps/b.ts:secret',
    })
    const out = writes.join('')
    expect(out).toContain('List apps/web (ok)')
    expect(out).toContain('Glob apps -name "*.ts" (ok)')
    expect(out).toContain('Grep "secret" apps (ok)')
    expect(out).toContain('Number of files: 2')
    expect(out).toContain('Number of matches: 2')
    expect(out).not.toContain('vite.config.ts')
    expect(out).not.toContain('apps/a.ts')
    expect(out).not.toContain('apps/a.ts:secret')
  })

  it('keeps ordinary command output visible and inspection errors visible', () => {
    handleCompleted({
      type: 'command_execution',
      command: 'npm run test',
      exit_code: 0,
      aggregated_output: 'pass\nsecond line',
    })
    handleCompleted({
      type: 'command_execution',
      command: 'cat missing.md',
      exit_code: 1,
      aggregated_output: 'cat: missing.md: No such file or directory',
    })
    const out = writes.join('')
    expect(out).toContain('command npm run test (ok)')
    expect(out).toContain('pass')
    expect(out).toContain('second line')
    expect(out).toContain('Read missing.md (exit 1)')
    expect(out).toContain('No such file or directory')
  })

  it('does not print an empty output block for inspection command failures', () => {
    handleCompleted({
      type: 'command_execution',
      command: 'cat missing.md',
      exit_code: 1,
      aggregated_output: '   ',
    })
    const out = writes.join('')
    expect(out).toContain('Read missing.md (exit 1)')
    expect(out).not.toContain('output')
  })

  it('prints file changes and defaults missing fields', () => {
    handleCompleted({
      type: 'file_change',
      changes: [
        { kind: 'add', path: 'new.ts' },
        { path: 'updated.ts' },
        {},
      ],
    })
    handleCompleted({ type: 'file_change', changes: 'not-array' })
    handleCompleted({ type: 'unknown' })
    const out = writes.join('')
    expect(out).toContain('file add new.ts')
    expect(out).toContain('file update updated.ts')
    expect(out).toContain('file update')
  })

  it('prints turn usage and defaults missing usage to zeroes', () => {
    handleLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }))
    handleLine(JSON.stringify({ type: 'turn.completed' }))
    const out = writes.join('')
    expect(out).toContain('turn done (7 in / 3 out)')
    expect(out).toContain('turn done (0 in / 0 out)')
  })
})
