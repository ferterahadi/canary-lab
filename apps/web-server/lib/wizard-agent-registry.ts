import fs from 'fs'
import path from 'path'
import type { PaneBroker } from './pane-broker'
import type { PtyHandle } from './runtime/pty-spawner'

interface ActiveWizardAgent {
  pty: PtyHandle
  logPath: string
  broker?: PaneBroker | null
  paneId: string
  cancelled: boolean
}

export class WizardAgentCancelledError extends Error {
  constructor(public readonly draftId: string) {
    super(`wizard generation cancelled for ${draftId}`)
  }
}

export class WizardAgentRegistry {
  private readonly active = new Map<string, ActiveWizardAgent>()

  register(input: {
    draftId: string
    pty: PtyHandle
    logPath: string
    broker?: PaneBroker | null
    paneId: string
  }): { isCancelled: () => boolean; clear: () => void } {
    const entry: ActiveWizardAgent = {
      pty: input.pty,
      logPath: input.logPath,
      broker: input.broker,
      paneId: input.paneId,
      cancelled: false,
    }
    this.active.set(input.draftId, entry)
    return {
      isCancelled: () => entry.cancelled,
      clear: () => {
        if (this.active.get(input.draftId) === entry) this.active.delete(input.draftId)
      },
    }
  }

  cancel(draftId: string): boolean {
    const entry = this.active.get(draftId)
    if (!entry) return false
    this.cancelEntry(draftId, entry)
    return true
  }

  cancelAll(): void {
    for (const [draftId, entry] of this.active) {
      this.cancelEntry(draftId, entry)
    }
  }

  has(draftId: string): boolean {
    return this.active.has(draftId)
  }

  private cancelEntry(draftId: string, entry: ActiveWizardAgent): void {
    if (entry.cancelled) return
    entry.cancelled = true
    const msg = '\n[wizard] Generation cancelled by user.\n'
    try {
      fs.mkdirSync(path.dirname(entry.logPath), { recursive: true })
      fs.appendFileSync(entry.logPath, msg, 'utf8')
    } catch {
      // Best effort; cancellation should still kill the process.
    }
    entry.broker?.push(entry.paneId, msg)
    killTree(entry.pty, 'SIGTERM')
    scheduleSigkillFallback(entry.pty)
  }
}

export function killTree(pty: PtyHandle, signal: NodeJS.Signals | number): void {
  try {
    process.kill(-pty.pid, signal)
    return
  } catch {
    // Fall back to signalling the pty's immediate process.
  }
  try { pty.kill(typeof signal === 'string' ? signal : undefined) } catch { /* already dead */ }
}

export function scheduleSigkillFallback(pty: PtyHandle, ms = 2000): void {
  setTimeout(() => {
    try { process.kill(-pty.pid, 'SIGKILL') } catch { /* already dead */ }
  }, ms).unref?.()
}
