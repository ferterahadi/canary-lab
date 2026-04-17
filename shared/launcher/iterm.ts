import { execFileSync } from 'child_process'
import type { StartTab } from './startup'

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Close any iTerm sessions whose name starts with one of the given prefixes.
 * Used before re-opening service/heal-agent tabs so the window doesn't fill
 * up with stale tabs over the course of a watch-mode session.
 *
 * iTerm's plain `close t` prompts the user if the session has a running
 * process, so we kill the shell on the session's tty first (via pkill -t),
 * then close. The dead session closes without a prompt.
 */
export function closeItermSessionsByPrefix(prefixes: string[]): void {
  if (prefixes.length === 0) return
  const conds = prefixes
    .map((p) => `name of s starts with "${escape(p)}"`)
    .join(' or ')

  // Phase 1: collect ttys of matching sessions and kill their processes.
  const collectScript = `
tell application "iTerm"
  set ttyList to {}
  repeat with w in (windows as list)
    repeat with t in (tabs of w as list)
      repeat with s in (sessions of t as list)
        try
          if ${conds} then
            set end of ttyList to tty of s
          end if
        end try
      end repeat
    end repeat
  end repeat
end tell
set AppleScript's text item delimiters to linefeed
return ttyList as text
`
  let ttys: string[] = []
  try {
    const out = execFileSync('osascript', ['-e', collectScript], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    ttys = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  } catch {
    return // iTerm not running
  }

  for (const tty of ttys) {
    const name = tty.replace(/^\/dev\//, '')
    try {
      execFileSync('pkill', ['-9', '-t', name], { stdio: 'ignore' })
    } catch {
      /* no processes on that tty — fine */
    }
  }

  // Phase 2: close the (now empty) tabs without prompting.
  const closeScript = `
tell application "iTerm"
  repeat with w in (windows as list)
    set tabsToClose to {}
    repeat with t in (tabs of w as list)
      repeat with s in (sessions of t as list)
        try
          if ${conds} then
            set end of tabsToClose to t
          end if
        end try
      end repeat
    end repeat
    repeat with t in tabsToClose
      try
        close t
      end try
    end repeat
  end repeat
end tell
`
  try {
    execFileSync('osascript', ['-e', closeScript], { stdio: 'ignore' })
  } catch {
    /* non-fatal */
  }
}

/**
 * Open tabs in iTerm. Always creates a fresh window so runs don't pile up
 * inside an existing window. Each session is named after `tab.name` so we
 * can find/close it later via `closeItermSessionsByPrefix`.
 */
export function openItermTabs(tabs: StartTab[], label: string): void {
  if (tabs.length === 0) return

  const sessionDecls = tabs
    .map((tab, i) => {
      const setName = `set name of s${i + 1} to "${escape(tab.name ?? `tab-${i + 1}`)}"`
      if (i === 0) {
        return [
          `set w to create window with default profile`,
          `tell w`,
          `  set s1 to current session of current tab`,
          `  ${setName}`,
          `end tell`,
        ].join('\n  ')
      }
      return [
        `tell w`,
        `  set t${i + 1} to create tab with default profile`,
        `  set s${i + 1} to current session of t${i + 1}`,
        `  ${setName}`,
        `end tell`,
      ].join('\n  ')
    })
    .join('\n\n  ')

  const sessionWrites = tabs
    .map(
      ({ dir, command }, i) =>
        `tell s${i + 1}\n    delay 0.3\n    write text "cd ${escape(dir)} && ${escape(command)}"\n  end tell`,
    )
    .join('\n  ')

  const script = `
tell application "iTerm"
  ${sessionDecls}

  ${sessionWrites}

  activate
end tell
`

  if (label) console.log(label)
  execFileSync('osascript', ['-e', script], { stdio: 'inherit' })
}
