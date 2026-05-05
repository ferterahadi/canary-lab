#!/usr/bin/env node
/*
 * Wizard-specific Codex JSONL formatter. Assistant messages are emitted raw so
 * the wizard parser can still extract <plan-output> and <file> blocks.
 */
export {}

interface AnyObj {
  [key: string]: unknown
}

const START = Date.now()

function elapsed(): string {
  const s = Math.floor((Date.now() - START) / 1000)
  const mm = Math.floor(s / 60)
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

function tag(): string {
  return `[${elapsed()}]`
}

function truncate(text: string, max = 140): string {
  return text.length > max ? text.slice(0, max - 1) + '...' : text
}

function cleanCommand(cmd: string): string {
  const m = cmd.match(/^\/[^ ]+\s+-l?c\s+['"](.+)['"]$/s)
  return m ? m[1] : cmd
}

function summarizeOutput(text: string): string {
  const first = text.trim().split('\n').find((line) => line.trim().length > 0)
  return first ? truncate(first.trim()) : '(no output)'
}

function handleCompleted(item: AnyObj): void {
  const type = item.type as string | undefined

  if (type === 'agent_message') {
    const text = String(item.text ?? '').trim()
    if (text) process.stdout.write(`${text}\n`)
    return
  }

  if (type === 'reasoning') {
    const text = String(item.text ?? '').trim()
    if (text) process.stdout.write(`${tag()} thinking ${truncate(text.split('\n')[0])}\n`)
    return
  }

  if (type === 'command_execution') {
    const cmd = cleanCommand(String(item.command ?? '')).trim()
    const exitCode = item.exit_code as number | null | undefined
    const output = String(item.aggregated_output ?? '')
    const state = exitCode === 0 ? 'ok' : exitCode == null ? 'running' : `exit ${exitCode}`
    process.stdout.write(`${tag()} command ${truncate(cmd, 160)} (${state})\n`)
    if (output.trim()) process.stdout.write(`${tag()} output ${summarizeOutput(output)}\n`)
    return
  }

  if (type === 'file_change') {
    const changes = Array.isArray(item.changes) ? (item.changes as AnyObj[]) : []
    for (const change of changes) {
      process.stdout.write(`${tag()} file ${String(change.kind ?? 'update')} ${String(change.path ?? '')}\n`)
    }
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
    process.stdout.write(`${tag()} thread ${id || 'started'}\n`)
    return
  }
  if (type === 'item.completed') {
    const item = msg.item as AnyObj | undefined
    if (item) handleCompleted(item)
    return
  }
  if (type === 'turn.completed') {
    const usage = msg.usage as AnyObj | undefined
    const input = Number(usage?.input_tokens ?? 0)
    const output = Number(usage?.output_tokens ?? 0)
    process.stdout.write(`${tag()} turn done (${input} in / ${output} out)\n`)
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

export { elapsed, tag, truncate, cleanCommand, summarizeOutput, handleCompleted, handleLine }
