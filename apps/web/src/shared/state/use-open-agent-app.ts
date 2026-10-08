import { useCallback, useState } from 'react'
import * as workspaceApi from '@/shared/api/workspace'
import { displayError } from '@/shared/api/error-message'

// Launch the user's Claude/Codex desktop app. Shared by every external panel
// whose CTA opens the client (heal, coverage) so the busy/error handling has one
// home instead of a per-panel copy.
export function useOpenAgentApp() {
  const [opening, setOpening] = useState<'claude' | 'codex' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = useCallback(async (agent: 'claude' | 'codex'): Promise<void> => {
    setOpening(agent)
    setError(null)
    try {
      await workspaceApi.openAgentApp(agent)
    } catch (err) {
      setError(displayError(err, `Could not open ${agent}`))
    } finally {
      setOpening(null)
    }
  }, [])
  return { opening, error, open, setError }
}

