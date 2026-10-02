import { agentModelArgs } from './agent-models'
import type { StageModelChoice } from '../../../../../../shared/agent-models'

interface ReadOnlyCodexOptions {
  prompt: string
  models: StageModelChoice
  outputPath?: string
  outputSchemaPath?: string
}

/** These agents return proposed changes as data; they must never edit their inputs. */
export function buildReadOnlyCodexArgs(options: ReadOnlyCodexOptions): string[] {
  return [
    'exec', '--skip-git-repo-check', '--sandbox', 'read-only',
    ...agentModelArgs('codex', options.models),
    ...(options.outputPath ? ['--output-last-message', options.outputPath] : []),
    ...(options.outputSchemaPath ? ['--output-schema', options.outputSchemaPath] : []),
    options.prompt,
  ]
}
