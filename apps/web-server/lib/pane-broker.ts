import { RingBuffer } from './ring-buffer'

// Per-run map of pane id → ring buffer + subscriber set. The Fastify
// WebSocket handler talks to this through a tiny interface; orchestrator
// events feed it via wireOrchestrator().

export type PaneId = string // `service:<safeName>` | `playwright` | `agent`

export const DEFAULT_PANE_BYTES = 100 * 1024 // ~100 KB replay window per pane.

export type PaneMessage =
  | { type: 'data'; chunk: string }
  | { type: 'exit'; code: number }

export interface PaneSubscriber {
  send(msg: PaneMessage): void
  close(): void
}

interface PaneEntry {
  buffer: RingBuffer
  subs: Set<PaneSubscriber>
}

export class PaneBroker {
  private panes = new Map<PaneId, PaneEntry>()

  constructor(private readonly bufferBytes: number = DEFAULT_PANE_BYTES) {}

  private ensure(id: PaneId): PaneEntry {
    let entry = this.panes.get(id)
    if (!entry) {
      entry = { buffer: new RingBuffer(this.bufferBytes), subs: new Set() }
      this.panes.set(id, entry)
    }
    return entry
  }

  push(id: PaneId, chunk: string): void {
    const entry = this.ensure(id)
    entry.buffer.append(chunk)
    for (const sub of entry.subs) {
      sub.send({ type: 'data', chunk })
    }
  }

  markExit(id: PaneId, code: number): void {
    const entry = this.ensure(id)
    entry.buffer.markExit(code)
    for (const sub of entry.subs) {
      sub.send({ type: 'exit', code })
      sub.close()
    }
    entry.subs.clear()
  }

  // Subscribe a new client to a pane. Replays the ring buffer immediately,
  // then delivers live chunks until the caller calls the returned unsubscribe.
  // If the pane already exited, replays buffer + exit message and closes
  // synchronously.
  subscribe(id: PaneId, sub: PaneSubscriber): () => void {
    const entry = this.ensure(id)
    const replay = entry.buffer.snapshot()
    if (replay.length > 0) sub.send({ type: 'data', chunk: replay })
    const exit = entry.buffer.exitInfo()
    if (exit) {
      sub.send({ type: 'exit', code: exit.code })
      sub.close()
      return () => { /* already closed */ }
    }
    entry.subs.add(sub)
    return () => { entry.subs.delete(sub) }
  }

  /**
   * Wipe a pane's buffer + exit info AND close its current subscribers so
   * they reconnect to a fresh stream. Called when a fresh pty is about to
   * be spawned for the same paneId — e.g. Playwright restarting after a
   * heal cycle, or the heal agent starting a new attempt. Without this, a
   * subscriber that joins after the FIRST exit will replay the old
   * `[pane exited code=N]` and immediately close, never seeing the new
   * stream's data.
   */
  resetPane(id: PaneId): void {
    const entry = this.panes.get(id)
    if (!entry) return
    entry.buffer.clear()
    for (const sub of entry.subs) {
      try { sub.close() } catch { /* ignore */ }
    }
    entry.subs.clear()
  }

  paneIds(): PaneId[] {
    return [...this.panes.keys()]
  }

  // For tests — peek the buffered content of a pane.
  snapshot(id: PaneId): string {
    return this.ensure(id).buffer.snapshot()
  }

  subscriberCount(id: PaneId): number {
    const entry = this.panes.get(id)
    return entry ? entry.subs.size : 0
  }

  destroy(): void {
    for (const entry of this.panes.values()) {
      for (const sub of entry.subs) sub.close()
      entry.subs.clear()
    }
    this.panes.clear()
  }
}
