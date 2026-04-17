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
    process.stdout.write(`${tag()} ${c('magenta', 'thinking')} ${c('dim', truncate(text.split('\n')[0], 100))}\n`)
    return
  }

  if (type === 'command_execution') {
    const cmd = cleanCommand(String(item.command ?? ''))
    const exitCode = item.exit_code as number | null | undefined
    const output = String(item.aggregated_output ?? '')
    const statusIcon =
      exitCode === 0 ? c('green', '✓') : exitCode != null ? c('red', `✗ (exit ${exitCode})`) : c('yellow', '…')
    process.stdout.write(`${tag()} ${c('cyan', '$')} ${truncate(cmd, 160)}\n`)
    const summary = summarizeOutput(output, 140)
    process.stdout.write(`       ${statusIcon} ${summary}\n`)
    return
  }

  if (type === 'file_change') {
    const changes = Array.isArray(item.changes) ? (item.changes as AnyObj[]) : []
    for (const ch of changes) {
      const kind = String(ch.kind ?? 'update')
      const path = relPath(String(ch.path ?? ''))
      process.stdout.write(`${tag()} ${c('cyan', '✏️ ')} ${kindIcon(kind)} ${c('bold', path)}\n`)
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
    process.stdout.write(
      `\n${tag()} ${c('green', '✓ turn done')} ${c('dim', `(${inTok} in / ${outTok} out)`)}\n`,
    )
    return
  }
}

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
})
