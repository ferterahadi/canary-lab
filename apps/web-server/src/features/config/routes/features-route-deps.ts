import type { DirtySpecStore } from '../../runs/logic/dirty-specs/store'
import type { PlaywrightListSpawner } from '../../runs/logic/playwright-list'

// The dependency contract for the features routes, in its own module so the
// sub-route files (`test-review.ts`) can type their `deps` without importing
// `features.ts` back — `featuresRoutes` mounts them, which would otherwise
// close an import cycle.
export interface FeaturesRouteDeps {
  featuresDir: string
  // Run history, consulted for the boot half of each row's Suite setup
  // evidence. Optional so route tests that never exercise runs stay unchanged;
  // absent simply means no boot has been proven.
  logsDir?: string
  // Optional override so tests can stub the Playwright `--list` invocation
  // without spawning a real `npx playwright test`.
  playwrightListSpawner?: PlaywrightListSpawner
  // Test-file integrity store. Absent in tests that don't exercise dirty state;
  // when present, the feature list carries a `dirty` summary and the approve /
  // commit routes are live. Mutations emit store change events which the server
  // bridges to a `tests-dirty-changed` WorkspaceEvent (no direct publish here).
  dirtySpecStore?: DirtySpecStore
}
