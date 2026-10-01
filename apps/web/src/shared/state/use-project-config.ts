import * as api from '@/shared/api/client'
import { useLiveResource } from './use-live-resource'

/** Each mounted reader owns its accepted settings; workspace configuration is
 * not retained in a module-global cache after the view closes. */
export function useProjectConfig() {
  return useLiveResource('project-config', 'workspace', () => api.getProjectConfig(), { reconcileMs: 5000 })
}
