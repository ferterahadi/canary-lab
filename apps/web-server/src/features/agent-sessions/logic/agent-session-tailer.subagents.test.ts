import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from './agent-session-log'
import {
  locatorForAgentInDir,
  refForAgentSpawn,
  tailAgentSession,
} from './agent-session-tailer'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-test-'))
})

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

// Wait for `predicate()` to return true, polling every `interval` ms.
function until(predicate: () => boolean, timeout = 1000, interval = 25): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('until: timeout'))
      setTimeout(check, interval)
    }
    check()
  })
}

describe('tailAgentSession — subagent threads', () => {
  const assistant = (ts: string, text: string) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } })

  it('streams events from a subagent log that appears after the tail starts', async () => {
    const logPath = path.join(tmp, 'sess.jsonl')
    fs.writeFileSync(logPath, `${assistant('2026-07-21T11:00:00.000Z', 'parent')}\n`)
    const updates: Array<{ agentId: string; index: number; text: string }> = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 'sess', logPath },
      onEvent: () => { /* parent stream not under test here */ },
      onSubagentEvent: (u) => updates.push({
        agentId: u.thread.agentId,
        index: u.index,
        text: (u.event as { text?: string }).text ?? '',
      }),
      subagentPollMs: 15,
    })

    // The dir does not exist when the tail starts — it appears mid-flight, the
    // way a real fan-out does.
    const subDir = path.join(tmp, 'sess', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'toolu_1', agentType: 'Explore' }))
    fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'), `${assistant('2026-07-21T11:00:05.000Z', 'child one')}\n`)
    await until(() => updates.length >= 1)
    expect(updates[0]).toMatchObject({ agentId: 'agent-x', index: 0, text: 'child one' })

    // Appending to the child log emits only the new event, at the next index.
    fs.appendFileSync(path.join(subDir, 'agent-x.jsonl'), `${assistant('2026-07-21T11:00:09.000Z', 'child two')}\n`)
    await until(() => updates.length >= 2)
    expect(updates[1]).toMatchObject({ index: 1, text: 'child two' })
    expect(updates.filter((u) => u.text === 'child one')).toHaveLength(1)
    handle.close()
  })

  it('carries the parent tool id so the client can nest the thread', async () => {
    const logPath = path.join(tmp, 's2.jsonl')
    fs.writeFileSync(logPath, `${assistant('2026-07-21T11:00:00.000Z', 'p')}\n`)
    const subDir = path.join(tmp, 's2', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-y.meta.json'), JSON.stringify({ toolUseId: 'toolu_42', agentType: 'Plan' }))
    fs.writeFileSync(path.join(subDir, 'agent-y.jsonl'), `${assistant('2026-07-21T11:00:01.000Z', 'hi')}\n`)
    const seen: string[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's2', logPath },
      onEvent: () => { /* ignore */ },
      onSubagentEvent: (u) => seen.push(u.thread.parentToolId),
      subagentPollMs: 15,
    })
    await until(() => seen.length >= 1)
    expect(seen[0]).toBe('toolu_42')
    handle.close()
  })

  it('never scans for a codex session — codex has no subagent dir', async () => {
    const logPath = path.join(tmp, 'cx.jsonl')
    fs.writeFileSync(logPath, `${JSON.stringify({ type: 'agent_message', payload: { message: 'hi' } })}\n`)
    // A subagent dir shaped like claude's, which must be ignored outright.
    const subDir = path.join(tmp, 'cx', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-c.meta.json'), JSON.stringify({ toolUseId: 'toolu_1' }))
    fs.writeFileSync(path.join(subDir, 'agent-c.jsonl'), `${assistant('2026-07-21T11:00:01.000Z', 'nope')}\n`)
    const subEvents: unknown[] = []

    const handle = tailAgentSession({
      ref: { agent: 'codex', sessionId: 'cx', logPath },
      onEvent: () => { /* parent stream not under test here */ },
      onSubagentEvent: (u) => subEvents.push(u),
      subagentPollMs: 15,
    })
    await new Promise((r) => setTimeout(r, 250))

    expect(subEvents).toEqual([])
    handle.close()
  })

  it('skips a subagent log whose meta has not landed yet, then picks it up', async () => {
    const logPath = path.join(tmp, 's4.jsonl')
    fs.writeFileSync(logPath, `${assistant('2026-07-21T11:00:00.000Z', 'p')}\n`)
    const subDir = path.join(tmp, 's4', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    // Transcript first, meta later — the order a real fan-out can produce.
    fs.writeFileSync(path.join(subDir, 'agent-w.jsonl'), `${assistant('2026-07-21T11:00:01.000Z', 'early')}\n`)
    const seen: string[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's4', logPath },
      onEvent: () => { /* ignore */ },
      onSubagentEvent: (u) => seen.push((u.event as { text?: string }).text ?? ''),
      subagentPollMs: 15,
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(seen).toEqual([])

    fs.writeFileSync(path.join(subDir, 'agent-w.meta.json'), JSON.stringify({ toolUseId: 'toolu_w' }))
    await until(() => seen.length >= 1)
    expect(seen[0]).toBe('early')
    handle.close()
  })

  it('stops scanning once the handle is closed', async () => {
    const logPath = path.join(tmp, 's5.jsonl')
    fs.writeFileSync(logPath, `${assistant('2026-07-21T11:00:00.000Z', 'p')}\n`)
    const subDir = path.join(tmp, 's5', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-v.meta.json'), JSON.stringify({ toolUseId: 'toolu_v' }))
    fs.writeFileSync(path.join(subDir, 'agent-v.jsonl'), `${assistant('2026-07-21T11:00:01.000Z', 'first')}\n`)
    const seen: string[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's5', logPath },
      onEvent: () => { /* ignore */ },
      onSubagentEvent: (u) => seen.push((u.event as { text?: string }).text ?? ''),
      subagentPollMs: 15,
    })
    await until(() => seen.length >= 1)

    handle.close()
    fs.appendFileSync(path.join(subDir, 'agent-v.jsonl'), `${assistant('2026-07-21T11:00:05.000Z', 'after close')}\n`)
    await new Promise((r) => setTimeout(r, 60))

    expect(seen).toEqual(['first'])
  })

  it('does not scan for subagents when no handler is supplied', async () => {
    const logPath = path.join(tmp, 's3.jsonl')
    fs.writeFileSync(logPath, `${assistant('2026-07-21T11:00:00.000Z', 'p')}\n`)
    const subDir = path.join(tmp, 's3', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-z.meta.json'), JSON.stringify({ toolUseId: 't' }))
    fs.writeFileSync(path.join(subDir, 'agent-z.jsonl'), `${assistant('2026-07-21T11:00:01.000Z', 'x')}\n`)
    const events: AgentEvent[] = []
    const handle = tailAgentSession({
      ref: { agent: 'claude', sessionId: 's3', logPath },
      onEvent: (e) => events.push(e),
      subagentPollMs: 15,
    })
    await until(() => events.length >= 1)
    // Parent events still flow; the child's "x" never joins them.
    expect(events.every((e) => (e as { text?: string }).text !== 'x')).toBe(true)
    handle.close()
  })
})
