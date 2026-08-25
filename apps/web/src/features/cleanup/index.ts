// Public surface of the `cleanup` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export { CleanupPill } from './components/CleanupPill'
