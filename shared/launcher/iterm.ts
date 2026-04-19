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
/**
 * Close any iTerm windows that no longer have any tabs. Called after
 * session closes so stale empty windows don't linger across restarts.
 */
function closeEmptyItermWindows(): void {
  const script = `
tell application "iTerm"
  set windowsToClose to {}
  repeat with w in (windows as list)
    try
      if (count of tabs of w) is 0 then
        set end of windowsToClose to w
      end if
    end try
  end repeat
  repeat with w in windowsToClose
    try
      close w saving no
    end try
  end repeat
end tell
`
  try {
    execFileSync('osascript', ['-e', script], { stdio: 'ignore' })
  } catch {
    /* non-fatal */
  }
}

export function closeItermSessionsByPrefix(prefixes: string[]): void {
  if (prefixes.length === 0) return
  // Match on either the legacy `name of s` (may be overwritten by zsh) OR
  // the immutable `user.canary_lab` variable set via OSC 1337 when the
  // tab was opened. The user var is the reliable path across process
  // restarts; the name check is kept as a belt-and-braces fallback.
  const conds = prefixes
    .map((p) => {
      const esc = escape(p)
      return `(name of s starts with "${esc}") or ((variable named "user.canary_lab" of s) starts with "${esc}")`
    })
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

  closeEmptyItermWindows()
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

  closeEmptyItermWindows()
}

/**
 * Reuse existing iTerm sessions by sending Ctrl-C (ASCII 3) to interrupt
 * whatever's running, then writing the new `cd && command` to the same
 * shell. Preserves scrollback + tab order across restarts and avoids the
 * close-then-reopen race where a tab's shell outlives the close attempt.
 *
 * Returns true only when every provided id was found AND the script ran
 * without error; caller should fall back to `openItermTabs` on false.
 */
export function reuseItermTabs(
  ids: string[],
  tabs: StartTab[],
  label: string,
): boolean {
  if (ids.length === 0 || ids.length !== tabs.length) return false

  // Phase 1: verify every id still resolves to a live session. If any are
  // missing, bail so the caller can fall back to a fresh open.
  const idListAS = ids.map((id) => `"${escape(id)}"`).join(', ')
  const probeScript = `
tell application "iTerm"
  set n to 0
  repeat with w in (windows as list)
    repeat with t in (tabs of w as list)
      repeat with s in (sessions of t as list)
        try
          if (id of s as string) is in {${idListAS}} then
            set n to n + 1
          end if
        end try
      end repeat
    end repeat
  end repeat
  return n as text
end tell
`
  let found = 0
  try {
    const out = execFileSync('osascript', ['-e', probeScript], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    found = parseInt(out.trim(), 10) || 0
  } catch {
    return false
  }
  if (found !== ids.length) return false

  // Phase 2: for each session, send Ctrl-C (interrupts foreground pg, leaves
  // zsh alive), then write the new command after a short settle delay.
  const branches = ids
    .map((id, i) => {
      const tab = tabs[i]
      const tagName = tab.name ?? `tab-${i + 1}`
      const b64 = Buffer.from(tagName, 'utf-8').toString('base64')
      const marker = `printf '\\033]1337;SetUserVar=canary_lab=%s\\a' ${b64}`
      const full = `${marker} && cd ${tab.dir} && ${tab.command}`
      return [
        `if (id of s as string) is "${escape(id)}" then`,
        `            tell s`,
        `              write text (ASCII character 3) newline no`,
        `              delay 0.8`,
        `              set name of s to "${escape(tagName)}"`,
        `              write text "${escape(full)}"`,
        `            end tell`,
        `          end if`,
      ].join('\n          ')
    })
    .join('\n          ')

  const runScript = `
tell application "iTerm"
  repeat with w in (windows as list)
    repeat with t in (tabs of w as list)
      repeat with s in (sessions of t as list)
        try
          ${branches}
        end try
      end repeat
    end repeat
  end repeat
  activate
end tell
`

  if (label) console.log(label)
  try {
    execFileSync('osascript', ['-e', runScript], { stdio: 'ignore' })
    return true
  } catch {
    return false
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

  // Prepend a printf that sets an iTerm user variable (`user.canary_lab`)
  // via the OSC 1337 SetUserVar escape. Unlike `name of s`, user vars
  // can't be overwritten by zsh/oh-my-zsh auto-title, so `closeItermSessionsByPrefix`
  // can reliably match this tab across process restarts and project re-inits.
  const sessionWrites = tabs
    .map(({ dir, command, name }, i) => {
      const tag = name ?? `tab-${i + 1}`
      const b64 = Buffer.from(tag, 'utf-8').toString('base64')
      const marker = `printf '\\033]1337;SetUserVar=canary_lab=%s\\a' ${b64}`
      const full = `${marker} && cd ${dir} && ${command}`
      return `tell s${i + 1}\n    delay 0.3\n    write text "${escape(full)}"\n  end tell`
    })
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
    const ids = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (ids.length !== tabs.length) {
      console.warn(
        `  ⚠ iTerm ID capture: got ${ids.length}/${tabs.length}. Untracked tabs may accumulate — close stale ones manually.`,
      )
    }
    return ids
  } catch (err) {
    console.warn(
      `  ⚠ iTerm ID capture failed (${(err as Error).message ?? 'unknown'}). Tabs will not be auto-closed on restart.`,
    )
    return []
  }
}
