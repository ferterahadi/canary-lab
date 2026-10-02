import { useState } from 'react'
import { openPortifyProject } from '@/shared/api/cleanup'

export function useOpenPortifyProject(workflowId: string) {
  const [openError, setOpenError] = useState<string | null>(null)
  const openProject = async (): Promise<void> => {
    setOpenError(null)
    try {
      const res = await openPortifyProject(workflowId)
      if (!res.opened) setOpenError(res.error ?? 'Failed to open editor')
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'Failed to open editor')
    }
  }
  return { openError, openProject }
}
