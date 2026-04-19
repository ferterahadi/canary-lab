#!/usr/bin/env node
/*
 * Parses `codex exec --json` JSONL on stdin and prints a compact, readable
 * stream to stdout. Used by the heal-agent tab for Codex runs so the output
 * isn't a wall of raw event JSON.
 */
export {}

interface AnyObj {
  [key: string]: unknown
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const CWD = process.cwd()
const START = Date.now()

const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
}

function c(color: keyof typeof ansi, text: string): string {
  if (!useColor) return text
  return `${ansi[color]}${text}${ansi.reset}`
}

function elapsed(): string {
  const s = Math.floor((Date.now() - START) / 1000)
  const mm = Math.floor(s / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

function tag(): string {
  return c('gray', `[${elapsed()}]`)
}

function relPath(p: string): string {
  if (!p) return ''
  if (p.startsWith(CWD + '/')) return p.slice(CWD.length + 1)
  if (p === CWD) return '.'
  // Codex reports paths under /private/tmp/... on macOS when CWD is /tmp/...
  const privateCwd = `/private${CWD}`
  if (p.startsWith(privateCwd + '/')) return p.slice(privateCwd.length + 1)
  return p.replace(process.env.HOME ?? '', '~')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function summarizeOutput(text: string, maxLen = 140): string {
  const cleaned = text.trim()
  if (!cleaned) return c('dim', '(no output)')
  const lines = cleaned.split('\n').filter((l) => l.trim().length > 0)
  const head = truncate(lines[0].trim(), maxLen)
  if (lines.length > 1) {
    return `${head} ${c('dim', `(+${lines.length - 1} more lines)`)}`
  }
  return head
}

// Strip leading shell wrappers like `/bin/zsh -lc '...'` so the command is
// readable. Matches `<shell> -lc '<cmd>'` / `<shell> -c "<cmd>"`.
function cleanCommand(cmd: string): string {
  const m = cmd.match(/^\/[^ ]+\s+-l?c\s+['"](.+)['"]$/s)
  return m ? m[1] : cmd
}

interface ParsedCommand {
  icon: string
  tool: string
  label: string
  // When true, a non-zero exit should be rendered as "not found" rather than a
  // scary error. Used for `test -f ... && <read>` guarded reads where the guard
  // failing just means the file isn't there.
  guardedRead: boolean
}

// Map common shell invocations into Read/Grep/Glob pseudo-tools so the codex
// stream reads like the claude stream. Anything unrecognized falls through to a
// raw `$ <cmd>` line (same as before).
function parseCommand(raw: string): ParsedCommand {
  let cmd = raw.trim()
  let guarded = false

  // Drop a leading `test -f <path> && ` (or `test -e`) guard — codex uses it to
  // avoid sed errors on missing files. The read itself is the meaningful part.
  const guard = cmd.match(/^test\s+-[fe]\s+\S+\s+&&\s+(.+)$/s)
  if (guard) {
    cmd = guard[1]
    guarded = true
  }

  // sed -n 'N,Mp' <file>  →  Read with line range
  const sedRange = cmd.match(/^sed\s+-n\s+['"](\d+),(\d+)p['"]\s+(\S+)$/)
  if (sedRange) {
    const [, from, to, file] = sedRange
    return {
      icon: '📖',
      tool: 'Read',
      label: `${relPath(file)} ${c('dim', `L${from}-${to}`)}`,
      guardedRead: guarded,
    }
  }

  // sed -n '/PAT/,/PAT/p' <file>  →  Read (pattern slice)
  const sedPat = cmd.match(/^sed\s+-n\s+['"]\/.+?\/,\/.+?\/p['"]\s+(.+)$/)
  if (sedPat) {
    return {
      icon: '📖',
      tool: 'Read',
      label: `${relPath(sedPat[1])} ${c('dim', '(pattern slice)')}`,
      guardedRead: guarded,
    }
  }

  // cat / head / tail <file>
  const catMatch = cmd.match(/^(cat|head|tail)(?:\s+-n?\s*\d+)?\s+(\S+)$/)
  if (catMatch) {
    return {
      icon: '📖',
      tool: 'Read',
      label: relPath(catMatch[2]),
      guardedRead: guarded,
    }
  }

  // rg / grep — split flags from pattern + path.
  const rgMatch = cmd.match(/^(rg|grep)\s+(.+)$/s)
  if (rgMatch) {
    const args = rgMatch[2]
    const patMatch = args.match(/['"]([^'"]+)['"]\s+(\S+)\s*$/)
    if (patMatch) {
      return {
        icon: '🔍',
        tool: 'Grep',
        label: `${c('bold', patMatch[1])} in ${relPath(patMatch[2])}`,
        guardedRead: guarded,
      }
    }
    return {
      icon: '🔍',
      tool: 'Grep',
      label: truncate(args, 140),
      guardedRead: guarded,
    }
  }

  // ls <path>
  const lsMatch = cmd.match(/^ls(?:\s+-[a-zA-Z]+)*\s+(\S+)\s*$/)
  if (lsMatch) {
    return {
      icon: '📂',
      tool: 'List',
      label: relPath(lsMatch[1]),
      guardedRead: guarded,
    }
  }

  // find <path> …
  if (/^find\s/.test(cmd)) {
    return {
      icon: '🔍',
      tool: 'Glob',
      label: truncate(cmd.slice(5), 140),
      guardedRead: guarded,
    }
  }

  return {
    icon: '$',
    tool: 'Bash',
    label: truncate(cmd, 160),
    guardedRead: guarded,
  }
}

function toolLabel(tool: string, icon: string): string {
  if (tool === 'Bash') return c('cyan', '$')
  return `${icon} ${c('cyan', tool.padEnd(6))}`
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((l) => `  ${c('dim', '│')} ${l}`)
    .join('\n')
}

function kindIcon(kind: string): string {
  if (kind === 'add') return c('green', '+')
  if (kind === 'delete') return c('red', '-')
  return c('yellow', '~')
}

let totalInTokens = 0
let totalOutTokens = 0
let turnCount = 0
let reasoningCount = 0

function handleCompleted(item: AnyObj): void {
  const type = item.type as string | undefined

  if (type === 'agent_message') {
    const text = String(item.text ?? '').trim()
    if (!text) return
    process.stdout.write(`\n${quote(text)}\n`)
    return
  }

  if (type === 'reasoning') {
    const text = String(item.text ?? '').trim()
    if (!text) return
    reasoningCount += 1
    process.stdout.write(`${tag()} ${c('magenta', 'thinking')} ${c('dim', truncate(text.split('\n')[0], 100))}\n`)
    return
  }

  if (type === 'command_execution') {
    const cmd = cleanCommand(String(item.command ?? ''))
    const parsed = parseCommand(cmd)
    const exitCode = item.exit_code as number | null | undefined
    const output = String(item.aggregated_output ?? '')
    process.stdout.write(`${tag()} ${toolLabel(parsed.tool, parsed.icon)} ${parsed.label}\n`)

    // Guarded reads (e.g. `test -f X && sed X`) exit 1 when the file is
    // missing — surface that as "not found" instead of a red error.
    if (exitCode !== 0 && parsed.guardedRead && !output.trim()) {
      process.stdout.write(`       ${c('gray', '↳')} ${c('dim', 'not found')}\n`)
      return
    }

    const summary = summarizeOutput(output, 140)
    if (exitCode === 0) {
      process.stdout.write(`       ${c('gray', '↳')} ${summary}\n`)
    } else if (exitCode != null) {
      process.stdout.write(`       ${c('red', `✗ (exit ${exitCode})`)} ${summary}\n`)
    } else {
      process.stdout.write(`       ${c('yellow', '…')} ${summary}\n`)
    }
    return
  }

  if (type === 'file_change') {
    const changes = Array.isArray(item.changes) ? (item.changes as AnyObj[]) : []
    for (const ch of changes) {
      const kind = String(ch.kind ?? 'update')
      const path = relPath(String(ch.path ?? ''))
      const tool = kind === 'add' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit'
      process.stdout.write(
        `${tag()} ✏️  ${c('cyan', tool.padEnd(6))} ${kindIcon(kind)} ${c('bold', path)}\n`,
      )
      process.stdout.write(`       ${c('gray', '↳')} ${c('green', '✓ applied')}\n`)
    }
    return
  }
}

function handleLine(line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg: AnyObj
  try {
    msg = JSON.parse(trimmed) as AnyObj
  } catch {
    return
  }

  const type = msg.type as string | undefined

  if (type === 'thread.started') {
    const id = String(msg.thread_id ?? '').slice(0, 8)
    process.stdout.write(`${tag()} ${c('magenta', 'thread')} ${c('bold', id)}\n\n`)
    return
  }

  if (type === 'item.completed') {
    const item = msg.item as AnyObj | undefined
    if (item) handleCompleted(item)
    return
  }

  if (type === 'turn.completed') {
    const usage = msg.usage as AnyObj | undefined
    const inTok = Number(usage?.input_tokens ?? 0)
    const outTok = Number(usage?.output_tokens ?? 0)
    totalInTokens += inTok
    totalOutTokens += outTok
    turnCount += 1
    process.stdout.write(
      `\n${tag()} ${c('green', '✓ turn done')} ${c('dim', `(${inTok} in / ${outTok} out)`)}\n`,
    )
    return
  }
}

function resetSessionState(): void {
  totalInTokens = 0
  totalOutTokens = 0
  turnCount = 0
  reasoningCount = 0
}

function writeSessionSummary(): void {
  if (turnCount === 0 && totalInTokens === 0 && totalOutTokens === 0) return
  const parts: string[] = [`${totalInTokens} in / ${totalOutTokens} out`]
  if (turnCount > 0) parts.push(`${turnCount} turn${turnCount === 1 ? '' : 's'}`)
  if (reasoningCount > 0) parts.push(`${reasoningCount} reasoning step${reasoningCount === 1 ? '' : 's'}`)
  parts.push(`${elapsed()} total`)
  process.stdout.write(
    `\n${tag()} ${c('green', '✓ session done')} ${c('dim', `(${parts.join(' · ')})`)}\n`,
  )
}

if (require.main === module) {
  let buffer = ''
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      handleLine(line)
    }
  })
  process.stdin.on('end', () => {
    if (buffer) handleLine(buffer)
    writeSessionSummary()
  })
}

export {
  c,
  elapsed,
  tag,
  relPath,
  truncate,
  summarizeOutput,
  cleanCommand,
  parseCommand,
  toolLabel,
  quote,
  kindIcon,
  handleCompleted,
  handleLine,
  writeSessionSummary,
  resetSessionState,
}
