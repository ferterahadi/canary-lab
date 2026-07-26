import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AgentSessionRefStore } from './agent-session-refs'

// This pointer is the only thing that makes a finished heal cycle re-readable
// in the UI, and a wrong one fails silently — the run looks fine and the agent
// view is blank later. So the round trip, the cache, and every "nothing to
// point at" path are pinned here rather than only exercised by a live cycle.

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

function makeStore(): { store: AgentSessionRefStore; runDir: string; refPath: string; idPath: string } {
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-asr-')))
  dirs.push(runDir)
  const refPath = path.join(runDir, 'agent-session.json')
  const idPath = path.join(runDir, 'agent-session-id')
  return {
    store: new AgentSessionRefStore({ runDir, agentSessionRefPath: refPath, agentSessionIdPath: idPath }),
    runDir,
    refPath,
    idPath,
  }
}

// Session ids must be UUIDs: readPriorSessionIdFromValue validates the shape
// before handing one to `claude --resume` / `codex resume`.
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
const CODEX_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const claudeRef = { agent: 'claude' as const, sessionId: CLAUDE_ID, logPath: '/logs/claude.jsonl' }

describe('AgentSessionRefStore.read', () => {
  it('reads as null when the file does not exist', () => {
    expect(makeStore().store.read()).toBeNull()
  })

  it('reads as null when the file is not valid JSON', () => {
    const { store, refPath } = makeStore()
    fs.writeFileSync(refPath, 'not json at all')

    expect(store.read()).toBeNull()
  })

  it('serves the cached value once seeded rather than re-reading disk', () => {
    const { store, refPath } = makeStore()
    expect(store.read()).toBeNull()

    // A file appearing after the first read must not be picked up: the store is
    // the only writer, so anything else touching it is not a source of truth.
    fs.writeFileSync(refPath, JSON.stringify({ sessions: { claude: claudeRef } }))
    expect(store.read()).toBeNull()
  })
})

describe('AgentSessionRefStore.write', () => {
  it('round-trips a ref and records the active agent', () => {
    const { store, refPath, idPath } = makeStore()

    store.write(claudeRef)

    expect(JSON.parse(fs.readFileSync(refPath, 'utf-8'))).toEqual({
      activeAgent: 'claude',
      sessions: { claude: claudeRef },
    })
    // The flat id file is what `codex resume <id>` / `claude --resume` read.
    expect(fs.readFileSync(idPath, 'utf-8')).toBe(CLAUDE_ID)
    expect(store.read()?.sessions.claude).toEqual(claudeRef)
  })

  it('keeps the other agent\'s session when a second agent takes over', () => {
    const { store } = makeStore()
    const codexRef = { agent: 'codex' as const, sessionId: CODEX_ID, logPath: '/logs/codex.jsonl' }

    store.write(claudeRef)
    store.write(codexRef)

    const file = store.read()
    expect(file?.activeAgent).toBe('codex')
    // Losing the earlier agent's ref would break the cross-agent handoff.
    expect(file?.sessions.claude).toEqual(claudeRef)
    expect(file?.sessions.codex).toEqual(codexRef)
  })

  it('is best-effort when the ref file cannot be written', () => {
    const { store, runDir, refPath } = makeStore()
    fs.chmodSync(runDir, 0o500)
    try {
      expect(() => store.write(claudeRef)).not.toThrow()
      expect(fs.existsSync(refPath)).toBe(false)
    } finally {
      fs.chmodSync(runDir, 0o700)
    }
  })
})

describe('AgentSessionRefStore.persistActive', () => {
  it('writes nothing when claude has no session id yet', () => {
    const { store, refPath } = makeStore()

    store.persistActive({ agent: 'claude' })

    expect(fs.existsSync(refPath)).toBe(false)
  })

  it('writes nothing when codex has no start timestamp yet', () => {
    const { store, refPath } = makeStore()

    store.persistActive({ agent: 'codex' })

    expect(fs.existsSync(refPath)).toBe(false)
  })

  it('records the codex log the locator discovers for this run dir', () => {
    // codex's first launch takes no --session-id, so the id is only learnable
    // by scanning its own session dir for a log whose cwd is this run.
    const { store, runDir, refPath, idPath } = makeStore()
    const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-codex-')))
    dirs.push(codexHome)
    const startedAt = '2026-07-26T12:00:00.000Z'
    const day = path.join(codexHome, 'sessions', '2026', '07', '26')
    fs.mkdirSync(day, { recursive: true })
    const logPath = path.join(day, 'rollout.jsonl')
    fs.writeFileSync(logPath, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: CODEX_ID, cwd: runDir, timestamp: '2026-07-26T12:00:05.000Z' },
    })}\n`)

    const prev = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    try {
      store.persistActive({ agent: 'codex', startedAt })
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }

    expect(JSON.parse(fs.readFileSync(refPath, 'utf-8')).sessions.codex).toEqual({
      agent: 'codex',
      sessionId: CODEX_ID,
      logPath,
    })
    expect(fs.readFileSync(idPath, 'utf-8')).toBe(CODEX_ID)
  })

  it('writes nothing when codex has a start time but no matching log', () => {
    const { store, refPath } = makeStore()

    store.persistActive({ agent: 'codex', startedAt: '2026-07-26T12:00:00.000Z' })

    expect(fs.existsSync(refPath)).toBe(false)
  })

  it('writes nothing when the locator cannot find a log for the session', () => {
    // The predicted claude log path does not exist under this run dir, which is
    // the ordinary "agent never really started" case — it must not write a ref
    // pointing at a file that isn't there.
    const { store, refPath } = makeStore()

    store.persistActive({ agent: 'claude', sessionId: 'no-such-session' })

    expect(fs.existsSync(refPath)).toBe(false)
  })
})

describe('AgentSessionRefStore.priorSessionId', () => {
  it('returns the id from a stored typed ref', () => {
    const { store } = makeStore()
    store.write(claudeRef)

    expect(store.priorSessionId('claude')).toBe(CLAUDE_ID)
  })

  it('falls back to the flat id file written by older runs', () => {
    const { store, idPath } = makeStore()
    fs.writeFileSync(idPath, `${CODEX_ID}\n`)

    expect(store.priorSessionId('claude')).toBe(CODEX_ID)
  })

  it('returns null when the agent has never run here', () => {
    expect(makeStore().store.priorSessionId('codex')).toBeNull()
  })

  it('does not use the flat id file once a ref file exists for the other agent', () => {
    const { store, idPath } = makeStore()
    store.write(claudeRef)
    fs.writeFileSync(idPath, CODEX_ID)

    // A ref file exists, so the legacy path is skipped — resuming codex from
    // claude's id would attach the wrong conversation.
    expect(store.priorSessionId('codex')).toBeNull()
  })
})

describe('AgentSessionRefStore cross-agent handoff', () => {
  it('finds the other agent\'s ref', () => {
    const { store } = makeStore()
    store.write(claudeRef)

    expect(store.findPriorRef('codex')).toEqual(claudeRef)
    // The target agent's own ref is not "prior" context for itself.
    expect(store.findPriorRef('claude')).toBeNull()
  })

  it('reports no context when the other agent never ran', () => {
    expect(makeStore().store.crossAgentContext('claude')).toBeUndefined()
  })

  it('reports no context when the other agent\'s log cannot be rendered', () => {
    const { store } = makeStore()
    store.write(claudeRef) // logPath points at a file that does not exist

    expect(store.crossAgentContext('codex')).toBeUndefined()
  })
})
