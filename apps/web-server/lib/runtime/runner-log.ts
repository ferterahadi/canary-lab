// Plain-text "runner log" — captures the runner's own progress narration to a
// per-run `runner.log` file alongside `svc-*.log`, `playwright.log`, and
// `agent-transcript.log`. Two upstream sources tee through here:
//
//  1. `RunOrchestrator` lifecycle events (service-started, health-check,
//     playwright-started, signal-detected, run-complete, …).
//  2. The CLI shim's own banners / section headers / status bullets, routed
//     through `cli-ui/ui.ts`'s helpers via `setActiveRunnerLog`.
//
// One line per entry: `<ISO timestamp> <LEVEL> <message>`. ANSI escapes
// stripped. Append-mode fs writes so concurrent producers (orchestrator on its
// own thread of control, cli-ui helpers from the foreground) interleave
// safely without locking.

import fs from 'fs'
import path from 'path'
import type { OrchestratorEventMap } from './orchestrator'

export type RunnerLogLevel = 'INFO' | 'WARN' | 'ERROR'

const ANSI_RE = /\x1b\[[0-9;]*m/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function formatLine(level: RunnerLogLevel, message: string, now: Date = new Date()): string {
  const ts = now.toISOString()
  const cleaned = stripAnsi(message).replace(/\r?\n+$/, '')
  // Pad level to a fixed width so columns align in the file.
  const lvl = level.padEnd(5, ' ')
  return `${ts} ${lvl} ${cleaned}\n`
}

// Pure, dependency-free renderer. Returns null for events we deliberately
// don't surface in runner.log (e.g. service-output / playwright-output / agent-
// output — those have their own dedicated log files already).
export function renderEvent<K extends keyof OrchestratorEventMap>(
  event: K,
  payload: OrchestratorEventMap[K],
): { level: RunnerLogLevel; message: string } | null {
  switch (event) {
    case 'service-started': {
      const p = payload as OrchestratorEventMap['service-started']
      return { level: 'INFO', message: `Service started: ${p.service.name} (pid=${p.pid})` }
    }
    case 'service-exit': {
      const p = payload as OrchestratorEventMap['service-exit']
      const lvl: RunnerLogLevel = p.exitCode === 0 ? 'INFO' : 'WARN'
      return { level: lvl, message: `Service exited: ${p.service.name} code=${p.exitCode}` }
    }
    case 'health-check': {
      const p = payload as OrchestratorEventMap['health-check']
      const tag = p.transport ? ` (${p.transport})` : ''
      return p.healthy
        ? { level: 'INFO', message: `Health check passed${tag}: ${p.service.name}` }
        : { level: 'ERROR', message: `Health check failed${tag}: ${p.service.name}` }
    }
    case 'playwright-started': {
      const p = payload as OrchestratorEventMap['playwright-started']
      return { level: 'INFO', message: `Running Playwright tests: ${p.command}` }
    }
    case 'playwright-exit': {
      const p = payload as OrchestratorEventMap['playwright-exit']
      return {
        level: p.exitCode === 0 ? 'INFO' : 'WARN',
        message: `Playwright exited: code=${p.exitCode}`,
      }
    }
    case 'agent-started': {
      const p = payload as OrchestratorEventMap['agent-started']
      return { level: 'INFO', message: `Heal agent started (cycle ${p.cycle}): ${p.command}` }
    }
    case 'agent-exit': {
      const p = payload as OrchestratorEventMap['agent-exit']
      return { level: 'INFO', message: `Heal agent exited: code=${p.exitCode}` }
    }
    case 'heal-cycle-started': {
      const p = payload as OrchestratorEventMap['heal-cycle-started']
      return {
        level: 'INFO',
        message: `Heal cycle ${p.cycle} starting (failures: ${p.failureSignature || 'none'})`,
      }
    }
    case 'signal-detected': {
      const p = payload as OrchestratorEventMap['signal-detected']
      return { level: 'INFO', message: `Signal detected: .${p.kind}` }
    }
    case 'run-status': {
      const p = payload as OrchestratorEventMap['run-status']
      return { level: 'INFO', message: `Run status: ${p.status}` }
    }
    case 'run-complete': {
      const p = payload as OrchestratorEventMap['run-complete']
      return { level: 'INFO', message: `Run complete: status=${p.status}` }
    }
    // service-output / playwright-output / agent-output: skip — they're
    // already captured in dedicated per-source logs.
    default:
      return null
  }
}

export class RunnerLog {
  private closed = false

  constructor(public readonly logPath: string) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '')
  }

  write(level: RunnerLogLevel, message: string): void {
    if (this.closed) return
    try {
      fs.appendFileSync(this.logPath, formatLine(level, message))
    } catch {
      /* best-effort — never blow up the runner over a log write */
    }
  }

  info(message: string): void { this.write('INFO', message) }
  warn(message: string): void { this.write('WARN', message) }
  error(message: string): void { this.write('ERROR', message) }

  // Records an orchestrator lifecycle event. No-op for events that don't have
  // a runner-log surface (service-output etc.).
  recordEvent<K extends keyof OrchestratorEventMap>(
    event: K,
    payload: OrchestratorEventMap[K],
  ): void {
    const rendered = renderEvent(event, payload)
    if (!rendered) return
    this.write(rendered.level, rendered.message)
  }

  close(): void {
    this.closed = true
  }
}
