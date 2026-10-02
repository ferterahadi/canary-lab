import { expect, it } from 'vitest'
import { claudePermissionArgs, claudeStudyCommand, REPAIR_ALLOWED_TOOLS } from './claude-permissions'

it('freezes one study-only dontAsk policy without changing the production launcher', () => {
  const production = 'claude --setting-sources "" --settings "/tmp/isolation.json" --permission-mode auto --add-dir "/tmp/app" -- "@/tmp/prompt.md"'
  const study = claudeStudyCommand(production, REPAIR_ALLOWED_TOOLS)
  expect(production).toContain('--permission-mode auto')
  expect(study).toContain("'--permission-mode' 'dontAsk' '--allowedTools' 'Bash,Read,Edit,Write,Glob,Grep,Agent,SubagentHandback'")
  expect(study).toContain('--settings "/tmp/isolation.json"')
  expect(study).toContain('--add-dir "/tmp/app" -- "@/tmp/prompt.md"')
  expect(study).not.toContain('--permission-mode auto')
})

it('rejects missing isolation or a changed permission launcher', () => {
  expect(() => claudePermissionArgs([])).toThrow('cannot be empty')
  for (const command of [
    'claude --permission-mode auto',
    'claude --setting-sources "" --settings /tmp/policy --permission-mode manual',
    'claude --setting-sources "" --settings /tmp/policy --permission-mode auto --permission-mode auto',
  ]) expect(() => claudeStudyCommand(command, ['Bash'])).toThrow('launcher changed')
})
