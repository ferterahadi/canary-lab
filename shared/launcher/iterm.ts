import { execFileSync } from 'child_process'
import type { StartTab } from './startup'

export function escape(s: string): string {
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
        close t saving no
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
 * Close specific iTerm sessions by their unique session IDs. More reliable
 * than prefix-matching since session IDs can't be overridden by the shell
 * (whereas zsh/oh-my-zsh auto-title escape sequences overwrite `name of s`).
 */
export function closeItermSessionsByIds(ids: string[]): void {
  if (ids.length === 0) return
  const idList = ids.map((id) => `"${escape(id)}"`).join(', ')

  // Phase 1: kill processes on matching sessions' ttys.
  const collectScript = `
tell application "iTerm"
  set ttyList to {}
  repeat with w in (windows as list)
    repeat with t in (tabs of w as list)
      repeat with s in (sessions of t as list)
        try
          if (id of s as string) is in {${idList}} then
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
    return
  }

  for (const tty of ttys) {
    const name = tty.replace(/^\/dev\//, '')
    try {
      execFileSync('pkill', ['-9', '-t', name], { stdio: 'ignore' })
    } catch {
      /* no processes on tty — fine */
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
          if (id of s as string) is in {${idList}} then
            set end of tabsToClose to t
          end if
        end try
      end repeat
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
    execFileSync('osascript', ['-e', closeScript], { stdio: 'ignore' })
  } catch {
    /* non-fatal */
  }
}

/**
 * Open tabs in iTerm. Always creates a fresh window so runs don't pile up
 * inside an existing window. Returns the iTerm session IDs of the opened
 * tabs so callers can close them precisely later (see `closeItermSessionsByIds`).
 *
 * We also set `name of s` for display, but zsh auto-title may overwrite it;
 * IDs are immutable, so we return those as the source of truth.
 */
export function openItermTabs(tabs: StartTab[], label: string): string[] {
  if (tabs.length === 0) return []

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

  const idReturns = tabs
    .map((_, i) => `(id of s${i + 1} as string)`)
    .join(', ')

  const script = `
tell application "iTerm"
  ${sessionDecls}

  ${sessionWrites}

  activate
  set idList to {${idReturns}}
end tell
set AppleScript's text item delimiters to linefeed
return idList as text
`

  if (label) console.log(label)
  try {
    const out = execFileSync('osascript', ['-e', script], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}
