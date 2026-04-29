/*
 * Higher-level CLI printers built on top of shared/cli-ui/colors.
 * Aim: consistent indentation, professional hierarchy, no external deps.
 *
 * Layout rule:
 *   - Top-level messages (banners, sections, standalone status) are flush-left.
 *   - List items, steps, and box contents indent by 2 spaces.
 */
import { c, style, colorEnabled } from './colors'

const INDENT = '  '

// ─── Runner-log teeing ─────────────────────────────────────────────────────
//
// When the e2e runner is active, the CLI shim installs a sink here so every
// banner / section / status message is also captured into the per-run
// `runner.log` file. Web mode never installs one, so all this becomes a no-op
// branch.

interface RunnerLogSink {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

let activeRunnerLog: RunnerLogSink | null = null

export function setActiveRunnerLog(log: RunnerLogSink | null): void {
  activeRunnerLog = log
}

function teeInfo(message: string): void {
  activeRunnerLog?.info(message)
}
function teeWarn(message: string): void {
  activeRunnerLog?.warn(message)
}
function teeError(message: string): void {
  activeRunnerLog?.error(message)
}

export function line(): void {
  console.log('')
}

export function banner(title: string): void {
  const rule = '─'.repeat(Math.max(8, title.length))
  console.log('')
  console.log(style(['bold', 'cyan'], title))
  console.log(c('gray', rule))
  teeInfo(title)
}

export function section(label: string): void {
  console.log('')
  console.log(style(['bold'], label))
  teeInfo(label)
}

export function step(n: number, text: string): void {
  console.log(`${INDENT}${c('gray', `${n}.`)} ${text}`)
  teeInfo(`${n}. ${text}`)
}

export function bullet(text: string): void {
  console.log(`${INDENT}${c('gray', '•')} ${text}`)
  teeInfo(text)
}

export function kv(key: string, value: string | number): void {
  console.log(`${INDENT}${c('dim', `${key}:`)} ${value}`)
  teeInfo(`${key}: ${value}`)
}

export function ok(text: string): void {
  console.log(`${c('green', '✓')} ${text}`)
  teeInfo(`OK ${text}`)
}

export function fail(text: string): void {
  console.error(`${c('red', '✗')} ${text}`)
  teeError(text)
}

export function warn(text: string): void {
  console.log(`${c('yellow', '!')} ${text}`)
  teeWarn(text)
}

export function info(text: string): void {
  console.log(`${c('cyan', '›')} ${text}`)
  teeInfo(text)
}

export function dim(text: string): string {
  return c('dim', text)
}

export function path(text: string): string {
  return c('cyan', text)
}

export function muted(text: string): void {
  console.log(c('gray', text))
}

export interface SummaryRow {
  label: string
  value: string | number
  tone?: 'default' | 'good' | 'bad' | 'warn'
}

function toneColor(tone: SummaryRow['tone']): string {
  return tone === 'good' ? 'green' : tone === 'bad' ? 'red' : tone === 'warn' ? 'yellow' : ''
}

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length
}

export function summaryBox(title: string, rows: SummaryRow[], extraLines: string[] = []): void {
  const labelWidth = Math.max(...rows.map((r) => r.label.length), 0)
  const valueStrings = rows.map((r) => {
    const valStr = String(r.value)
    const color = toneColor(r.tone)
    return color ? c(color as any, valStr) : valStr
  })
  const formatted = rows.map((r, i) => {
    const padded = r.label.padEnd(labelWidth, ' ')
    return `${c('dim', padded)}  ${valueStrings[i]}`
  })
  const allLines = [...formatted, ...extraLines]
  const contentWidth = Math.max(
    title.length,
    ...allLines.map(visibleLength),
  )
  const width = contentWidth + 2 // one space pad each side
  const top = '╭' + '─'.repeat(width) + '╮'
  const bot = '╰' + '─'.repeat(width) + '╯'
  const titlePad = ' '.repeat(width - title.length - 1)
  console.log('')
  console.log(c('gray', top))
  console.log(`${c('gray', '│')} ${style(['bold'], title)}${titlePad}${c('gray', '│')}`)
  console.log(c('gray', '├' + '─'.repeat(width) + '┤'))
  for (const ln of allLines) {
    const pad = ' '.repeat(width - visibleLength(ln) - 1)
    console.log(`${c('gray', '│')} ${ln}${pad}${c('gray', '│')}`)
  }
  console.log(c('gray', bot))
}

export { colorEnabled, c, style }
