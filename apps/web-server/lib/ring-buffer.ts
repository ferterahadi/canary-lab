// Per-pane ring buffer. Stores the most recent ~maxBytes of pty output so a
// late-joining WebSocket subscriber can replay context before the live stream
// resumes. We keep raw chunks (preserving ANSI color codes) and trim from the
// front when the buffer exceeds the cap.

export class RingBuffer {
  private chunks: string[] = []
  private byteLen = 0
  private exited: { code: number } | null = null

  constructor(public readonly maxBytes: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.byteLen += Buffer.byteLength(chunk, 'utf-8')
    while (this.byteLen > this.maxBytes && this.chunks.length > 0) {
      const head = this.chunks[0]
      const headBytes = Buffer.byteLength(head, 'utf-8')
      const overflow = this.byteLen - this.maxBytes
      if (headBytes <= overflow) {
        // Drop the whole head chunk.
        this.chunks.shift()
        this.byteLen -= headBytes
        continue
      }
      // Trim the head chunk by `overflow` bytes from its front.
      const sliced = head.slice(overflow)
      this.chunks[0] = sliced
      this.byteLen -= overflow
      break
    }
  }

  snapshot(): string {
    return this.chunks.join('')
  }

  byteLength(): number {
    return this.byteLen
  }

  markExit(code: number): void {
    this.exited = { code }
  }

  exitInfo(): { code: number } | null {
    return this.exited
  }

  clear(): void {
    this.chunks = []
    this.byteLen = 0
    this.exited = null
  }
}
