// Default spawner implementation for `open-browser.ts`. Excluded from
// coverage via `vitest.config.ts` — it shells out to a real OS binary
// (`open` / `xdg-open` / `cmd start`) and isn't deterministically testable.
// Mirrors the same pattern as `shared/e2e-runner/pty-spawner.ts`.

import { spawn } from 'child_process'
import type { OpenBrowserSpawner } from './open-browser'

export const defaultOpenBrowserSpawner: OpenBrowserSpawner = (command, args, options) => {
  return spawn(command, args, options)
}
