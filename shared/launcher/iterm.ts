import { execFileSync } from 'child_process'
import type { StartTab } from './startup'

export function openItermTabs(tabs: StartTab[], label: string): void {
  const sessionDecls = tabs
    .map((_, i) =>
      i === 0
        ? `set s1 to current session of current tab`
        : `set t${i + 1} to create tab with default profile\n    set s${i + 1} to current session of t${i + 1}`,
    )
    .join('\n\n    ')

  const sessionWrites = tabs
    .map(({ dir, command }, i) => `tell s${i + 1}\n    delay 0.3\n    write text "cd ${dir} && ${command}"\n  end tell`)
    .join('\n  ')

  const script = `
tell application "iTerm"
  set w to create window with default profile
  tell w
    ${sessionDecls}
  end tell

  ${sessionWrites}

  activate
end tell
`

  console.log(label)
  execFileSync('osascript', ['-e', script], { stdio: 'inherit' })
}
