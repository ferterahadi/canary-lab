import { spawn } from 'child_process'

export type SystemLaunchTarget =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string }
  | { kind: 'application'; agent: 'claude' | 'codex' }

export interface OpenCommand {
  command: string
  args: string[]
}

export interface DetachedSpawner {
  (command: string, args: string[], options: { detached: boolean; stdio: 'ignore' }): { unref(): void }
}

export function resolveSystemCommand(target: SystemLaunchTarget, platform: string): OpenCommand {
  let value: string
  if (target.kind === 'application') value = target.agent === 'claude' ? 'Claude' : 'Codex'
  else value = target.kind === 'url' ? target.url : target.path
  if (platform === 'darwin') {
    return { command: 'open', args: target.kind === 'application' ? ['-a', value] : [value] }
  }
  if (platform === 'win32') {
    // Keep the existing URL title argument distinct from the path/app form.
    return { command: 'cmd', args: ['/c', 'start', target.kind === 'url' ? '""' : '', value] }
  }
  return target.kind === 'application'
    ? { command: target.agent, args: [] }
    : { command: 'xdg-open', args: [value] }
}

/** Success means a spawn attempt; the caller owns error handling, not this helper. */
export function launchDetached({ command, args }: OpenCommand, spawner: DetachedSpawner = spawn): void {
  spawner(command, args, { detached: true, stdio: 'ignore' }).unref()
}

export function launchSystemTarget(target: SystemLaunchTarget): void {
  launchDetached(resolveSystemCommand(target, process.platform))
}
