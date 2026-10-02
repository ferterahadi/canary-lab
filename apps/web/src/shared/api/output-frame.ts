interface OutputFrameHandlers {
  onData: (chunk: string) => void
  onExit?: (code: number) => void
  onError?: (error: string) => void
  onReset?: () => void
}

/** Invalid frames cannot end a stream or leak non-string errors into the UI. */
export function dispatchOutputFrame(data: string, handlers: OutputFrameHandlers, markDone: () => void): void {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const msg = value as Record<string, unknown>
  if (msg.type === 'data' && typeof msg.chunk === 'string') {
    handlers.onData(msg.chunk)
  } else if (msg.type === 'exit' && typeof msg.code === 'number') {
    markDone()
    handlers.onExit?.(msg.code)
  } else if (msg.type === 'reset') {
    handlers.onReset?.()
  } else if (msg.type === 'error') {
    handlers.onError?.(typeof msg.error === 'string' ? msg.error : 'unknown error')
  }
}
