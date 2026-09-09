import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { atomicWrite } from '../../../../../shared/lib/atomic-write'
import type { NotificationSource, WorkspaceNotification } from '../../../../../shared/notifications/types'
import type { WorkspaceEventPublisher } from '../../shared/workspace-events'

interface NotificationDatabase {
  version: 1
  items: WorkspaceNotification[]
  sources: Record<string, { signature: string; notificationId?: string }>
}

/** One atomic document owns messages AND observed source transitions. Keeping
 * them in separate record/index writes could resurrect a deleted notification
 * after a crash between writes. Only this server writes the workspace inbox. */
export class NotificationStore {
  private readonly file: string

  constructor(logsDir: string, private readonly events: WorkspaceEventPublisher) {
    this.file = path.join(logsDir, 'notifications', 'state.json')
  }

  private read(): NotificationDatabase {
    let content: string
    try { content = fs.readFileSync(this.file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [], sources: {} }
      throw error
    }
    const data = JSON.parse(content) as NotificationDatabase
    // Never reset an unreadable database: forgetting its source ledger could
    // bring permanently removed messages back. Surface the error for repair.
    if (data.version !== 1 || !Array.isArray(data.items) || !data.sources || typeof data.sources !== 'object') {
      throw new Error('Cannot read the notification database')
    }
    return data
  }

  private save(data: NotificationDatabase): void {
    atomicWrite(this.file, JSON.stringify(data, null, 2) + '\n')
    this.events.publish({ type: 'notifications-changed' })
  }

  list(): WorkspaceNotification[] {
    return this.read().items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  remove(id: string): void {
    const data = this.read()
    const items = data.items.filter((item) => item.id !== id)
    if (items.length === data.items.length) return
    // Retain only the source signature/id, never the deleted message content.
    // Re-observing that source cannot mint the same notification again.
    this.save({ ...data, items })
  }

  markRead(id: string): void {
    const data = this.read()
    const item = data.items.find((item) => item.id === id)
    if (!item || item.readAt) return
    item.readAt = new Date().toISOString()
    this.save(data)
  }

  reconcile(sources: NotificationSource[]): void {
    const data = this.read()
    const now = new Date().toISOString()
    let changed = false
    const seen = new Set(sources.map((source) => source.key))
    const settle = (id: string | undefined): void => {
      const item = data.items.find((item) => item.id === id)
      if (item && !item.resolvedAt) { item.resolvedAt = now; changed = true }
    }
    for (const source of sources) {
      const previous = data.sources[source.key]
      if (previous?.signature === source.signature) {
        const item = data.items.find((item) => item.id === previous.notificationId)
        // Keep a retained message accurate as more files change, without
        // resetting read state or recreating a deleted message.
        if (item && source.message && (item.title !== source.message.title || item.body !== source.message.body || item.severity !== source.message.severity || JSON.stringify(item.target) !== JSON.stringify(source.message.target))) {
          Object.assign(item, source.message)
          changed = true
        }
        continue
      }
      settle(previous?.notificationId)
      const item = source.message ? { ...source.message, id: randomUUID(), createdAt: now } : undefined
      if (item) data.items.push(item)
      data.sources[source.key] = { signature: source.signature, ...(item ? { notificationId: item.id } : {}) }
      changed = true
    }
    for (const [key, previous] of Object.entries(data.sources)) {
      if (!seen.has(key) && previous.signature !== 'absent') {
        settle(previous.notificationId)
        data.sources[key] = { signature: 'absent' }
        changed = true
      }
    }
    if (changed) this.save(data)
  }
}
