import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import type { EnvFileSource } from '../features/config/logic/feature-authoring'
import { envFileSourceInput } from './env-file-source-input'
import { registerFeatureAuthoringTools } from './tool-groups/authoring-features'
import { registerFeatureEnvTools } from './tool-groups/authoring-env'
import { captureTools } from './tool-groups/__fixtures__/tool-group-harness'

describe('environment file source input', () => {
  it('matches the domain input without adding defaults or normalizing strings', () => {
    expectTypeOf<z.infer<typeof envFileSourceInput>>().toEqualTypeOf<EnvFileSource>()
    expect(envFileSourceInput.parse({ sourcePath: '', extra: 'discarded' })).toEqual({ sourcePath: '' })
    for (const confirmOverwrite of [false, true]) {
      const source = { sourcePath: ' source ', env: '', slot: '', target: '', description: '', confirmOverwrite }
      expect(envFileSourceInput.parse(source)).toEqual(source)
    }
  })

  it.each([
    null, 'source', {}, { sourcePath: 42 },
    ...['env', 'slot', 'target', 'description'].map(field => ({ sourcePath: 'source', [field]: 42 })),
    { sourcePath: 'source', confirmOverwrite: 'true' },
  ])('rejects invalid source input %j', (input) => {
    expect(envFileSourceInput.safeParse(input).success).toBe(false)
  })

  it('preserves the published descriptions and the distinct tool array rules', () => {
    const author = captureTools(registerFeatureAuthoringTools, {})
    const env = captureTools(registerFeatureEnvTools, {})
    const createInput = author.configs.get('create_feature')!.inputSchema!.envSources as z.ZodType
    const captureInput = env.configs.get('capture_feature_env_files')!.inputSchema!.sources as z.ZodType
    expect(createInput.safeParse(undefined).success).toBe(true)
    expect(createInput.safeParse([]).success).toBe(true)
    expect(captureInput.safeParse(undefined).success).toBe(false)
    expect(captureInput.safeParse([]).success).toBe(false)
    const source = [{ sourcePath: 'source', confirmOverwrite: false }]
    expect(createInput.parse(source)).toEqual(source)
    expect(captureInput.parse(source)).toEqual(source)

    const sourceSchema = {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Existing file whose actual contents are copied into the workspace envset.' },
        env: { type: 'string' },
        slot: { type: 'string' },
        target: { type: 'string', description: 'File the consumer reads during a run. Defaults to sourcePath when omitted; set explicitly when importing from elsewhere. Suite default: $CANARY_LAB_PROJECT_ROOT/features/<feature>/.env. Never an envset source or .runtime/envsets path.' },
        description: { type: 'string' },
        confirmOverwrite: { type: 'boolean' },
      },
      required: ['sourcePath'],
      additionalProperties: false,
    }
    expect(z.toJSONSchema(createInput)).toMatchObject({
      type: 'array', items: sourceSchema,
      description: 'Optional env/config files to copy into feature envsets. Values are never returned.',
    })
    expect(z.toJSONSchema(captureInput)).toMatchObject({ type: 'array', items: sourceSchema, minItems: 1 })
  })
})
