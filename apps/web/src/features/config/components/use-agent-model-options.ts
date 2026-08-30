import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import type { AgentProbeSnapshot, ModelAgentKind } from '@/shared/api/client'
import { KNOWN_MODEL_OPTIONS, type KnownModelOption } from '@shared/agent-models'

/** One shared read for both model-picking surfaces. The endpoint is already
 *  cached and single-flight on the server; launch gates wait until Customize is
 *  opened, while Project Settings enables it immediately for its probe strip. */
export function useAgentModelOptions(agent: ModelAgentKind, enabled = true): {
  probe: AgentProbeSnapshot | null
  probeBusy: boolean
  retryProbe: () => void
  modelOptions: readonly KnownModelOption[]
} {
  const [probe, setProbe] = useState<AgentProbeSnapshot | null>(null)
  const [probeBusy, setProbeBusy] = useState(enabled)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let current = true
    setProbeBusy(true)
    api.getAgentProbe(retryCount > 0)
      .then((snapshot) => {
        if (current) setProbe(snapshot)
      })
      // Discovery is informational. Keep any prior catalog on a failed retry;
      // the first failure naturally falls back to the curated options below.
      .catch(() => {})
      .finally(() => {
        if (current) setProbeBusy(false)
      })
    return () => {
      current = false
    }
  }, [enabled, retryCount])

  const discovered = probe?.[agent].models
  return {
    probe,
    probeBusy,
    retryProbe: () => setRetryCount((count) => count + 1),
    modelOptions: discovered?.length ? discovered : KNOWN_MODEL_OPTIONS[agent],
  }
}
