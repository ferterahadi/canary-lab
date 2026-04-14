import { execFileSync } from 'child_process'
import type { StartTab } from './startup'

export function openTerminalTabs(tabs: StartTab[], label: string): void {
  // First tab: open a new window. Subsequent tabs: open tabs in the same window.
  const commands = tabs.map(({ dir, command }, i) => {
    if (i === 0) {
      return `do script "cd ${dir} && ${command}"`
    }
    return [
      `tell application "System Events" to keystroke "t" using command down`,
      `delay 0.5`,
      `do script "cd ${dir} && ${command}" in front window`,
    ].join('\n    ')
  })

  const script = `
tell application "Terminal"
  activate
  ${commands.join('\n  ')}
end tell
`

  console.log(label)
  execFileSync('osascript', ['-e', script], { stdio: 'inherit' })
}
