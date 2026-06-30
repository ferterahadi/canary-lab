import { describe, it, expect, vi } from 'vitest'
import { hydrateAgentConfigEnvFromShell } from './agent-config-env'

// Build a fake interactive-shell probe that echoes the given values fenced by
// the same markers the real probe emits. Captures the args it was called with.
function fakeProbe(values: Record<string, string>) {
  const calls: Array<{ shell: string; args: string[]; timeoutMs: number }> = []
  const run = (shell: string, args: string[], timeoutMs: number): string => {
    calls.push({ shell, args, timeoutMs })
    // The real shell only echoes vars our script asked for; mirror that by
    // reading the var names out of the printf script (`"$VARNAME"` refs).
    const script = args[args.length - 1]
    const names = [...script.matchAll(/"\$([A-Z_]+)"/g)].map((m) => m[1])
    const body = names.map((n) => `${n}=${values[n] ?? ''}`).join('\n')
    return `noise from rc file\n__CL_ENV_START__\n${body}\n__CL_ENV_END__\ntrailing noise\n`
  }
  return { run, calls }
}

describe('hydrateAgentConfigEnvFromShell', () => {
  it('skips the shell entirely when both vars are already in the env', () => {
    const env = { CLAUDE_CONFIG_DIR: '/a', CODEX_HOME: '/b' }
    const run = vi.fn()
    const hydrated = hydrateAgentConfigEnvFromShell({ env, run })
    expect(hydrated).toEqual({})
    expect(run).not.toHaveBeenCalled()
  })

  it('back-fills a var the rc file sets but the launching env lacks', () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh' }
    const { run } = fakeProbe({ CLAUDE_CONFIG_DIR: '/home/me/.config/claude', CODEX_HOME: '/home/me/.config/codex' })
    const hydrated = hydrateAgentConfigEnvFromShell({ env, run })
    expect(hydrated).toEqual({
      CLAUDE_CONFIG_DIR: '/home/me/.config/claude',
      CODEX_HOME: '/home/me/.config/codex',
    })
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/me/.config/claude')
    expect(env.CODEX_HOME).toBe('/home/me/.config/codex')
  })

  it('only probes for the missing var, leaving the present one untouched', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/already/set' }
    const { run, calls } = fakeProbe({ CODEX_HOME: '/from/rc' })
    const hydrated = hydrateAgentConfigEnvFromShell({ env, run })
    expect(hydrated).toEqual({ CODEX_HOME: '/from/rc' })
    expect(env.CLAUDE_CONFIG_DIR).toBe('/already/set') // unchanged
    // The probe script asked only about CODEX_HOME.
    expect(calls[0].args[calls[0].args.length - 1]).toContain('CODEX_HOME')
    expect(calls[0].args[calls[0].args.length - 1]).not.toContain('CLAUDE_CONFIG_DIR=')
  })

  it('does not set a var the rc file leaves empty', () => {
    const env: NodeJS.ProcessEnv = {}
    const { run } = fakeProbe({ CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' })
    const hydrated = hydrateAgentConfigEnvFromShell({ env, run })
    expect(hydrated).toEqual({})
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false)
    expect('CODEX_HOME' in env).toBe(false)
  })

  it('spawns the interactive shell ($SHELL) with -i -c and a timeout', () => {
    const env: NodeJS.ProcessEnv = { SHELL: '/bin/zsh' }
    const { run, calls } = fakeProbe({ CLAUDE_CONFIG_DIR: '/x', CODEX_HOME: '/y' })
    hydrateAgentConfigEnvFromShell({ env, run, timeoutMs: 1234 })
    expect(calls[0].shell).toBe('/bin/zsh')
    expect(calls[0].args.slice(0, 2)).toEqual(['-i', '-c'])
    expect(calls[0].timeoutMs).toBe(1234)
  })

  it('leaves the env unchanged when the probe fails (returns null)', () => {
    const env: NodeJS.ProcessEnv = {}
    const hydrated = hydrateAgentConfigEnvFromShell({ env, run: () => null })
    expect(hydrated).toEqual({})
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false)
  })

  it('treats a whitespace-only existing value as missing', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '   ', CODEX_HOME: '/set' }
    const { run } = fakeProbe({ CLAUDE_CONFIG_DIR: '/from/rc' })
    const hydrated = hydrateAgentConfigEnvFromShell({ env, run })
    expect(hydrated).toEqual({ CLAUDE_CONFIG_DIR: '/from/rc' })
  })
})
