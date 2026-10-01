import { useRef, useState } from 'react'

/** Partial failure still refreshes the authoritative inventory. The caller owns
 * eligibility, confirmation, and whether to clear all or just attempted ids. */
export function useCleanupAction(refresh: () => void) {
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const execute = async <T,>(targets: T[], action: (target: T) => Promise<unknown>, after: () => void, failureMessage: (failures: number, total: number) => string): Promise<void> => {
    if (running.current || targets.length === 0) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const results = await Promise.allSettled(targets.map((target) => Promise.resolve().then(() => action(target))))
      const failures = results.filter((result) => result.status === 'rejected').length
      after()
      if (failures) setError(failureMessage(failures, targets.length))
    } finally {
      running.current = false
      setBusy(false)
      refresh()
    }
  }
  return { busy, error, setError, execute }
}
