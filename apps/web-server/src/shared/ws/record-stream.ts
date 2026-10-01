import type { FastifyInstance } from 'fastify'

// The push channel every record store here exposes: on connect, one `snapshot`
// frame; after that, each store event becomes at most one delta frame, until the
// socket closes and the listener is dropped. Only the frame shapes differ per
// store (their id keys are part of each client's wire contract), so each stream
// passes its own `snapshot` and `frameFor` and this owns the socket lifecycle.

export interface FrameSocket {
  send(data: string): void
}

/** Send one JSON frame. A socket that closed between an event and this send
 *  throws; its close handler is already dropping the listener, so the frame has
 *  no reader and is discarded. */
export function sendFrame(socket: FrameSocket, frame: unknown): void {
  try { socket.send(JSON.stringify(frame)) } catch { /* socket closed */ }
}

interface StoreEvents<Event> {
  onEvent(listener: (event: Event) => void): void
  offEvent(listener: (event: Event) => void): void
}

export interface RecordStreamOptions<Frame, Event> {
  path: string
  store: StoreEvents<Event>
  snapshot(): Frame
  /** The frame an event becomes, or undefined when it has nothing to push — a
   *  record already deleted, or an event this stream does not carry. */
  frameFor(event: Event): Frame | undefined
}

export function registerRecordStream<Frame, Event>(
  app: FastifyInstance,
  options: RecordStreamOptions<Frame, Event>,
): void {
  app.get(options.path, { websocket: true }, (socket) => {
    sendFrame(socket, options.snapshot())
    const onEvent = (event: Event): void => {
      const frame = options.frameFor(event)
      if (frame) sendFrame(socket, frame)
    }
    options.store.onEvent(onEvent)
    socket.on('close', () => options.store.offEvent(onEvent))
  })
}

/** Details for the entries still moving. A settled record's detail is one REST
 *  read away and most are never opened, so the snapshot stays small for a long
 *  history; a record the store has already lost is left out. */
export function activeDetails<Entry, Detail>(
  entries: readonly Entry[],
  isActive: (entry: Entry) => boolean,
  idOf: (entry: Entry) => string,
  get: (id: string) => Detail | null,
): Record<string, Detail> {
  const details: Record<string, Detail> = {}
  for (const entry of entries) {
    if (!isActive(entry)) continue
    const detail = get(idOf(entry))
    if (detail) details[idOf(entry)] = detail
  }
  return details
}
