#!/usr/bin/env node
/*
 * Wizard-specific Claude stream formatter.
 *
 * The Add Test wizard needs live progress, but its parser still expects the
 * final <plan-output>/<file> blocks to be present exactly as text. Assistant
 * text is emitted raw and only tool/progress events are summarized.
 */
export {}
import { c } from '../../../../shared/cli-ui/colors'

interface AnyObj {
  [key: string]: unknown
}

const CWD = process.cwd()

const START = Date.now()
interface PendingTool {
  name: string
  input: AnyObj
}

const pendingTools = new Map<string, PendingTool>()
const SESSION_MARKER = '[[canary-lab:wizard-session'
const announcedPartialFiles = new Set<string>()
let announcedDrafting = false
let lastRawAssistantText = ''

function elapsed(): string {
  const s = Math.floor((Date.now() - START) / 1000)
  const mm = Math.floor(s / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

function tag(): string {
  return c('gray', `[${elapsed()}]`)
}

function truncate(text: string, max = 140): string {
  return text.length > max ? text.slice(0, max - 1) + '...' : text
}

function relPath(p: string): string {
  if (!p) return ''
  if (p.startsWith(CWD + '/')) return p.slice(CWD.length + 1)
  if (p === CWD) return '.'
  return p.replace(process.env.HOME ?? '', '~')
}

const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️ ',
  Write: '✏️ ',
  Bash: '$',
  Glob: '🔍',
  Grep: '🔍',
  TodoWrite: '📋',
  Task: '🤖',
  WebFetch: '🌐',
  WebSearch: '🌐',
}

function toolLabel(name: string): string {
  const icon = TOOL_ICONS[name] ?? '•'
  return `${icon} ${c('cyan', name)}`
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
      return c('dim', truncate(JSON.stringify(input), 100))
  }
}

function compact(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim())
  try {
    return truncate(JSON.stringify(value).replace(/\s+/g, ' '))
  } catch {
    return ''
  }
}

function toolSummary(name: string, input: AnyObj): string {
  if (name === 'Bash') return compact(input.command)
  if (name === 'Read') return compact(input.file_path)
  if (name === 'Grep') return compact(input.pattern)
  if (name === 'Glob') return compact(input.pattern)
  if (name === 'Edit' || name === 'Write') return compact(input.file_path)
  return compact(input)
}

function resultSummary(raw: unknown): string {
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? String((raw.find((item: AnyObj) => item.type === 'text') as AnyObj | undefined)?.text ?? '')
        : ''
  const first = text.trim().split('\n').find((line) => line.trim().length > 0)
  return first ? truncate(first.trim()) : ''
}

function toolResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (!Array.isArray(raw)) return ''
  return raw
    .map((item: AnyObj) => item.type === 'text' && typeof item.text === 'string' ? item.text : '')
    .filter((text) => text.length > 0)
    .join('\n')
}

function formatFullToolResult(text: string): string | null {
  const cleaned = text.trimEnd()
  if (!cleaned.trim()) return null
  return cleaned
    .split('\n')
    .map((line, idx) => `${idx === 0 ? c('gray', '       ->') : c('gray', '         ')} ${line}`)
    .join('\n')
}

function countNonEmptyLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length
}

function formatMetric(label: string, count: number): string {
  return `${label}: ${count.toLocaleString('en-US')}`
}

function isBashReadInspection(command: string): boolean {
  if (/^(cat|head|tail)(?:\s|$)/.test(command)) return true
  return /^sed\s+-n\s+(['"])(?:\d+,\d+p|\/.+?\/,\/.+?\/p)\1\s+\S+/.test(command)
}

function splitShellPipes(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const ch of command) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      current += ch
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '|') {
      segments.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current.trim())
  return segments.filter(Boolean)
}

function bashInspectionSummary(command: string, text: string): string | null {
  if (isBashReadInspection(command)) {
    return formatMetric('Number of characters', text.length)
  }
  if (/^(ls|find)(?:\s|$)/.test(command)) {
    return formatMetric('Number of files', countNonEmptyLines(text))
  }

  const segments = splitShellPipes(command)
  const [inspection, ...pipes] = segments
  const inspectionLike = segments.some((segment) => /(?:^|[\s;&()])(cat|head|tail|sed|grep|rg|ls|find)(?:\s|$)/.test(segment))
  if (!inspection || !/^(grep|rg)(?:\s|$)/.test(inspection)) {
    return inspectionLike ? 'Content read.' : null
  }
  if (!pipes.every((pipe) => /^(head|sort|wc)(?:\s|$)/.test(pipe))) return 'Content read.'

  const wcLineCount = pipes.some((pipe) => /^wc(?:\s|$)/.test(pipe) && /(?:^|\s)-l(?:\s|$)/.test(pipe))
  if (wcLineCount) {
    const match = text.trim().match(/^(\d+)/)
    if (match) return formatMetric('Number of matches', Number(match[1]))
  }
  return formatMetric('Number of matches', countNonEmptyLines(text))
}

function inspectionSummary(tool: PendingTool | undefined, text: string): string | null {
  if (!tool) return null
  if (tool.name === 'Read') return formatMetric('Number of characters', text.length)
  if (tool.name === 'Glob') return formatMetric('Number of files', countNonEmptyLines(text))
  if (tool.name === 'Grep') return formatMetric('Number of matches', countNonEmptyLines(text))
  if (tool.name !== 'Bash') return null

  const command = String(tool.input.command ?? '').trim()
  return bashInspectionSummary(command, text)
}

function isPartialAssistantMessage(msg: AnyObj): boolean {
  const message = msg.message as AnyObj | undefined
  return msg.partial === true
    || msg.is_partial === true
    || message?.partial === true
    || (
      message !== undefined
      && Object.prototype.hasOwnProperty.call(message, 'stop_reason')
      && message.stop_reason == null
    )
}

function emitPartialProgress(text: string): void {
  const matches = [...text.matchAll(/<file\s+path="([^"]+)"/g)]
  if (matches.length === 0) {
    if (!announcedDrafting && text.trim()) {
      announcedDrafting = true
      process.stdout.write(`${tag()} ${c('magenta', 'drafting')} ${c('dim', 'spec output...')}\n`)
    }
    return
  }
  for (const match of matches) {
    const filePath = match[1]
    if (!filePath || announcedPartialFiles.has(filePath)) continue
    announcedPartialFiles.add(filePath)
    process.stdout.write(`${tag()} ${c('magenta', 'writing')} ${c('dim', filePath)}\n`)
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

  if (type === 'system' && msg.subtype === 'init') {
    const fullSid = typeof msg.session_id === 'string' ? msg.session_id : ''
    const sid = fullSid.slice(0, 8)
    const model = String(msg.model ?? 'unknown')
    if (fullSid) {
      process.stdout.write(`${SESSION_MARKER} agent=claude id=${fullSid}]]\n`)
    }
    process.stdout.write(
      `${tag()} ${c('magenta', 'session')} ${c('bold', sid || 'started')} ${c('dim', `(${model})`)}\n\n`,
    )
    return
  }

  if (type === 'assistant') {
    const message = msg.message as AnyObj | undefined
    const content = message?.content as Array<AnyObj> | undefined
    if (!Array.isArray(content)) return
    const partial = isPartialAssistantMessage(msg)
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (partial) {
          emitPartialProgress(block.text)
          continue
        }
        const text = block.text.trimEnd()
        process.stdout.write(`${text}\n`)
        lastRawAssistantText = text.trim()
        continue
      }
      if (block.type === 'thinking') {
        const text = typeof block.thinking === 'string' ? block.thinking.trim() : ''
        if (text) process.stdout.write(`${tag()} ${c('magenta', 'thinking')} ${c('dim', truncate(text.split('\n')[0]))}\n`)
        continue
      }
      if (block.type === 'tool_use') {
        const name = String(block.name ?? 'tool')
        const id = String(block.id ?? '')
        if (id) pendingTools.set(id, { name, input: block.input as AnyObj })
        process.stdout.write(`${tag()} ${toolLabel(name)} ${formatToolCall(name, block.input as AnyObj)}\n`)
      }
    }
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
      const text = toolResultText(block.content)
      const summary = block.is_error === true ? null : inspectionSummary(pending, text)
      if (summary) {
        process.stdout.write(`${c('gray', '       ->')} ${c('dim', summary)}\n`)
        continue
      }
      const formatted = formatFullToolResult(text)
      if (!formatted) continue
      if (block.is_error === true) {
        process.stdout.write(formatted.replace(c('gray', '       ->'), c('red', '       x')) + '\n')
      } else {
        process.stdout.write(`${formatted}\n`)
      }
    }
    return
  }

  if (type === 'result') {
    const finalText = typeof msg.result === 'string' ? msg.result.trim() : ''
    if (finalText && finalText !== lastRawAssistantText) {
      process.stdout.write(`${finalText}\n`)
      lastRawAssistantText = finalText
    }
    const durationMs = Number(msg.duration_ms ?? 0)
    const isError = msg.is_error === true
    const label = isError ? c('red', 'failed') : c('green', 'done')
    const dur = durationMs > 0 ? ` in ${(durationMs / 1000).toFixed(1)}s` : ''
    process.stdout.write(`\n${tag()} ${label}${c('dim', dur)}\n`)
  }
}

/* v8 ignore next -- CLI stdin wiring is exercised through the exported line handler. */
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
  elapsed,
  tag,
  truncate,
  relPath,
  toolLabel,
  formatToolCall,
  toolSummary,
  resultSummary,
  toolResultText,
  formatFullToolResult,
  countNonEmptyLines,
  isBashReadInspection,
  splitShellPipes,
  inspectionSummary,
  handleLine,
}
