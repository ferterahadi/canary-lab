import { execFileSync } from 'child_process'
import { isClientKind, type ClientKind } from '../../shared/run-mode'

export function inferMcpClientKind(
  env: NodeJS.ProcessEnv = process.env,
  startPid = process.ppid,
): ClientKind | null {
  if (isClientKind(env.CANARY_LAB_MCP_CLIENT_KIND)) {
    return env.CANARY_LAB_MCP_CLIENT_KIND
  }
  return inferClientKindFromProcessLines(readProcessLineage(startPid))
}

// Detection only ever produces the human-driven kinds: `claude` / `codex`
// (Desktop and CLI are no longer distinguished — both may heal) or `null`
// (→ `other`, also allowed). The runner-spawned `*-pty` kinds are NEVER
// sniffed: the runner sets `CANARY_LAB_MCP_CLIENT_KIND` explicitly (read first
// in `inferMcpClientKind`), so the only blocked case is set, not guessed.
export function inferClientKindFromProcessLines(lines: string[]): ClientKind | null {
  const haystack = lines.join('\n')
  if (/\/Applications\/Claude\.app\b|Claude Helper|Claude\.app|(^|[\s/])claude(?:\s|$)|claude-code/i.test(haystack)) return 'claude'
  if (/\/Applications\/Codex\.app\b|Codex Helper|Codex\.app|(^|[\s/])codex(?:\s|$)/i.test(haystack)) return 'codex'
  return null
}

export function readProcessLineage(startPid: number): string[] {
  if (process.platform === 'win32') return []
  const lines: string[] = []
  let pid = startPid
  for (let depth = 0; depth < 10 && pid > 1; depth += 1) {
    const entry = readProcessEntry(pid)
    if (!entry) break
    lines.push(entry.command)
    pid = entry.ppid
  }
  return lines
}

export function readProcessEntry(pid: number): { ppid: number; command: string } | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const match = out.match(/^(\d+)\s+([\s\S]+)$/)
    if (!match) return null
    return { ppid: Number(match[1]), command: match[2] }
  } catch {
    return null
  }
}
