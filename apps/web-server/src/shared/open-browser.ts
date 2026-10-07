// Cross-platform "open this URL in the user's default browser" helper.
//
// Pure, dependency-injectable: callers pass in a `spawner` (defaults to
// the real `child_process.spawn` shim in `open-browser-spawner.ts`) and
// optionally override `platform` (defaults to `process.platform`). The
// platform→command mapping is unit-tested; the real `child_process.spawn`
// invocation lives in a sibling module that's excluded from coverage,
// the same pattern used by `pty-spawner.ts`.

import { defaultOpenBrowserSpawner } from './open-browser-spawner'
import { launchDetached, resolveSystemCommand, type DetachedSpawner, type OpenCommand } from './system-launch'

export type Platform = NodeJS.Platform | string

export type OpenBrowserSpawner = DetachedSpawner

export interface OpenBrowserOptions {
  platform?: Platform
  spawner?: OpenBrowserSpawner
}

/**
 * Pure mapping from platform → (command, args) for opening a URL.
 * `darwin` → `open <url>`
 * `win32`  → `cmd /c start "" <url>` (the empty `""` is the window title;
 *           required so URLs starting with `&` aren't parsed as title).
 * anything else → `xdg-open <url>` (Linux/BSD/etc.)
 */
export function resolveOpenCommand(url: string, platform: Platform): OpenCommand {
  return resolveSystemCommand({ kind: 'url', url }, platform)
}

/**
 * Spawn the platform-appropriate command to open `url` in the default browser.
 * Returns `true` if a spawn was attempted, `false` if `url` was empty or the
 * spawner threw.
 *
 * Errors from the spawner are swallowed — failing to open the browser should
 * never crash the CLI; the URL is also printed for the user to click.
 */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): boolean {
  if (!url) return false
  const platform = opts.platform ?? process.platform
  const spawner = opts.spawner ?? defaultOpenBrowserSpawner
  const command = resolveOpenCommand(url, platform)
  try {
    launchDetached(command, spawner)
    return true
  } catch {
    return false
  }
}
