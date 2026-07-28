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
// The gap + strength vocabulary: labels, status hues, tier tooltips, and the two
// canonical orders. Exported so the flight's Test-authoring composition card is
// literally the same words and colours as the ledger page its stage header links
// to — a second private copy would drift the moment either is renamed.
export { GAP_META, STRENGTH_META, STRENGTH_ORDER, countFor } from './components/CoverageCards'
export { SEG_ORDER } from './components/CoverageHeader'
