import { useCallback, useEffect, useMemo, useRef } from 'react'

/** Async actions belong to the view identity that started them, not its replacement. */
export function useMountedIdentity(key: string) {
  const lifetime = useMemo(() => ({ key, active: false }), [key])
  const rendered = useRef(lifetime)
  rendered.current = lifetime
  useEffect(() => { lifetime.active = true; return () => { lifetime.active = false } }, [lifetime])
  return useCallback(() => lifetime.active && rendered.current === lifetime, [lifetime])
}
