#!/usr/bin/env node
/*
 * Parses Claude Code `--output-format=stream-json --verbose` on stdin and
 * prints a human-readable stream to stdout. Used by the heal-agent tab so
 * users can see the agent working instead of staring at a blank terminal.
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
  blue: '\x1b[34m',
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
  return p.replace(process.env.HOME ?? '', '~')
}

// Strip `cat -n` style line-number prefixes that Claude's Read tool emits:
// `   1\tcontent\n   2\tcontent\n...` → `content\ncontent\n...`
function stripLineNumbers(text: string): string {
  return text.replace(/^\s*\d+\t/gm, '')
}

function firstNonEmpty(text: string): string {
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.trim().length > 0) return line.trim()
  }
  return ''
}

function summarizeResult(text: string, maxLen = 140): string {
  const cleaned = stripLineNumbers(text).trim()
  if (!cleaned) return c('dim', '(empty)')
  const lines = cleaned.split('\n').filter((l) => l.trim().length > 0)
  const head = lines[0].trim()
  const truncated = head.length > maxLen ? head.slice(0, maxLen - 1) + '…' : head
  if (lines.length > 1) {
    return `${truncated} ${c('dim', `(+${lines.length - 1} more lines)`)}`
  }
  return truncated
}

const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️ ',
  Write: '✏️ ',
  Bash: '$ ',
  Glob: '🔍',
  Grep: '🔍',
  TodoWrite: '📋',
  Task: '🤖',
  WebFetch: '🌐',
  WebSearch: '🌐',
}

function toolLabel(name: string): string {
  const icon = TOOL_ICONS[name] ?? '•'
  return `${icon} ${c('cyan', name.padEnd(6))}`
}

function formatToolCall(name: string, input: AnyObj): string {
  if (!input || typeof input !== 'object') return ''
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command ?? '')
      const desc = input.description ? ` ${c('dim', `# ${input.description}`)}` : ''
      return `${cmd}${desc}`
    }
    case 'Read': {
      const filePath = c('bold', relPath(String(input.file_path ?? '')))
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      // Surfacing the line range turns "narrow Read (good)" vs "full-file Read (banned)"
      // into a visible difference in the tab — critical for the heal-loop discipline.
      if (offset !== undefined && limit !== undefined) {
        return `${filePath} ${c('dim', `L${offset}-${offset + limit - 1}`)}`
      }
      if (offset !== undefined) return `${filePath} ${c('dim', `from L${offset}`)}`
      if (limit !== undefined) return `${filePath} ${c('dim', `L1-${limit}`)}`
      return filePath
    }
    case 'Edit': {
      const filePath = c('bold', relPath(String(input.file_path ?? '')))
      const oldLines = String(input.old_string ?? '').split('\n').length
      const newLines = String(input.new_string ?? '').split('\n').length
      const all = input.replace_all === true ? ' (all)' : ''
      if (!input.old_string && !input.new_string) return filePath
      return `${filePath} ${c('dim', `−${oldLines} +${newLines}${all}`)}`
    }
    case 'Write': {
      const filePath = c('bold', relPath(String(input.file_path ?? '')))
      const content = typeof input.content === 'string' ? input.content : ''
      if (!content) return filePath
      const lines = content.split('\n').length
      return `${filePath} ${c('dim', `${lines}L`)}`
    }
    case 'Glob': {
      const path = input.path ? ` in ${relPath(String(input.path))}` : ''
      return `${c('bold', String(input.pattern ?? ''))}${path}`
    }
    case 'Grep': {
      const p = input.path ? ` in ${relPath(String(input.path))}` : ''
      const glob = input.glob ? ` ${c('dim', `(${input.glob})`)}` : ''
      return `${c('bold', String(input.pattern ?? ''))}${p}${glob}`
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : []
      return c('dim', `${todos.length} todo${todos.length === 1 ? '' : 's'}`)
    }
    default:
      return c('dim', truncateRaw(JSON.stringify(input), 100))
  }
}

function truncateRaw(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function formatToolResult(name: string, text: string): string | null {
  const cleaned = text.trim()
  if (!cleaned) return null
  switch (name) {
    case 'Edit':
    case 'Write':
      // Claude's edit/write responses tend to be verbose — short ack is plenty.
      return c('green', '✓ applied')
    case 'Read':
      // Read results are just file content — shown inline is noise.
      return c('dim', summarizeResult(cleaned, 80))
    case 'Bash': {
      const first = firstNonEmpty(stripLineNumbers(cleaned))
      if (!first) return c('green', '✓')
      return summarizeResult(cleaned)
    }
    default:
      return summarizeResult(cleaned)
  }
}

interface PendingTool {
  name: string
}

const pendingTools = new Map<string, PendingTool>()

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

  if (type === 'system' && msg.subtype === 'init') {
    const sid = String(msg.session_id ?? '').slice(0, 8)
    const model = String(msg.model ?? 'unknown')
    process.stdout.write(
      `${tag()} ${c('magenta', 'session')} ${c('bold', sid)} ${c('dim', `(${model})`)}\n\n`,
    )
    return
  }

  if (type === 'assistant') {
    const message = msg.message as AnyObj | undefined
    const content = message?.content as Array<AnyObj> | undefined
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const lines = block.text.trim().split('\n')
        const quoted = lines.map((l) => `  ${c('dim', '│')} ${l}`).join('\n')
        process.stdout.write(`\n${quoted}\n`)
      } else if (block.type === 'thinking') {
        // Claude usually emits signature-only thinking (encrypted, text empty).
        // Print a one-liner only when extended thinking surfaces actual text.
        const text = typeof block.thinking === 'string' ? block.thinking.trim() : ''
        if (!text) continue
        const first = text.split('\n')[0]
        const clipped = first.length > 120 ? first.slice(0, 119) + '…' : first
        process.stdout.write(`${tag()} ${c('magenta', '💭 thinking')} ${c('dim', clipped)}\n`)
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? 'tool')
        const id = String(block.id ?? '')
        if (id) pendingTools.set(id, { name })
        const summary = formatToolCall(name, block.input as AnyObj)
        process.stdout.write(`${tag()} ${toolLabel(name)} ${summary}\n`)
      }
    }
    return
  }

  // Claude Code emits periodic rate-limit pings and SessionStart hook chatter.
  // Neither is actionable for the operator watching the tab — drop silently.
  if (type === 'rate_limit_event') return
  if (type === 'system' && (msg.subtype === 'hook_started' || msg.subtype === 'hook_response')) {
    return
  }

  if (type === 'user') {
    const message = msg.message as AnyObj | undefined
    const content = message?.content as Array<AnyObj> | undefined
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const id = String(block.tool_use_id ?? '')
      const pending = pendingTools.get(id)
      pendingTools.delete(id)
      const name = pending?.name ?? 'tool'
      const raw = block.content
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? (raw.find((r: AnyObj) => r.type === 'text') as AnyObj | undefined)?.text ?? ''
            : ''
      if (typeof text !== 'string') continue
      const isError = block.is_error === true
      const summary = formatToolResult(name, text)
      if (!summary) continue
      const prefix = isError ? c('red', '       ✗') : c('gray', '       ↳')
      process.stdout.write(`${prefix} ${summary}\n`)
    }
    return
  }

  if (type === 'result') {
    const durationMs = Number(msg.duration_ms ?? 0)
    const durS = (durationMs / 1000).toFixed(1)
    const isError = msg.is_error === true
    const marker = isError ? c('red', '✗ failed') : c('green', '✓ done')
    process.stdout.write(`\n${tag()} ${marker} ${c('dim', `in ${durS}s`)}\n`)

    const usage = msg.usage as AnyObj | undefined
    const inTok = Number(usage?.input_tokens ?? 0)
    const outTok = Number(usage?.output_tokens ?? 0)
    const cacheRead = Number(usage?.cache_read_input_tokens ?? 0)
    const cacheCreate = Number(usage?.cache_creation_input_tokens ?? 0)
    const turns = Number(msg.num_turns ?? 0)
    const cost = Number(msg.total_cost_usd ?? 0)
    // Pro/Max subscription users aren't billed `total_cost_usd` — it's the
    // API-equivalent price Claude Code prints regardless of plan. Hide it by
    // default; operators who want it can opt in with CANARY_HEAL_SHOW_COST=1.
    const showCost = process.env.CANARY_HEAL_SHOW_COST === '1'
    if (inTok || outTok || turns || cost) {
      const parts: string[] = [`${inTok} in / ${outTok} out`]
      if (cacheRead || cacheCreate) {
        parts.push(`${cacheRead} cache read · ${cacheCreate} cache created`)
      }
      if (turns > 0) parts.push(`${turns} turn${turns === 1 ? '' : 's'}`)
      if (cost > 0 && showCost) parts.push(`$${cost.toFixed(4)}`)
      process.stdout.write(`       ${c('dim', parts.join(' · '))}\n`)
    }
    return
  }
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
  })
}

export {
  c,
  elapsed,
  tag,
  relPath,
  stripLineNumbers,
  firstNonEmpty,
  summarizeResult,
  toolLabel,
  formatToolCall,
  formatToolResult,
  handleLine,
}
