import type { RunManifest } from '@/shared/api/types'

/** Map only the selected run's declared suite roots. A basename/suffix match
 *  would let another suite's same-named test borrow this run's verdict. */
export function sourceFileInRun(
  file: string,
  manifest: Pick<RunManifest, 'featureDir' | 'suiteSnapshot'> | undefined,
): string {
  if (!manifest?.featureDir || manifest.suiteSnapshot?.kind !== 'taken') return file
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '')
  const root = normalize(manifest.featureDir)
  const source = normalize(file)
  if (!source.startsWith(`${root}/`)) return file
  return `${normalize(manifest.suiteSnapshot.dir)}${source.slice(root.length)}`
}
