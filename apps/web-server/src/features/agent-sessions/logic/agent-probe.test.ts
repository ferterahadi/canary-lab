import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  createAgentProbeService,
  probeAgents,
  type AgentProbeDeps,
  type ProbeExec,
} from './agent-probe'

// Deterministic resolver: both CLIs "installed" at fixed paths unless a test
// drops one. The subprocess is the genuinely un-unit-testable edge here, so
// exec is the injected seam — everything else is real logic.
function resolveDeps(found: { claude?: boolean; codex?: boolean } = {}): AgentProbeDeps['resolve'] {
  return {
    which: (agent) => ((found[agent as 'claude' | 'codex'] ?? true) ? `/opt/bin/${agent}` : null),
    isExecutable: () => false,
    env: {},
    homedir: () => '/home/none',
  }
}

const loggedInExec: ProbeExec = async (binary, args) => {
  if (args[0] === '--version') return { ok: true, stdout: `${binary.includes('claude') ? '2.1.250' : 'codex-cli 0.149.0'}\n` }
  if (binary.includes('claude')) return { ok: true, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' }
  return { ok: true, stdout: 'Logged in using ChatGPT' }
}

describe('probeAgents', () => {
  it('reports ok with binary path and version when installed and signed in', async () => {
    const snap = await probeAgents({
      exec: loggedInExec,
      resolve: resolveDeps(),
      now: () => new Date('2026-08-28T00:00:00Z'),
    })
    expect(snap.probedAt).toBe('2026-08-28T00:00:00.000Z')
    expect(snap.claude).toEqual({
      agent: 'claude', state: 'ok', binaryPath: '/opt/bin/claude', version: '2.1.250', remedy: null,
    })
    expect(snap.codex).toEqual({
      agent: 'codex', state: 'ok', binaryPath: '/opt/bin/codex', version: 'codex-cli 0.149.0', remedy: null,
    })
  })

  it('reports missing with an install remedy when the binary is not found', async () => {
    const snap = await probeAgents({ exec: loggedInExec, resolve: resolveDeps({ codex: false }) })
    expect(snap.codex.state).toBe('missing')
    expect(snap.codex.binaryPath).toBeNull()
    expect(snap.codex.remedy).toContain('CANARY_LAB_CODEX_BIN')
    expect(snap.claude.state).toBe('ok')
  })

  it('reads claude as signed out on loggedIn:false, non-JSON output, or a failed exit', async () => {
    for (const auth of [
      { ok: true, stdout: '{"loggedIn": false}' },
      { ok: true, stdout: 'not json' },
      { ok: false, stdout: '' },
    ]) {
      const exec: ProbeExec = async (_bin, args) =>
        args[0] === '--version' ? { ok: true, stdout: '2.1.250' } : auth
      const snap = await probeAgents({ exec, resolve: resolveDeps({ codex: false }) })
      expect(snap.claude.state).toBe('auth')
      // The version still reports — a signed-out CLI is installed, and the
      // warning strip should say which build needs the sign-in.
      expect(snap.claude.version).toBe('2.1.250')
      expect(snap.claude.remedy).toContain('sign in')
    }
  })

  it('reads codex auth from the login-status exit code', async () => {
    const exec: ProbeExec = async (_bin, args) =>
      args[0] === '--version' ? { ok: true, stdout: 'codex-cli 0.149.0' } : { ok: false, stdout: 'Not logged in' }
    const snap = await probeAgents({ exec, resolve: resolveDeps({ claude: false }) })
    expect(snap.codex.state).toBe('auth')
    expect(snap.codex.remedy).toContain('codex login')
  })

  it('treats a failed --version as unknown version, not a failed probe', async () => {
    const exec: ProbeExec = async (bin, args) => {
      if (args[0] === '--version') return { ok: false, stdout: '' }
      return loggedInExec(bin, args)
    }
    const snap = await probeAgents({ exec, resolve: resolveDeps() })
    expect(snap.claude.state).toBe('ok')
    expect(snap.claude.version).toBeNull()
  })

  it('treats blank --version output as unknown version', async () => {
    const exec: ProbeExec = async (bin, args) => {
      if (args[0] === '--version') return { ok: true, stdout: '\n' }
      return loggedInExec(bin, args)
    }
    const snap = await probeAgents({ exec, resolve: resolveDeps() })
    expect(snap.claude.version).toBeNull()
  })

  it('default exec runs the real binary: a stub CLI answers auth + version, a crashing one reads as signed out', async () => {
    // No injected exec — the real execFile path against real executables in a
    // tmpdir. The stub speaks both probe dialects (auth status / --version).
    const dir = mkdtempSync(join(tmpdir(), 'canary-probe-'))
    const good = join(dir, 'claude')
    writeFileSync(good, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9"; else echo \'{"loggedIn": true}\'; fi\n')
    chmodSync(good, 0o755)
    const bad = join(dir, 'codex')
    writeFileSync(bad, '#!/bin/sh\nexit 3\n')
    chmodSync(bad, 0o755)

    const snap = await probeAgents({
      resolve: { which: () => null, isExecutable: () => true, env: { CANARY_LAB_CLAUDE_BIN: good, CANARY_LAB_CODEX_BIN: bad }, homedir: () => dir },
    })
    expect(snap.claude).toEqual({ agent: 'claude', state: 'ok', binaryPath: good, version: '9.9.9', remedy: null })
    // Every invocation of the bad stub fails → no version, signed-out verdict.
    expect(snap.codex.state).toBe('auth')
    expect(snap.codex.version).toBeNull()
  })
})

describe('createAgentProbeService', () => {
  function countingDeps() {
    let calls = 0
    let nowMs = 0
    const exec: ProbeExec = async (bin, args) => {
      if (args[0] !== '--version') calls += 1
      return loggedInExec(bin, args)
    }
    return {
      execCalls: () => calls,
      advance: (ms: number) => { nowMs += ms },
      deps: { exec, resolve: resolveDeps(), now: () => new Date(nowMs), ttlMs: 30_000 },
    }
  }

  it('serves the cached snapshot inside the TTL and re-probes after it', async () => {
    const h = countingDeps()
    const service = createAgentProbeService(h.deps)
    const first = await service.snapshot()
    expect(await service.snapshot()).toBe(first)
    expect(h.execCalls()).toBe(2) // one auth check per agent

    h.advance(30_001)
    const second = await service.snapshot()
    expect(second).not.toBe(first)
    expect(h.execCalls()).toBe(4)
  })

  it('force skips a fresh cache — the UI re-check button', async () => {
    const h = countingDeps()
    const service = createAgentProbeService(h.deps)
    await service.snapshot()
    await service.snapshot(true)
    expect(h.execCalls()).toBe(4)
  })

  it('concurrent cold opens share one probe instead of stacking subprocesses', async () => {
    const h = countingDeps()
    const service = createAgentProbeService(h.deps)
    const [a, b] = await Promise.all([service.snapshot(), service.snapshot()])
    expect(a).toBe(b)
    expect(h.execCalls()).toBe(2)
  })

  it('defaults ttl and clock when not injected — the production construction', async () => {
    const h = countingDeps()
    const service = createAgentProbeService({ exec: h.deps.exec, resolve: h.deps.resolve })
    const first = await service.snapshot()
    // A real-clock second call lands inside the 30s default TTL.
    expect(await service.snapshot()).toBe(first)
    expect(h.execCalls()).toBe(2)
    expect(Date.parse(first.probedAt)).toBeGreaterThan(0)
  })
})
