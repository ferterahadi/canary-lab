// Default spawner implementation for `open-browser.ts`. Excluded from
// coverage via `vitest.config.ts` — it shells out to a real OS binary
// (`open` / `xdg-open` / `cmd start`) and isn't deterministically testable.
// Mirrors the same pattern as `shared/e2e-runner/pty-spawner.ts`.

import { spawn, type ChildProcess } from 'child_process'
import type { OpenBrowserSpawner } from './open-browser'

// Declared as a function returning the real `ChildProcess` rather than annotated
// `: OpenBrowserSpawner`. The interface's return type is deliberately minimal
// (`{ unref(): void }` — all `open-browser.ts` needs), and annotating with it
// erased everything else, so the one test that exercises the genuine `spawn`
// delegation could not reach `pid` / `once` on its own result. `satisfies` below
// keeps the conformance the annotation was there for.
export function defaultOpenBrowserSpawner(
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
): ChildProcess {
  return spawn(command, args, options)
}

defaultOpenBrowserSpawner satisfies OpenBrowserSpawner
