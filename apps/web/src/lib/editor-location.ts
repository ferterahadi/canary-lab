export function sourceLineForBodyLine(startLine: number, bodyLine: number): number {
  return startLine + bodyLine - 1
}
