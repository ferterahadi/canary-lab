import * as configApi from '@/shared/api/config'
import { ApiError } from '@/shared/api/internal'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { extractPortSlots } from './token-port-slots'

async function missingAs<T>(read: () => Promise<T>, missing: T): Promise<T> {
  try { return await read() } catch (error) {
    if (error instanceof ApiError && error.status === 404) return missing
    throw error
  }
}

/** Picker choices belong to a confirmed feature/environment/slot observation.
 * Keep failed observations visible, but never allow them to insert stale keys. */
export function useTokenPickerOptions({ feature, wantEnvset, wantPort, slot }: {
  feature: string
  wantEnvset: boolean
  wantPort: boolean
  slot: string | null
}) {
  const globalRevision = useInvalidationKey('configuration')
  const opts = { scope: feature, refreshKey: globalRevision, reconcileMs: 5000 }
  const index = useLiveResource('configuration', wantEnvset ? JSON.stringify(['index', feature]) : null,
    () => missingAs(() => configApi.getEnvsetsIndex(feature), { envs: [], slotDescriptions: {} }), opts)
  const ports = useLiveResource('configuration', wantPort ? JSON.stringify(['ports', feature]) : null,
    () => missingAs(async () => extractPortSlots(await configApi.getFeatureConfigDoc(feature)), []), opts)
  const env = index.value?.envs[0]
  const slotExists = Boolean(slot && env?.slots.includes(slot))
  const keys = useLiveResource('configuration', wantEnvset && slotExists ? JSON.stringify([feature, env!.name, slot]) : null,
    () => missingAs(async () => ({ keys: (await configApi.getEnvsetSlot(feature, env!.name, slot!)).entries.map((entry) => entry.key), missing: false }), { keys: [], missing: true }), opts)
  return {
    slots: env?.slots ?? [],
    keys: keys.value?.keys ?? null,
    portSlots: ports.value,
    indexConfirmed: index.confirmed,
    portsConfirmed: ports.confirmed,
    keysConfirmed: index.confirmed && keys.confirmed && slotExists && !keys.value?.missing,
    slotRemoved: wantEnvset && ((index.confirmed && !slotExists) || (keys.confirmed && Boolean(keys.value?.missing))),
    error: index.error || ports.error || keys.error,
    retry: () => { index.refresh(); ports.refresh(); keys.refresh() },
  }
}
