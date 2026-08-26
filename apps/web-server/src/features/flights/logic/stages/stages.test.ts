import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

// Transparent pass-through by default — every other test in this file spawns
// real processes (fake npx/claude binaries on PATH). Only the one test below
// that needs to control child-process event ordering deterministically
// installs an override via setMockSpawn.
const { getMockSpawn, setMockSpawn } = vi.hoisted(() => {
  let impl: ((...args: unknown[]) => unknown) | null = null
  return {
    getMockSpawn: () => impl,
    setMockSpawn: (fn: ((...args: unknown[]) => unknown) | null) => { impl = fn },
  }
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const impl = getMockSpawn()
      return impl ? impl(...args) : (actual.spawn as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import { defaultSpawnAgent, extractJson, pollUntil, PollTimeoutError } from './context'
import { agentJobStore } from '../../../agent-sessions/logic/agent-jobs/store'
import { stopAgentProcesses } from '../../../agent-sessions/logic/agent-process'

let tmpDir: string

let featuresDir: string

let logsDir: string

let repoDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-flight-stages-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  repoDir = path.join(tmpDir, 'product-repo')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
})

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('context helpers', () => {
  function fakeAgentScript(body: string): string {
    const script = path.join(tmpDir, `fake-claude-${Math.random().toString(36).slice(2)}.sh`)
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(script, 0o755)
    return script
  }

  const ORIGINAL_CLAUDE_BIN = process.env.CANARY_LAB_CLAUDE_BIN
  afterEach(() => {
    if (ORIGINAL_CLAUDE_BIN === undefined) delete process.env.CANARY_LAB_CLAUDE_BIN
    else process.env.CANARY_LAB_CLAUDE_BIN = ORIGINAL_CLAUDE_BIN
  })

  describe('defaultSpawnAgent', () => {
    it('writes a durable record for a claude spawn, joined to its pinned session', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo \'{"type":"result","result":"ok"}\'')
      const stageDir = path.join(tmpDir, 'stage-rec')
      fs.mkdirSync(stageDir, { recursive: true })
      const onAgentSession = vi.fn()
      await defaultSpawnAgent({
        prompt: 'p', cwd: tmpDir, stageDir,
        job: { flightId: 'fl-1', feature: 'checkout', stage: 'scout', logsDir },
        onAgentSession,
      })
      const rec = agentJobStore(logsDir).get('fl-1:scout')!
      expect(rec).toMatchObject({ status: 'done', flightId: 'fl-1', stage: 'scout', agent: 'claude' })
      // The pinned session id is the join to the transcript — same id the
      // agent-session ref carries, so a row and its timeline agree.
      const ref = JSON.parse(fs.readFileSync(path.join(stageDir, 'agent-session.json'), 'utf-8'))
      expect(rec.sessionId).toBe(ref.sessions.claude.sessionId)
      expect(onAgentSession).toHaveBeenCalledWith({
        agent: 'claude',
        sessionId: ref.sessions.claude.sessionId,
        spawnedAt: expect.any(String),
      })
    })

    it('records a codex spawn, which pins no session id', async () => {
      process.env.CANARY_LAB_CODEX_BIN = fakeAgentScript('echo "codex answer"')
      const stageDir = path.join(tmpDir, 'stage-rec-codex')
      fs.mkdirSync(stageDir, { recursive: true })
      await defaultSpawnAgent({
        prompt: 'p', cwd: tmpDir, stageDir, agent: 'codex',
        job: { flightId: 'fl-1', feature: 'checkout', stage: 'docs', logsDir },
      })
      const rec = agentJobStore(logsDir).get('fl-1:docs')!
      expect(rec).toMatchObject({ status: 'done', agent: 'codex' })
      expect(rec.sessionId).toBeUndefined()
      delete process.env.CANARY_LAB_CODEX_BIN
    })

    it('reports a STOPPED agent as stopped, not as one that answered badly', async () => {
      // The live-proof finding, and the reason it took two attempts. A scout
      // stopped from the UI recorded "agent did not return parseable JSON" —
      // blaming the agent for a decision the user made. The first fix keyed off
      // the exit SIGNAL and did nothing, because the real claude CLI handles
      // SIGTERM and exits cleanly. Only the stop REQUEST is reliable, so this
      // fake exits 0 with partial output, exactly as the real one did.
      // `exec node` on purpose: a `sleep` child would OUTLIVE the killed shell and
      // hold its stdio pipes open, so `close` never fires and the stop hangs — the
      // same grandchild leak this batch measured. exec leaves no grandchild.
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript(
        'exec node -e \'console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"I will survey it myself."}]}})); setInterval(()=>{},1000)\'',
      )
      const stageDir = path.join(tmpDir, 'stage-stopped')
      fs.mkdirSync(stageDir, { recursive: true })
      const pending = defaultSpawnAgent({ prompt: 'p', cwd: tmpDir, stageDir, job: { flightId: 'fl-s', feature: 'f', stage: 'scout', logsDir } })
      await new Promise((r) => setTimeout(r, 400))
      // Short grace: a plain `sh` fake defers SIGTERM while it sleeps, so the
      // escalation is what actually ends it. The real CLI exits on its own.
      await stopAgentProcesses(stageDir, { by: 'user', graceMs: 50 })
      await expect(pending).rejects.toThrow(/agent was stopped \(by user\) before it finished/)
      // And the record agrees about WHO asked.
      expect(agentJobStore(logsDir).get('fl-s:scout')).toMatchObject({ status: 'stopped', stoppedBy: 'user' })
    })

    it('recovers the final text on a clean exit and writes the agent-session ref', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo \'{"type":"result","result":"hello from claude"}\'')
      const stageDir = path.join(tmpDir, 'stage-ok')
      fs.mkdirSync(stageDir, { recursive: true })
      const result = await defaultSpawnAgent({ prompt: 'do the thing', cwd: tmpDir, stageDir })
      expect(result.text).toBe('hello from claude')
      const ref = JSON.parse(fs.readFileSync(path.join(stageDir, 'agent-session.json'), 'utf-8'))
      expect(ref.activeAgent).toBe('claude')
      expect(ref.sessions.claude.sessionId).toEqual(expect.any(String))
    })

    it('forwards stderr chunks to onChunk', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo "warn: something" 1>&2\necho \'{"type":"result","result":"ok"}\'')
      const stageDir = path.join(tmpDir, 'stage-stderr')
      fs.mkdirSync(stageDir, { recursive: true })
      const chunks: string[] = []
      const result = await defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir, onChunk: (t) => chunks.push(t) })
      expect(result.text).toBe('ok')
      expect(chunks.join('')).toContain('warn: something')
    })

    it('throws when the agent exits non-zero with no recoverable text', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo "boom" 1>&2\nexit 7')
      const stageDir = path.join(tmpDir, 'stage-fail')
      fs.mkdirSync(stageDir, { recursive: true })
      await expect(defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir })).rejects.toThrow(/agent exited with code 7/)
    })

    it('throws a plain message (no stderr excerpt) when the agent exits non-zero silently', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('exit 9')
      const stageDir = path.join(tmpDir, 'stage-fail-silent')
      fs.mkdirSync(stageDir, { recursive: true })
      await expect(defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir })).rejects.toThrow('agent exited with code 9')
    })

    it('names the signal when the agent is killed, instead of "exited with code null"', async () => {
      // Deliberate wording change: a signalled agent was STOPPED, and the old
      // message ("exited with code null") read like a crash with a missing code.
      // Which it also is — but a stage error is what a user reads to find out what
      // happened, and "stopped" is the true answer whenever a signal is involved.
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('kill -TERM $$\nsleep 5')
      const stageDir = path.join(tmpDir, 'stage-fail-signal')
      fs.mkdirSync(stageDir, { recursive: true })
      await expect(defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir }))
        .rejects.toThrow(/agent was stopped \(SIGTERM\) before it finished/)
    })

    it('does not throw when the agent exits non-zero but still produced usable text', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('echo \'{"type":"result","result":"partial answer"}\'\nexit 3')
      const stageDir = path.join(tmpDir, 'stage-partial')
      fs.mkdirSync(stageDir, { recursive: true })
      const result = await defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir })
      expect(result.text).toBe('partial answer')
    })

    it('throws StageCancelledError immediately when the signal is already aborted (never spawns)', async () => {
      const stageDir = path.join(tmpDir, 'stage-pre-aborted')
      fs.mkdirSync(stageDir, { recursive: true })
      const controller = new AbortController()
      controller.abort()
      await expect(
        defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir, signal: controller.signal }),
      ).rejects.toThrow('agent spawn cancelled by flight pause/abort')
      // Never spawned — no agent-session ref was ever written.
      expect(fs.existsSync(path.join(stageDir, 'agent-session.json'))).toBe(false)
    })

    it('throws StageCancelledError when the signal is aborted mid-flight (SIGTERMs the agent)', async () => {
      process.env.CANARY_LAB_CLAUDE_BIN = fakeAgentScript('sleep 5')
      const stageDir = path.join(tmpDir, 'stage-abort-midflight')
      fs.mkdirSync(stageDir, { recursive: true })
      const controller = new AbortController()
      const result = defaultSpawnAgent({ prompt: 'x', cwd: tmpDir, stageDir, signal: controller.signal })
      controller.abort()
      await expect(result).rejects.toThrow('agent spawn cancelled by flight pause/abort')
    })
  })

  describe('extractJson', () => {
    it('parses a fenced JSON block', () => {
      expect(extractJson<{ a: number }>('here:\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 })
    })

    it('falls back to bare braces when there is no fence', () => {
      expect(extractJson<{ a: number }>('answer is {"a":2} done')).toEqual({ a: 2 })
    })

    it('recovers the fenced JSON even when a later turn only adds prose', () => {
      // All-turns transcript: config fence first, then a chatter sign-off with
      // no fence. The fence must still win (the crash this fixed).
      const transcript = 'here is the config:\n```json\n{"a":3}\n```\nAlready delivered the final JSON above — that trailing find was leftover.'
      expect(extractJson<{ a: number }>(transcript)).toEqual({ a: 3 })
    })

    it('prefers the LAST fence when several are present', () => {
      const transcript = '```json\n{"a":1}\n```\nreasoning…\n```json\n{"a":2}\n```'
      expect(extractJson<{ a: number }>(transcript)).toEqual({ a: 2 })
    })

    it('throws with an excerpt when nothing parses', () => {
      expect(() => extractJson('no json here at all')).toThrow(/did not return parseable JSON/)
    })
  })

  describe('pollUntil', () => {
    it('throws PollTimeoutError when the deadline passes before settling', async () => {
      await expect(
        pollUntil(async () => 'pending', () => false, { what: 'thing', timeoutMs: 1, intervalMs: 1 }),
      ).rejects.toThrow(PollTimeoutError)
    })

    it('resolves as soon as the predicate settles', async () => {
      let calls = 0
      const value = await pollUntil(
        async () => { calls += 1; return calls },
        (v) => v >= 2,
        { what: 'thing', timeoutMs: 5000, intervalMs: 1 },
      )
      expect(value).toBe(2)
    })

    it('throws StageCancelledError immediately when the signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        pollUntil(async () => 'x', () => true, { what: 'thing', timeoutMs: 5000, signal: controller.signal }),
      ).rejects.toThrow('thing cancelled by flight pause/abort')
    })

    it('cancels the interval wait immediately when the signal aborts mid-wait', async () => {
      const controller = new AbortController()
      const promise = pollUntil(
        async () => 'pending',
        () => false, // never settles on its own
        { what: 'thing', timeoutMs: 10_000, intervalMs: 10_000, signal: controller.signal },
      )
      // Let the poll loop reach its interval wait (setTimeout + abort listener
      // registered) before aborting — well short of the 10s interval/timeout.
      await new Promise((resolve) => setTimeout(resolve, 10))
      controller.abort()
      await expect(promise).rejects.toThrow('thing cancelled by flight pause/abort')
    })

    it('progressKey: a changing key extends the deadline past timeoutMs (idle budget, not wall-clock)', async () => {
      // Each poll reports a NEW phase — the job outruns timeoutMs but never
      // idles, so it must survive until settled. (The k7ru regression: a
      // 45m two-attempt portify was killed by a 30m wall-clock cap.)
      let polls = 0
      const value = await pollUntil(
        async () => { polls += 1; return polls },
        (v) => v >= 5,
        { what: 'thing', timeoutMs: 30, intervalMs: 10, progressKey: (v) => `phase-${v}` },
      )
      expect(value).toBe(5) // 5 polls × 10ms interval > 30ms timeout — survived on progress
    })

    it('progressKey: a FROZEN key still dies after timeoutMs, with the idle wording', async () => {
      await expect(
        pollUntil(async () => 'stuck', () => false, {
          what: 'thing', timeoutMs: 20, intervalMs: 5, progressKey: () => 'same-phase',
        }),
      ).rejects.toThrow(/made no progress within/)
    })
  })
})
