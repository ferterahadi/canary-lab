export const NEW_ENV_SENTINEL = '__new_env__'

export const NEW_SLOT_SENTINEL = '__new_slot__'

export interface KvEntry { key: string; value: string }

export function stripFeaturePrefix(slot: string, feature: string): string {
  return slot.startsWith(`${feature}.`) ? slot.slice(feature.length + 1) : slot
}

export interface KvDiff {
  matching: { key: string; sourceValue: string; currentValue: string }[]
  onlyInSource: { key: string; value: string }[]
  onlyInCurrent: { key: string; value: string }[]
}

export function diffKvEntries(source: KvEntry[], current: KvEntry[]): KvDiff {
  const sourceMap = new Map(source.map((e) => [e.key, e.value]))
  const currentKeys = new Set(current.map((e) => e.key))
  const matching: KvDiff['matching'] = []
  const onlyInCurrent: KvDiff['onlyInCurrent'] = []
  for (const entry of current) {
    if (!entry.key) continue
    if (sourceMap.has(entry.key)) {
      matching.push({ key: entry.key, sourceValue: sourceMap.get(entry.key)!, currentValue: entry.value })
    } else {
      onlyInCurrent.push({ key: entry.key, value: entry.value })
    }
  }
  const onlyInSource: KvDiff['onlyInSource'] = source
    .filter((e) => e.key && !currentKeys.has(e.key))
    .map((e) => ({ key: e.key, value: e.value }))
  return { matching, onlyInSource, onlyInCurrent }
}
