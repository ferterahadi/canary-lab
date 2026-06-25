import { spawn, spawnSync } from 'child_process'
import type { EditorChoice } from '../features/runs/logic/runtime/launcher/project-config'

// Open a DIRECTORY (folder) in the user's configured editor. The existing
// `/api/open-editor` launcher (routes/project-config.ts) only opens single
// files with `-g file:line:col`; benchmark worktree inspection wants the whole
// repo folder, so this is the directory-oriented sibling. Best-effort by
// platform — mirrors the file launcher's behaviour and the same EditorChoice.

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(lookup, [command], { stdio: 'ignore' }).status === 0
}

function launchCli(command: 'code' | 'cursor', dir: string): EditorChoice {
  spawn(command, [dir], { stdio: 'ignore', detached: true }).unref()
  return command === 'code' ? 'vscode' : 'cursor'
}

function launchSystem(dir: string): 'system' {
  if (process.platform === 'darwin') {
    spawn('open', [dir], { stdio: 'ignore', detached: true }).unref()
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', dir], { stdio: 'ignore', detached: true }).unref()
  } else {
    spawn('xdg-open', [dir], { stdio: 'ignore', detached: true }).unref()
  }
  return 'system'
}

/**
 * Open `dir` in the chosen editor and return which editor was actually used
 * (resolving `auto` → cursor → code → system). Throws only if the spawn itself
 * throws synchronously; a failed launch otherwise is silent (the caller treats
 * the open as best-effort and offers a copy-path fallback).
 */
export function launchEditorDir(editor: EditorChoice, dir: string): EditorChoice {
  if (editor === 'auto') {
    if (commandExists('cursor')) return launchCli('cursor', dir)
    if (commandExists('code')) return launchCli('code', dir)
    return launchSystem(dir)
  }
  if (editor === 'cursor') return launchCli('cursor', dir)
  if (editor === 'vscode') return launchCli('code', dir)
  return launchSystem(dir)
}
