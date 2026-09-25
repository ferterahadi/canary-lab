// A completed webpack result is a compiler verdict. Generic error text is not:
// healthy apps can log expected validation failures during tests.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const WEBPACK_FAILURE = /^(?:\[[^\]]+\]\s*)?webpack(?:\s+\d+(?:\.\d+)*)?\s+compiled with [1-9]\d* errors?\b/i

/** Returns the next incomplete line so PTY chunks cannot split a verdict. */
export function readWatchCompilerFailure(tail: string, chunk: string): { tail: string; failed: boolean } {
  const lines = (tail + chunk).replace(ANSI, '').split(/[\r\n]+/)
  const last = lines.pop() ?? ''
  return {
    tail: last.slice(-1024),
    failed: lines.some((line) => WEBPACK_FAILURE.test(line.trimStart())) || WEBPACK_FAILURE.test(last.trimStart()),
  }
}
