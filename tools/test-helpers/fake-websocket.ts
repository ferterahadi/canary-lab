/** A stand-in for the browser `WebSocket` that never touches the network. A
 *  test installs it as the global (or hands it to a socket factory), finds the
 *  socket the code under test opened in `instances`, and plays the server's
 *  side with the `fire*` methods. It records what the client did — `sent`,
 *  `closeCalls`, `closed` — and never changes its own state on a timer.
 *
 *  `readyState` starts at CONNECTING (0) and moves only when the test says so,
 *  so a suite controls exactly when the client sees the socket open. Reset
 *  `instances` in a `beforeEach`; it is the subclass's own list once assigned. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  closeCalls = 0
  /** Set to make the next `close()` throw, as a browser socket can. */
  closeError: Error | null = null
  sent: string[] = []

  constructor(public url: string) {
    // Through the constructor, not `FakeWebSocket`, so a subclass whose suite
    // reassigned `instances` records into its own list.
    ;(this.constructor as typeof FakeWebSocket).instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** Records the close and goes CLOSED, but does not deliver `onclose`: the
   *  client asked for the close, and a suite decides separately whether the
   *  close event arrives (`fireClose`). */
  close(): void {
    this.closeCalls += 1
    this.closed = true
    this.readyState = 3
    if (this.closeError) throw this.closeError
  }

  /** A server frame, JSON-encoded. */
  fire(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  /** A server frame exactly as given, for malformed or non-string payloads. */
  fireRaw(data: unknown): void {
    this.onmessage?.({ data })
  }

  fireOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  fireClose(): void {
    this.readyState = 3
    this.onclose?.()
  }

  fireError(): void {
    this.onerror?.()
  }
}

/** A `FakeWebSocket` whose `close()` also delivers `onclose` at once, so the
 *  client's own close handler runs inside the same act() as the unmount or
 *  switch that closed it. The context-provider suites rely on this; the socket
 *  wrapper suites drive the close event separately with `fireClose`. */
export class ClosingFakeWebSocket extends FakeWebSocket {
  override close(): void {
    super.close()
    this.onclose?.()
  }
}
