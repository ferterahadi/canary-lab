import type { TestChangeKind } from '@shared/test-review'
export type { RunDifference, VersionTest, TestChangeKind, TestVersionChanges } from '@shared/test-review'
export const TEST_CHANGE_KINDS: TestChangeKind[] = ['added', 'changed', 'removed']

export function suiteRelativeFile(file: string, ...roots: Array<string | undefined>): string {
  for (const root of roots) {
    if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1)
  }
  return file
}
