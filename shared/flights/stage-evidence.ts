// On-disk stage evidence for a suite, as /api/features emits it. The server
// always sets every field; `booted`, `coverageMapping` and `portInjectability`
// stay optional because the web UI still reads payloads that predate them, and
// no server code reads them back.
import type { PortInjectability } from '../launcher/port-injectability'

/** Per-feature evidence block shipped on each /api/features row. Scaffold is
 *  implied (the row only exists because feature.config loaded); portify ships
 *  as the existing top-level `portified` flag; run/heal/export state is the
 *  client's — its live runs + export stores already carry it. */
export interface FeatureStageEvidence {
  /** A captured envset exists (env-capture stage artifact). */
  envCapture: boolean
  /** This feature's services have been proven to boot — the other half of Suite
   *  setup, and the only half an app with no env files can ever satisfy. */
  booted?: boolean
  /** docs/_prd-summary.json exists (prd-summary stage artifact). */
  prdSummary: boolean
  /** At least one spec under e2e/ (specs-coverage stage artifact). */
  specs: boolean
  /** Durable requirement-mapping evidence. A spec alone leaves this absent;
   *  annotations preserve manual/legacy work and `_coverage-state.json`
   *  records a mapper that completed with zero links. */
  coverageMapping?: 'absent' | 'fresh' | 'stale'
  /** How far the config gets this feature toward booting concurrently.
   *  Parallel readiness is a property of the config, not of Portify: a service
   *  that natively reads `PORT` declares its slot outright and needs no
   *  overlay. See shared/launcher/port-injectability.ts. */
  portInjectability?: PortInjectability
}
