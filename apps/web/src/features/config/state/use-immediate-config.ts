import { useEffect, useRef } from 'react'
import * as api from '@/shared/api/client'
import type { ConfigValue, ParsedConfigDoc } from '@/shared/api/client'
import { useEditableSlice } from '../components/useEditableSlice'

/** Uses the same document owner as Advanced setup, with immediate field commits.
 * Pending field transforms rebase on current documents, not captured full copies. */
export function useImmediateConfig(feature: string, kind: 'feature' | 'playwright', refreshKey?: number) {
  const editor = useEditableSlice<ParsedConfigDoc, ConfigValue>({
    cacheKey: `${kind === 'feature' ? 'config-doc' : 'playwright'}:${feature}`,
    load: () => kind === 'feature' ? api.getFeatureConfigDoc(feature) : api.getPlaywrightConfig(feature),
    extract: (doc) => doc.parsed.value,
    merge: (_doc, value) => value,
    save: (value) => kind === 'feature' ? api.putFeatureConfigDoc(feature, value as ConfigValue) : api.putPlaywrightConfig(feature, value as ConfigValue),
    immediate: true,
  })
  // The parent hint remains compatible; configuration events and bounded reads
  // are owned by the cache, so it is no longer the only recovery path.
  const previous = useRef(refreshKey)
  const refresh = useRef(editor.refresh)
  refresh.current = editor.refresh
  useEffect(() => {
    if (previous.current !== refreshKey) refresh.current()
    previous.current = refreshKey
  }, [refreshKey])
  return { value: editor.draft, error: editor.error, loading: editor.loading, saving: editor.saving, dirty: editor.dirty, retry: editor.doSave,
    update: (change: (value: ConfigValue) => void) => editor.editImmediate((value) => { const next = structuredClone(value); change(next); return next }) }
}
