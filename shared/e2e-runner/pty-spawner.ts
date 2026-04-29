// Thin wrapper over node-pty that the orchestrator (and any future caller)
// uses to spawn services / Playwright / heal agents. Kept narrow and
// dependency-injectable so tests can stand in a fake `PtyHandle` without
// touching real PTYs.

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty')
  cachedRealFactory = (opts: PtySpawnOptions): PtyHandle => {
    const shell = opts.shell ?? '/bin/bash'
    const proc = pty.spawn(shell, ['-c', opts.command], {
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
