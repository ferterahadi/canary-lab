import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_UNATTENDED_SETTINGS,
  internalAgentInvocationArgs,
  internalAgentInvocationShellFlags,
  withClaudeUnattendedSettings,
} from './agent-context-policy'

// What a shell hands the CLI for a flag string — one argv entry per line.
function shellArgv(flags: string): string[] {
  return execFileSync('/bin/sh', ['-c', `printf '%s\\n'${flags}`], { encoding: 'utf-8' })
    .split('\n')
    .slice(0, -1)
}

describe('unattended-dialog policy', () => {
  it('is the documented auto-mode-setup off switch', () => {
    expect(CLAUDE_UNATTENDED_SETTINGS).toEqual({ skillOverrides: { 'auto-mode-setup': 'off' } })
  })

  it('travels inline on claude, and the settings file replaces it rather than joining it', () => {
    const inline = internalAgentInvocationArgs('claude')
    expect(inline.filter((arg) => arg === '--settings')).toHaveLength(1)
    expect(JSON.parse(inline[inline.indexOf('--settings') + 1])).toEqual(CLAUDE_UNATTENDED_SETTINGS)

    const withFile = internalAgentInvocationArgs('claude', { claudeSettingsFile: '/runs/r1/iso.json' })
    expect(withFile.filter((arg) => arg === '--settings')).toHaveLength(1)
    expect(withFile[withFile.indexOf('--settings') + 1]).toBe('/runs/r1/iso.json')
  })

  it('leaves codex untouched — it has no such dialog and no --settings flag', () => {
    expect(internalAgentInvocationArgs('codex', { claudeSettingsFile: '/runs/r1/iso.json' })).not.toContain('--settings')
  })

  it('folds into a spawn\'s own settings without losing either side', () => {
    expect(withClaudeUnattendedSettings({ sandbox: { enabled: true } })).toEqual({
      sandbox: { enabled: true },
      skillOverrides: { 'auto-mode-setup': 'off' },
    })
  })
})

describe('internalAgentInvocationShellFlags', () => {
  // The heal REPL command goes through `$SHELL -c`, so the JSON's quotes and
  // braces must reach the CLI as one intact argument.
  it('survives a real shell as the same argv the headless spawns get', () => {
    for (const opts of [{}, { claudeSettingsFile: '/runs/a dir/iso.settings.json' }]) {
      expect(shellArgv(internalAgentInvocationShellFlags('claude', opts)))
        .toEqual(internalAgentInvocationArgs('claude', opts))
    }
    expect(shellArgv(internalAgentInvocationShellFlags('codex'))).toEqual(internalAgentInvocationArgs('codex'))
  })

  it('keeps plain tokens bare so the command stays readable', () => {
    expect(internalAgentInvocationShellFlags('claude')).toContain(' --autocompact 350k ')
  })
})
