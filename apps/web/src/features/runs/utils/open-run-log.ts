import { createReadableRunLog, openEditor } from '@/shared/api/client'

/** Open one of a run's logs in the editor as its readable copy. A log the
 *  server will not copy (outside the run, already gone) still opens raw, so the
 *  button never silently does nothing. */
export async function openRunLog(runId: string, file: string): Promise<void> {
  const target = await createReadableRunLog(runId, file).then(({ path }) => path, () => file)
  await openEditor({ file: target }).catch(() => {})
}
