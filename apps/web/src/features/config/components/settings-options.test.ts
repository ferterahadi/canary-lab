import { describe, expect, it } from 'vitest'
import { editorLabel, migrateLegacyEditor, migrateLegacyHealAgent, stagePlanSummary } from './settings-options'

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

describe('migrateLegacyEditor', () => {
  it('folds the retired system preference into auto-detect', () => {
    expect(migrateLegacyEditor('system')).toBe('auto')
    expect(migrateLegacyEditor('auto')).toBe('auto')
    expect(migrateLegacyEditor('cursor')).toBe('cursor')
    expect(migrateLegacyEditor('vscode')).toBe('vscode')
  })
})

describe('stagePlanSummary', () => {
  it('stays silent for an untouched plan and summarizes configured stages', () => {
    expect(stagePlanSummary(undefined)).toBeNull()
    expect(stagePlanSummary({})).toBeNull()
    expect(stagePlanSummary({ heal: { model: 'opus', effort: 'high' } }))
      .toBe('Auto-repair opus · high · rest agent default')
  })
})
