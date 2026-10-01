import * as configApi from '@/shared/api/config'
import { useLiveResource } from './use-live-resource'

/** Each mounted reader owns its accepted settings; workspace configuration is
 * not retained in a module-global cache after the view closes. */
export function useProjectConfig() {
  return useLiveResource('project-config', 'workspace', () => configApi.getProjectConfig(), { reconcileMs: 5000 })
}
