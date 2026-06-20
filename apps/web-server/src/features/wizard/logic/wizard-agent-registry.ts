import fs from 'fs'
import path from 'path'
import type { ChildProcess } from 'child_process'

interface ActiveWizardAgent {
  child: ChildProcess
  logPath: string
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
    child: ChildProcess
    logPath: string
  }): { isCancelled: () => boolean; clear: () => void } {
    const entry: ActiveWizardAgent = {
      child: input.child,
      logPath: input.logPath,
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
    this.cancelEntry(entry)
    return true
  }

  cancelAll(): void {
    for (const entry of this.active.values()) {
      this.cancelEntry(entry)
    }
  }

  has(draftId: string): boolean {
    return this.active.has(draftId)
  }

  private cancelEntry(entry: ActiveWizardAgent): void {
    if (entry.cancelled) return
    entry.cancelled = true
    const msg = '\n[wizard] Generation cancelled by user.\n'
    try {
      fs.mkdirSync(path.dirname(entry.logPath), { recursive: true })
      fs.appendFileSync(entry.logPath, msg, 'utf8')
    } catch {
      // Best effort; cancellation should still kill the process.
    }
    killChild(entry.child)
  }
}

// SIGTERM, then SIGKILL after a grace window if the agent ignored it.
export function killChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  try { child.kill(signal) } catch { /* already dead */ }
  setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* already dead */ }
  }, 2000).unref?.()
}
