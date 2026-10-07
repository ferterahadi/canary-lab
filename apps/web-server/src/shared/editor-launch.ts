import type { EditorChoice } from '../../../../shared/project-config'
import { spawnSync } from 'child_process'
import { launchDetached, launchSystemTarget } from './system-launch'


export type EditorTarget =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; line: number; column: number }

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(lookup, [command], { stdio: 'ignore' }).status === 0
}

function launchCli(command: 'code' | 'cursor', target: EditorTarget): EditorChoice {
  const args = target.kind === 'file'
    ? ['-g', `${target.path}:${target.line}:${target.column}`]
    : [target.path]
  launchDetached({ command, args })
  return command === 'code' ? 'vscode' : 'cursor'
}

function launchSystem(dir: string): 'system' {
  launchSystemTarget({ kind: 'path', path: dir })
  return 'system'
}

/** Routes validate the target; this helper only chooses the editor and argv.
 * Launch stays best-effort, with synchronous failures handled by the caller. */
export function launchEditor(editor: EditorChoice, target: EditorTarget): EditorChoice {
  if (editor === 'auto') {
    if (commandExists('cursor')) return launchCli('cursor', target)
    if (commandExists('code')) return launchCli('code', target)
    return launchSystem(target.path)
  }
  if (editor === 'cursor') return launchCli('cursor', target)
  if (editor === 'vscode') return launchCli('code', target)
  return launchSystem(target.path)
}

export function launchEditorDir(editor: EditorChoice, dir: string): EditorChoice {
  return launchEditor(editor, { kind: 'directory', path: dir })
}
