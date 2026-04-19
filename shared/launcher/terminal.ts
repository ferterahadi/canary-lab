import { execFileSync } from 'child_process'
import type { StartTab } from './startup'

export function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Close any Terminal.app tabs whose custom title starts with one of the given
 * prefixes. Custom title is set by `openTerminalTabs` via AppleScript.
 */
export function closeTerminalTabsByPrefix(prefixes: string[]): void {
  if (prefixes.length === 0) return
  const conds = prefixes
    .map((p) => `(custom title of t starts with "${escape(p)}")`)
    .join(' or ')

  const script = `
tell application "Terminal"
  repeat with w in (windows as list)
    set tabsToClose to {}
    repeat with t in (tabs of w as list)
      try
        if ${conds} then
          set end of tabsToClose to t
        end if
      end try
    end repeat
    repeat with t in tabsToClose
      try
        close t saving no
      end try
    end repeat
  end repeat
end tell
`
  try {
    execFileSync('osascript', ['-e', script], { stdio: 'ignore' })
  } catch {
    /* Terminal not running or close failed — non-fatal */
  }
}

export function openTerminalTabs(tabs: StartTab[], label: string): void {
  if (tabs.length === 0) return

  const commands = tabs.map(({ dir, command, name }, i) => {
    const title = escape(name ?? `tab-${i + 1}`)
    const runCmd = `cd ${escape(dir)} && ${escape(command)}`
    if (i === 0) {
      return [
        `set newTab to do script "${runCmd}"`,
        `set custom title of newTab to "${title}"`,
      ].join('\n  ')
    }
    return [
      `tell application "System Events" to keystroke "t" using command down`,
      `delay 0.5`,
      `set newTab to do script "${runCmd}" in front window`,
      `set custom title of newTab to "${title}"`,
    ].join('\n    ')
  })

  const script = `
tell application "Terminal"
  activate
  ${commands.join('\n  ')}
end tell
`

  if (label) console.log(label)
  execFileSync('osascript', ['-e', script], { stdio: 'inherit' })
}
