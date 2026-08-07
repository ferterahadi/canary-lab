// Thin wrapper over node-pty that the orchestrator (and any future caller)
// uses to spawn services / Playwright / heal agents. Kept narrow and
// dependency-injectable so tests can stand in a fake `PtyHandle` without
// touching real PTYs.

import { ensureSpawnHelperExecutable } from '../../../../../../../shared/node-pty-permissions'

export interface PtySpawnOptions {
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  cols?: number
  rows?: number
  // Shell used to interpret `command`. Defaults to /bin/bash. Overridable for
  // tests or to support non-bash environments.
  shell?: string
}

export interface PtyHandle {
  pid: number
  onData(cb: (chunk: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type PtyFactory = (opts: PtySpawnOptions) => PtyHandle

let cachedRealFactory: PtyFactory | null = null

// Lazy-loaded so test environments without a built node-pty native binding
// don't crash on import.
function loadRealFactory(): PtyFactory {
  if (cachedRealFactory) return cachedRealFactory

  const pty = require('node-pty') as typeof import('node-pty')
  // node-pty ships `spawn-helper` without the execute bit, and the postinstall
  // hook that used to fix it is skippable by npm. Do it here too: once per
  // process, before any spawn, so an install that blocked scripts still works
  // instead of aborting every run with "posix_spawnp failed".
  ensureSpawnHelperExecutable()
  cachedRealFactory = (opts: PtySpawnOptions): PtyHandle => {
    // Respect the user's $SHELL so commands run with the same config as
    // their terminal (zsh + .zshrc, bash + .bashrc, etc.). `-i` makes the
    // shell interactive so .zshrc / .bashrc is sourced — services often
    // depend on PATH mutations from asdf/nvm/oh-my-zsh.
    const shell = opts.shell ?? process.env.SHELL ?? '/bin/bash'
    const proc = pty.spawn(shell, ['-i', '-c', opts.command], {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as { [k: string]: string },
    })
    return {
      get pid() {
        return proc.pid
      },
      onData: (cb) => proc.onData(cb),
      onExit: (cb) =>
        proc.onExit(({ exitCode, signal }) => cb({ exitCode, signal })),
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: (signal) => proc.kill(signal),
    }
  }
  return cachedRealFactory
}

export function realPtyFactory(): PtyFactory {
  return loadRealFactory()
}
