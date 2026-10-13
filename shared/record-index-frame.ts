/** The frames a full-manifest `/ws/<records>` channel pushes: one `snapshot`
 *  of the index plus the details it has, then `update` (whole manifest) and
 *  `removed` deltas. The list and id keys stay each stream's own
 *  (`workflows` + `workflowId`, `benchmarks` + `benchmarkId`) because they are
 *  on the wire and the views read them. */
export type RecordIndexFrame<Entry, Detail, List extends string, Id extends string> =
  | ({ type: 'snapshot'; details: Record<string, Detail> } & Record<List, Entry[]>)
  | ({ type: 'update'; manifest: Detail } & Record<Id, string>)
  | ({ type: 'removed' } & Record<Id, string>)
