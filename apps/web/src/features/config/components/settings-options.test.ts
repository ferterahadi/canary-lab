import { describe, expect, it } from 'vitest'
import { editorLabel, migrateLegacyHealAgent } from './settings-options'

describe('editorLabel', () => {
  it('names an editor the way a person would', () => {
    // `vscode` is the command id the launcher reports back; it is not copy.
    expect(editorLabel('vscode')).toBe('VS Code')
    expect(editorLabel('cursor')).toBe('Cursor')
    expect(editorLabel('system')).toBe('System default')
  })

  it('shows an unknown choice as-is rather than nothing', () => {
    expect(editorLabel('zed')).toBe('zed')
  })
})

describe('migrateLegacyHealAgent', () => {
  it('reads the retired choices as the shipped default', () => {
    expect(migrateLegacyHealAgent('auto')).toBe('claude')
    expect(migrateLegacyHealAgent('manual')).toBe('claude')
  })

  it('leaves a current choice alone', () => {
    expect(migrateLegacyHealAgent('claude')).toBe('claude')
    expect(migrateLegacyHealAgent('codex')).toBe('codex')
  })
})
