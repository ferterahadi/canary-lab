import { StatusPill } from '../../../shared/ui/StatusPill'

// Status-bar pill surfaced only while one or more features have modified test
// files (Surface 1's notification). Danger-toned + a one-shot pulse when the
// count changes so a freshly-modified spec announces itself. Self-guards:
// renders nothing when nothing is dirty.
export function DirtyTestsPill({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) return null
  return (
    <StatusPill
      dotState="failed"
      name="Tests modified"
      count={count}
      countTone="danger"
      emphasis
      emphasisTone="danger"
      freshPulseKey={count}
      onClick={onOpen}
      title="Test files were modified — review before trusting the result"
      ariaLabel={`${count} feature${count > 1 ? 's' : ''} with modified test files — review`}
    />
  )
}
