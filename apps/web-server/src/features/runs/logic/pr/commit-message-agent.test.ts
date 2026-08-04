import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMMIT_MESSAGE_IDLE_TIMEOUT_MS,
  MAX_DIFF_CHARS,
  bulletList,
  clipDiff,
  failureEvidenceSection,
  parseFixCommitMessage,
  runCommitMessageAgent,
  writeFixCommitMessage,
} from './commit-message-agent'

// The two I/O edges: which agent CLI is installed, and the subprocess itself.
// Everything between them — argv shape, the codex output file, the idle clock,
// abort — is this module's own logic and runs for real.
const hmock = vi.hoisted(() => ({ agent: 'claude' as string | null }))
vi.mock('../runtime/auto-heal', async (importOriginal) => ({
  ...await importOriginal<typeof import('../runtime/auto-heal')>(),
  pickAvailableHealAgent: vi.fn(() => hmock.agent),
}))

interface SpawnCall { command: string; args: string[]; cwd?: string; stdin?: string; activityPath?: string; idleMs?: number }
const amock = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  result: { code: 0 as number | null, signal: null as string | null, stdout: '', stderr: '' },
  /** Never-resolving spawn, so an abort has a live process to interrupt. */
  hang: false,
  /** Hand `done`'s settlers to the test, so an agent can answer AFTER an abort
   *  already rejected the promise — the only route to the double-settle guards. */
  deferred: null as { resolve: (r: unknown) => void; reject: (e: Error) => void } | null,
  /** Fire the idle callback before resolving, as the real runner does. */
  idle: false,
  rejectWith: null as Error | null,
  stops: 0,
  /** Written into the codex `--output-last-message` file before `done` settles. */
  outputFile: null as string | null,
}))
vi.mock('../../../agent-sessions/logic/agent-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agent-sessions/logic/agent-process')>()
  return {
    ...actual,
    runAgentProcess: vi.fn((opts: import('../../../agent-sessions/logic/agent-process').RunAgentProcessOpts) => {
      amock.calls.push({ command: opts.command, args: opts.args, cwd: opts.cwd, stdin: opts.stdin, activityPath: opts.activityPath, idleMs: opts.idleMs })
      if (amock.idle) opts.onIdle?.()
      if (amock.outputFile) {
        const target = opts.args[opts.args.indexOf('--output-last-message') + 1]
        fs.writeFileSync(target, amock.outputFile)
      }
      const done = amock.hang
        ? new Promise<never>(() => { /* a live agent the test aborts */ })
        : amock.deferred
          ? new Promise((resolve, reject) => { amock.deferred = { resolve, reject } })
          : amock.rejectWith
            ? Promise.reject(amock.rejectWith)
            : Promise.resolve({ ...amock.result })
      return { child: { kill: vi.fn() }, done, stop: () => { amock.stops += 1 } }
    }),
  }
})

const roots: string[] = []
beforeEach(() => {
  hmock.agent = 'claude'
  Object.assign(amock, { calls: [], result: { code: 0, signal: null, stdout: '', stderr: '' }, hang: false, deferred: null, idle: false, rejectWith: null, stops: 0, outputFile: null })
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function tmpPatch(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-msg-'))
  roots.push(root)
  const p = path.join(root, 'repo.patch')
  fs.writeFileSync(p, body)
  return p
}

const full = {
  commitSubject: 'fix(catalog): return 404 for unknown product ids',
  commitBody: 'The delete route was never implemented.',
  prTitle: 'Deleting a discontinued product now works',
  prBody: '## What changed\n- server.ts',
}

describe('parseFixCommitMessage', () => {
  it('reads the envelope out of prose around it', () => {
    const output = `Here is my answer:\n\n${JSON.stringify(full)}\n\nHope that helps.`
    expect(parseFixCommitMessage(output)).toEqual(full)
  })

  it('trims the fields', () => {
    const padded = { ...full, commitSubject: `  ${full.commitSubject}  `, prBody: `${full.prBody}\n\n` }
    expect(parseFixCommitMessage(JSON.stringify(padded))).toEqual(full)
  })

  it('rejects a half-filled envelope rather than putting an empty title on a PR', () => {
    // A blank prTitle would reach `gh pr create` verbatim — worse than the
    // deterministic template this replaces.
    expect(parseFixCommitMessage(JSON.stringify({ ...full, prTitle: '   ' }))).toBeNull()
    expect(parseFixCommitMessage(JSON.stringify({ ...full, prBody: '' }))).toBeNull()
    expect(parseFixCommitMessage(JSON.stringify({ ...full, commitBody: undefined }))).toBeNull()
  })

  it('skips a brace-bearing object that is not the answer', () => {
    const decoy = JSON.stringify({ note: 'thinking out loud' })
    expect(parseFixCommitMessage(`${decoy}\n${JSON.stringify(full)}`)).toEqual(full)
  })

  it('returns null on output carrying no JSON at all', () => {
    expect(parseFixCommitMessage('I could not read the diff.')).toBeNull()
    expect(parseFixCommitMessage('')).toBeNull()
  })

  it('ignores a non-object candidate', () => {
    expect(parseFixCommitMessage('[1, 2, 3]')).toBeNull()
    // A fence is the only route to a parseable non-object, since the balanced
    // scan only ever yields `{…}`.
    expect(parseFixCommitMessage('```json\nnull\n```')).toBeNull()
  })

  it('rejects an object that carries no subject at all', () => {
    // Candidates arrive largest-first, so this is the shape reached when the
    // only parseable object in the answer is an aside.
    expect(parseFixCommitMessage('{"note":"thinking out loud"}')).toBeNull()
  })
})

describe('clipDiff', () => {
  it('passes a normal repair through untouched', () => {
    const diff = 'diff --git a/x b/x\n+one line\n'
    expect(clipDiff(diff)).toBe(diff)
  })

  it('clips a runaway diff and says so, so nothing unseen gets described', () => {
    const clipped = clipDiff('x'.repeat(MAX_DIFF_CHARS + 500))
    expect(clipped.length).toBeLessThan(MAX_DIFF_CHARS + 300)
    expect(clipped).toContain('diff clipped')
  })
})

describe('failureEvidenceSection', () => {
  it('is empty when a healed run no longer lists failures', () => {
    // An empty heading would invite the agent to invent content under it.
    expect(failureEvidenceSection([])).toBe('')
  })

  it('names each failing test with its location and the head of its error', () => {
    const out = failureEvidenceSection([
      { name: 'deletes a product', location: 'e2e/catalog.spec.ts:31', error: { message: 'Expected 204\nReceived 405\nmore\nlines\nbeyond' } },
    ])
    expect(out).toContain('## Failing test evidence')
    expect(out).toContain('deletes a product')
    expect(out).toContain('e2e/catalog.spec.ts:31')
    expect(out).toContain('Expected 204')
    expect(out).not.toContain('beyond')
  })

  it('caps the list at ten failures', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ name: `t${i}` }))
    const out = failureEvidenceSection(many)
    expect(out).toContain('`t9`')
    expect(out).not.toContain('`t10`')
  })
})

describe('bulletList', () => {
  it('renders one backticked bullet per file', () => {
    expect(bulletList(['a.ts', 'b.ts'])).toBe('  - `a.ts`\n  - `b.ts`')
  })

  it('says so rather than emitting an empty list', () => {
    expect(bulletList([])).toBe('  - (not recorded)')
  })
})

describe('writeFixCommitMessage', () => {
  const input = {
    feature: 'demo_catalog',
    repoName: 'catalog_service',
    runId: 'r1',
    baseSha: 'abcdef1234567890',
    patchPath: '/nope/missing.patch',
  }

  it('returns null when the patch is gone, without spawning anything', async () => {
    expect(await writeFixCommitMessage(input)).toBeNull()
  })

  it('returns null on an empty patch', async () => {
    expect(await writeFixCommitMessage({ ...input, patchPath: tmpPatch('   \n') })).toBeNull()
  })

  it('returns null when no agent CLI is installed, without reading the patch', async () => {
    hmock.agent = null
    expect(await writeFixCommitMessage({ ...input, patchPath: tmpPatch('diff --git a/x b/x\n') })).toBeNull()
    expect(amock.calls).toHaveLength(0)
  })

  it('renders the prompt with the run facts and returns the parsed envelope', async () => {
    amock.result = { code: 0, signal: null, stdout: JSON.stringify(full), stderr: '' }
    const got = await writeFixCommitMessage({
      ...input,
      patchPath: tmpPatch('diff --git a/server.ts b/server.ts\n+404\n'),
      fileNames: ['server.ts'],
      failed: [{ name: 'deletes a product' }],
    })
    expect(got).toEqual(full)
    const prompt = amock.calls[0].args[amock.calls[0].args.indexOf('-p') + 1]
    expect(prompt).toContain('demo_catalog')
    expect(prompt).toContain('catalog_service')
    expect(prompt).toContain('`server.ts`')
    expect(prompt).toContain('deletes a product')
    // The base sha is shortened for the message, not pasted at full length.
    expect(prompt).toContain('abcdef123456')
    expect(prompt).not.toContain('abcdef1234567890')
  })

  it('says the sha is unknown rather than rendering an empty one', async () => {
    amock.result = { code: 0, signal: null, stdout: JSON.stringify(full), stderr: '' }
    await writeFixCommitMessage({ ...input, baseSha: '', patchPath: tmpPatch('diff --git a/x b/x\n') })
    expect(amock.calls[0].args[amock.calls[0].args.indexOf('-p') + 1]).toContain('unknown')
  })

  it('falls back to null when the spawn fails, rather than throwing at the caller', async () => {
    // The caller writes the deterministic template instead — a dull PR beats none.
    amock.result = { code: 1, signal: null, stdout: '', stderr: 'boom' }
    expect(await writeFixCommitMessage({ ...input, patchPath: tmpPatch('diff --git a/x b/x\n') })).toBeNull()
  })
})

describe('runCommitMessageAgent', () => {
  it('spawns claude read-only with a pinned session and its activity log', async () => {
    amock.result = { code: 0, signal: null, stdout: 'answer', stderr: '' }
    expect(await runCommitMessageAgent('claude', 'write it', '/repo')).toBe('answer')
    const call = amock.calls[0]
    expect(call.command).toBe('claude')
    expect(call.args).toContain('--tools')
    expect(call.cwd).toBe('/repo')
    expect(call.idleMs).toBe(COMMIT_MESSAGE_IDLE_TIMEOUT_MS)
    // A claude spawn with a cwd + session id can be watched for liveness.
    expect(call.activityPath).toBeTruthy()
    // No stdin and no temp dir on this arm — the prompt rides in argv.
    expect(call.stdin).toBeUndefined()
  })

  it('runs without a cwd, and then has no session log to watch', async () => {
    amock.result = { code: 0, signal: null, stdout: 'answer', stderr: '' }
    expect(await runCommitMessageAgent('claude', 'write it')).toBe('answer')
    expect(amock.calls[0].cwd).toBeUndefined()
    expect(amock.calls[0].activityPath).toBeUndefined()
  })

  it('spawns codex sandboxed with the prompt on stdin and reads its answer file', async () => {
    amock.outputFile = 'from the file'
    amock.result = { code: 0, signal: null, stdout: 'ignored stdout', stderr: '' }
    expect(await runCommitMessageAgent('codex', 'write it')).toBe('from the file')
    const call = amock.calls[0]
    expect(call.args.slice(0, 4)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only'])
    expect(call.args).toContain('--output-schema')
    expect(call.stdin).toBe('write it')
  })

  it('keeps stdout when codex wrote a blank answer file', async () => {
    amock.outputFile = '  \n'
    amock.result = { code: 0, signal: null, stdout: 'stdout answer', stderr: '' }
    expect(await runCommitMessageAgent('codex', 'write it')).toBe('stdout answer')
  })

  it('keeps stdout when codex wrote no answer file at all', async () => {
    amock.result = { code: 0, signal: null, stdout: 'stdout answer', stderr: '' }
    expect(await runCommitMessageAgent('codex', 'write it')).toBe('stdout answer')
  })

  it('removes the codex temp dir once it has settled', async () => {
    amock.outputFile = 'answer'
    await runCommitMessageAgent('codex', 'write it')
    const dir = path.dirname(amock.calls[0].args[amock.calls[0].args.indexOf('--output-last-message') + 1])
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('rejects on a silent agent, naming the idle window', async () => {
    amock.idle = true
    await expect(runCommitMessageAgent('claude', 'write it')).rejects.toThrow(`idle for ${COMMIT_MESSAGE_IDLE_TIMEOUT_MS}ms`)
  })

  it('rejects with the exit code and stderr', async () => {
    amock.result = { code: 2, signal: null, stdout: '', stderr: 'no such model' }
    await expect(runCommitMessageAgent('claude', 'write it')).rejects.toThrow(/exit code 2[\s\S]*no such model/)
  })

  it('names the signal when the agent was killed', async () => {
    amock.result = { code: null, signal: 'SIGKILL', stdout: '', stderr: '' }
    await expect(runCommitMessageAgent('claude', 'write it')).rejects.toThrow('failed with SIGKILL')
  })

  it('rejects when the CLI could not be launched at all', async () => {
    amock.rejectWith = new Error('spawn ENOENT')
    await expect(runCommitMessageAgent('claude', 'write it')).rejects.toThrow('commit message agent failed: spawn ENOENT')
  })

  it('stops the agent when the caller aborts mid-flight', async () => {
    amock.hang = true
    const ac = new AbortController()
    const p = runCommitMessageAgent('claude', 'write it', undefined, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow('cancelled')
    expect(amock.stops).toBe(1)
  })

  it('aborts before waiting when the signal is already aborted', async () => {
    amock.hang = true
    await expect(runCommitMessageAgent('claude', 'write it', undefined, AbortSignal.abort())).rejects.toThrow('cancelled')
  })

  // An abort rejects the promise while the process is still alive, so whatever
  // the agent does next must not settle it a second time.
  const armDeferred = (): void => { amock.deferred = { resolve: () => {}, reject: () => {} } }

  it('ignores an answer that arrives after the caller already aborted', async () => {
    armDeferred()
    const ac = new AbortController()
    const p = runCommitMessageAgent('codex', 'write it', undefined, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow('cancelled')
    // The temp dir went with the abort; a late resolve must not try to read it.
    amock.deferred!.resolve({ code: 0, signal: null, stdout: 'late answer', stderr: '' })
    await Promise.resolve()
  })

  it('ignores a spawn error that arrives after the caller already aborted', async () => {
    armDeferred()
    const ac = new AbortController()
    const p = runCommitMessageAgent('claude', 'write it', undefined, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow('cancelled')
    amock.deferred!.reject(new Error('late ENOENT'))
    await Promise.resolve()
  })

  it('ignores an abort that lands after the agent already answered', async () => {
    amock.result = { code: 0, signal: null, stdout: 'answer', stderr: '' }
    const ac = new AbortController()
    expect(await runCommitMessageAgent('claude', 'write it', undefined, ac.signal)).toBe('answer')
    ac.abort()
    expect(amock.stops).toBe(0)
  })
})
