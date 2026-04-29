// Foreground PTY launcher — replaces the old AppleScript iTerm/Terminal
// launchers. Each "tab" becomes a node-pty child of the runner process; its
// output is teed to the user's current terminal stdout (so they can still
// watch services live) and to a log file. This keeps `canary-lab run`
// usable while the web UI is still being built.

import fs from 'fs'
import path from 'path'
import { realPtyFactory, type PtyFactory, type PtyHandle } from '../e2e-runner/pty-spawner'

export interface ForegroundTab {
  name: string
  command: string
  cwd: string
  logPath?: string
  env?: NodeJS.ProcessEnv
}

export interface ForegroundLauncherOptions {
  ptyFactory?: PtyFactory
  // Where to mirror pty output for the user. Defaults to process.stdout.
  out?: NodeJS.WritableStream
  // Prefix each line with `[<name>] ` so interleaved output stays readable.
  prefix?: boolean
}

export interface ForegroundHandle {
  name: string
  pid: number
  pty: PtyHandle
  stop(): void
}

export class ForegroundLauncher {
  private readonly ptyFactory: PtyFactory
  private readonly out: NodeJS.WritableStream
  private readonly prefix: boolean
  private readonly handles = new Map<string, ForegroundHandle>()

  constructor(opts: ForegroundLauncherOptions = {}) {
    this.ptyFactory = opts.ptyFactory ?? realPtyFactory()
    this.out = opts.out ?? process.stdout
    this.prefix = opts.prefix ?? true
  }

  open(tab: ForegroundTab): ForegroundHandle {
    const existing = this.handles.get(tab.name)
    if (existing) {
      try { existing.pty.kill('SIGTERM') } catch { /* ignore */ }
      this.handles.delete(tab.name)
    }
    const pty = this.ptyFactory({
      command: tab.command,
      cwd: tab.cwd,
      env: tab.env,
    })
    let logPath: string | null = null
    let logEnded = false
    if (tab.logPath) {
      fs.mkdirSync(path.dirname(tab.logPath), { recursive: true })
      // Truncate + ensure file exists so the first read works deterministically.
      fs.writeFileSync(tab.logPath, '')
      logPath = tab.logPath
    }
    pty.onData((chunk) => {
      const display = this.prefix ? prefixLines(tab.name, chunk) : chunk
      try { this.out.write(display) } catch { /* ignore */ }
      if (logPath && !logEnded) {
        try { fs.appendFileSync(logPath, chunk) } catch { /* ignore */ }
      }
    })
    pty.onExit(() => {
      logEnded = true
    })
    const handle: ForegroundHandle = {
      name: tab.name,
      pid: pty.pid,
      pty,
      stop: () => {
        try { pty.kill('SIGTERM') } catch { /* ignore */ }
        logEnded = true
        this.handles.delete(tab.name)
      },
    }
    this.handles.set(tab.name, handle)
    return handle
  }

  closeAll(): void {
    for (const h of Array.from(this.handles.values())) h.stop()
  }

  closeByName(name: string): void {
    this.handles.get(name)?.stop()
  }

  getHandle(name: string): ForegroundHandle | undefined {
    return this.handles.get(name)
  }
}

export function prefixLines(name: string, chunk: string): string {
  // Split on \n but preserve trailing partial line behaviour by re-joining.
  const head = `[${name}] `
  return chunk
    .split(/(\r?\n)/)
    .map((part, i) => (i % 2 === 0 && part.length > 0 ? head + part : part))
    .join('')
}
