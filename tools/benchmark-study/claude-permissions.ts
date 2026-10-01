import { quote } from './files'

// Both repair policies need the same tools. Bash remains broad because the plain
// arm owns service/test execution and the Canary arm writes its run signal.
// Native sandboxing and the attempt-scoped file rules are the security boundary.
export const REPAIR_ALLOWED_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'SubagentHandback'] as const

export function claudePermissionArgs(allowedTools: readonly string[]): string[] {
  if (!allowedTools.length) throw new Error('Claude study permission policy cannot be empty')
  return ['--permission-mode', 'dontAsk', '--allowedTools', allowedTools.join(',')]
}

// Production's heal command stays in auto mode. This replaces only the study
// invocation after the command has been built and its prompt boundary frozen.
export function claudeStudyCommand(command: string, allowedTools: readonly string[]): string {
  const needle = ' --permission-mode auto'
  if (command.split(needle).length !== 2 || !command.includes('--setting-sources ""') || !command.includes('--settings ')) {
    throw new Error('Claude study launcher changed; review permission isolation')
  }
  const suffix = claudePermissionArgs(allowedTools).map(quote).join(' ')
  return command.replace(needle, ` ${suffix}`)
}
