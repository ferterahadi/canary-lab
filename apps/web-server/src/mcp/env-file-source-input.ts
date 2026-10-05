import { z } from 'zod'
import type { EnvFileSource } from '../features/config/logic/feature-authoring'

export const envFileSourceInput = z.object({
  sourcePath: z.string().describe('Existing file whose actual contents are copied into the workspace envset.'),
  env: z.string().optional(),
  slot: z.string().optional(),
  target: z.string().optional().describe('File the consumer reads during a run. Defaults to sourcePath when omitted; set explicitly when importing from elsewhere. Suite default: $CANARY_LAB_PROJECT_ROOT/features/<feature>/.env. Never an envset source or .runtime/envsets path.'),
  description: z.string().optional(),
  confirmOverwrite: z.boolean().optional(),
}) satisfies z.ZodType<EnvFileSource>
