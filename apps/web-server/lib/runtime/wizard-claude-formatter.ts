#!/usr/bin/env node
/*
 * Wizard-specific Claude stream formatter.
 *
 * The Add Test wizard needs live progress, but its parser still expects the
 * final <plan-output>/<file> blocks to be present exactly as text. Unlike the
 * heal-agent formatter, assistant text is emitted raw and only tool/progress
 * events are summarized.
 */
export {}
import {
  c,
  formatToolCall,
  formatToolResult,
  toolLabel,
} from './claude-formatter'

interface AnyObj {
  [key: string]: unknown
}

const START = Date.now()
interface PendingTool {
  name: string
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
        if (id) pendingTools.set(id, { name })
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
      const name = pending?.name ?? 'tool'
      const raw = block.content
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? (raw.find((item: AnyObj) => item.type === 'text') as AnyObj | undefined)?.text ?? ''
            : ''
      if (typeof text !== 'string') continue
      const summary = formatToolResult(name, text)
      if (!summary) continue
      const prefix = block.is_error === true ? c('red', '       x') : c('gray', '       ->')
      process.stdout.write(`${prefix} ${summary}\n`)
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

export { elapsed, tag, truncate, toolSummary, resultSummary, handleLine }
