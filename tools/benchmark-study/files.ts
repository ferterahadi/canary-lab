import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { signalProcessTree } from '../../apps/web-server/src/shared/process-tree'

export const sourceRoot = path.resolve(__dirname, '../..')
export const canaryRunDir = (attemptRoot: string): string => path.join(attemptRoot, 'logs/runs', path.basename(attemptRoot))
export const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`
export function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
export function json(file: string, value: unknown): void {
  write(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(`${file}.tmp`, file)
}
export function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
export function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
export function files(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git', '.state', 'test-results', 'playwright-report'].includes(entry.name)) return []
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in frozen input: ${absolute}`)
    return entry.isDirectory() ? files(absolute).map((name) => `${entry.name}/${name}`) : [entry.name]
  }).sort()
}
export function hashes(root: string): Record<string, string> {
  return Object.fromEntries(files(root).map((name) => [name, sha(fs.readFileSync(path.join(root, name)))]))
}
export const digest = (root: string): string => sha(JSON.stringify(hashes(root)))
export function copy(source: string, target: string): void {
  for (const name of files(source)) {
    const dest = path.join(target, name)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(source, name), dest)
  }
}
export function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).sort()
}

export interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
export function prefixedCommand(executable: string, args: string[], prefix: string[] = []): { command: string; args: string[] } {
  const invocation = [...prefix, executable, ...args]
  return { command: invocation[0], args: invocation.slice(1) }
}
export function command(executable: string, args: string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; inheritEnv?: boolean; timeoutMs?: number; log?: string; signal?: AbortSignal;
  killGroupOnClose?: boolean
  parentLease?: boolean
  onOutput?: (value: string, stream: 'stdout' | 'stderr') => void
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd,
      env: options.inheritEnv === false ? options.env ?? {} : { ...process.env, ...options.env },
      detached: true, stdio: options.parentLease ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let timedOut = false
    let stopping = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      if (stopping) return
      stopping = true
      signalProcessTree(child, 'SIGTERM', { detachedProcessGroup: true })
      killTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', { detachedProcessGroup: true })
        // A descendant may keep inherited pipes open after the direct child
        // exits. The deadline must also bound waiting for Node's close event.
        child.stdout!.destroy(); child.stderr!.destroy()
        child.stdio[3]?.destroy()
        child.unref()
        cleanup()
        resolve({ code: child.exitCode, signal: child.signalCode, stdout, stderr, timedOut })
      }, 2_000)
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs ?? 120_000)
    options.signal?.addEventListener('abort', stop, { once: true })
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    if (options.signal?.aborted) stop()
    const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const value = chunk.toString()
      if (stream === 'stdout') stdout += value
      else stderr += value
      options.onOutput?.(value, stream)
      if (options.log) { fs.mkdirSync(path.dirname(options.log), { recursive: true }); fs.appendFileSync(options.log, value) }
    }
    child.stdout!.on('data', (chunk: Buffer) => capture(chunk, 'stdout'))
    child.stderr!.on('data', (chunk: Buffer) => capture(chunk, 'stderr'))
    const cleanup = (): void => {
      clearTimeout(timer); clearTimeout(killTimer); options.signal?.removeEventListener('abort', stop)
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    }
    child.once('error', (error) => { cleanup(); reject(error) })
    child.once('close', (code, signal) => {
      if (options.killGroupOnClose) signalProcessTree(child, 'SIGKILL', { detachedProcessGroup: true })
      cleanup(); resolve({ code, signal, stdout, stderr, timedOut })
    })
  })
}
export async function checked(executable: string, args: string[], cwd: string): Promise<string> {
  const result = await command(executable, args, { cwd })
  if (result.code !== 0) throw new Error(`${executable} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}
