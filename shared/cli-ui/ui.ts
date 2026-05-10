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

export { colorEnabled, c, style }
