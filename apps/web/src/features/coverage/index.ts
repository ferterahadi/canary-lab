// Public surface of the `coverage` feature.
//
// Other features import from here, never from a path inside this directory —
// tools/check-feature-boundaries.mjs enforces it. Adding a re-export widens
// this feature's contract, so add one deliberately.

export {
  AddDocsTile,
  DocPill,
  DocsDropOverlay,
  EmptyDropzone,
  readAsBase64,
  useDocDrop,
} from './components/CoverageDocsRail'
export { VerificationDialog } from './components/VerificationDialog'
