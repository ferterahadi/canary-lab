export interface RecordedMappingInput {
  fingerprint: string
  requirements: Record<string, string>
}

export function mappingInputMatches(
  fingerprint: string,
  requirements: Record<string, string>,
  prior: RecordedMappingInput | undefined,
): boolean {
  return prior !== undefined && prior.fingerprint === fingerprint
    && Object.entries(requirements).every(([id, hash]) => prior.requirements[id] === hash)
}
