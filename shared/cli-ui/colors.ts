/*
 * Shared ANSI color helpers for Canary Lab's CLI output.
 * Respects NO_COLOR and non-TTY stdout.
 */

export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const

export type AnsiColor = keyof typeof ansi

export function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}

export function c(color: AnsiColor, text: string): string {
  if (!colorEnabled()) return text
  return `${ansi[color]}${text}${ansi.reset}`
}

export function style(colors: AnsiColor[], text: string): string {
  if (!colorEnabled()) return text
  const prefix = colors.map((k) => ansi[k]).join('')
  return `${prefix}${text}${ansi.reset}`
}
