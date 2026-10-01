import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { CommandResult } from '../files'
import type { ContainerRecoveryPlan, ContainerRecoveryReceipt } from './container-recovery'

type Response = { ready: true } | { id: number; error: string } | { id: number; receipt: ContainerRecoveryReceipt }
  | { id: number; result: CommandResult }
type Result = CommandResult | ContainerRecoveryReceipt

export class ContainerGuardian {
  private child?: ChildProcess
  private ready?: Promise<void>
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: Result) => void; reject: (error: Error) => void }>()

  constructor(private readonly plan: ContainerRecoveryPlan) {}

  async start(): Promise<void> {
    if (this.ready) return this.ready
    const log = fs.openSync(path.join(this.plan.privateDir, 'container-supervisor.log'), 'a')
    // The independent session survives evaluator SIGKILL. IPC closes when that
    // exact evaluator dies, avoiding PID reuse and heartbeat timing assumptions.
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'),
      path.join(__dirname, 'container-supervisor.ts'), JSON.stringify(this.plan)],
    { detached: true, env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', log, 'ipc'] })
    fs.closeSync(log)
    this.child = child
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Candidate supervisor readiness timed out'))
        if (child.connected) child.disconnect()
      }, 10_000)
      child.on('message', (message: Response) => {
        if ('ready' in message) { clearTimeout(timeout); resolve(); return }
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if ('error' in message) pending.reject(new Error(message.error))
        else pending.resolve('receipt' in message ? message.receipt : message.result)
      })
      const fail = (error: Error): void => {
        clearTimeout(timeout); reject(error)
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
      }
      child.once('error', fail)
      child.once('exit', (code, signal) => fail(new Error(`Candidate supervisor exited: ${code ?? signal}`)))
    })
    return this.ready
  }

  private async request(operation: 'run' | 'finish', args?: string[], timeoutMs?: number, log?: string): Promise<Result> {
    await this.start()
    const child = this.child!
    if (!child.connected) throw new Error('Candidate supervisor disconnected')
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve, reject })
      child.send({ id, operation, args, timeoutMs, log }, (error) => {
        if (error) { this.pending.delete(id); reject(error) }
      })
    })
  }

  async run(args: string[], timeoutMs: number, log?: string): Promise<CommandResult> {
    return await this.request('run', args, timeoutMs, log) as CommandResult
  }

  abort(): void {
    if (this.child?.connected) this.child.send({ operation: 'abort' }, (error) => {
      // If delivery fails the disconnected supervisor owns resource recovery.
      if (error && this.child?.connected) this.child.disconnect()
    })
  }

  async finish(): Promise<ContainerRecoveryReceipt> {
    try { return await this.request('finish') as ContainerRecoveryReceipt }
    finally { if (this.child?.connected) this.child.disconnect() }
  }
}
