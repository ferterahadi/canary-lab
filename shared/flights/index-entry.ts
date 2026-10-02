import { stageHasEvidence, type FlightIndexEntry, type FlightManifest } from './types'

export function flightIndexEntry(m: FlightManifest): FlightIndexEntry {
  // Clearable keys (group / pauseReason / checkpointKind / endedAt) are ALWAYS present — as
  // `undefined` when the manifest has none — because the index upsert is a
  // shallow merge (`{ ...oldRow, ...entry }`): a merge can overwrite a key but
  // never delete one, so omitting a cleared key would leave the previous
  // value stuck on the row forever (a resumed flight showing `running` WITH
  // its old `pauseReason: "stage-failed"`). An explicit `undefined` overrides
  // the stale value in the merge, and JSON.stringify drops the key on write.
  return {
    id: m.flightId,
    createdAt: m.createdAt,
    flightId: m.flightId,
    feature: m.feature,
    repoPaths: m.repoPaths,
    group: m.opts.group,
    status: m.status,
    pauseReason: m.pauseReason,
    // Which kind of stop a parked flight is on, so the slim consumers can tell
    // a question for the human from an `external-work` hand-off without
    // loading the manifest. Only one stage can be parked at a time.
    checkpointKind: m.stages.find((s) => s.status === 'waiting-for-approval')?.checkpoint?.kind,
    // Who drives the flight, so the slim consumers can tell an externally
    // driven flight (read-only here — every decision belongs to the MCP client
    // that started it) from one this UI may act on.
    stageProducer: m.opts.stageProducer,
    currentStage: m.currentStage,
    stages: m.stages.map((s) => ({
      key: s.key, status: s.status,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      ...(stageHasEvidence(s.evidence) ? { hasEvidence: true } : {}),
    })),
    updatedAt: m.updatedAt,
    endedAt: m.endedAt,
  }
}
