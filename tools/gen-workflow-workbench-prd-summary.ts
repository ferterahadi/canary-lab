import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Requirement } from '../shared/coverage/types'
import { readDocsCollection } from '../apps/web-server/src/features/coverage/logic/coverage/docs-collection'
import { withFingerprints } from '../apps/web-server/src/features/coverage/logic/coverage/fingerprints'
import { writePrdSummary } from '../apps/web-server/src/features/coverage/logic/coverage/prd-summary-render'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FEATURE = 'workflow-workbench'
const FEATURE_DIR = path.join(HERE, '..', 'templates', 'project', 'features', FEATURE)
const GENERATED_AT = '2026-08-18T00:00:00.000Z'
export const SOURCE_DOC = path.join(HERE, '..', 'templates', 'project', 'workflow-app', 'REQUIREMENTS.md')
export const COLLECTED_DOC_NAME = 'workflow-workbench-prd.md'

export const REQUIREMENTS: Requirement[] = [
  {
    id: 'R1',
    title: 'Service health',
    text: 'It should report that the workflow service is healthy.',
    kind: 'functional',
    happyPath: 'GET /health returns 200 with status ok.',
    pathTypes: ['happy'],
  },
  {
    id: 'R2',
    title: 'Personalized greeting',
    text: 'It should greet the name supplied by the caller.',
    kind: 'functional',
    happyPath: 'GET /greeting?name=Ada returns 200 with Hello, Ada!.',
    pathTypes: ['happy'],
  },
]

export function generate(): { docsHash: string; requirements: number } {
  fs.copyFileSync(SOURCE_DOC, path.join(FEATURE_DIR, 'docs', COLLECTED_DOC_NAME))
  const collection = readDocsCollection(FEATURE_DIR)
  const written = writePrdSummary(
    FEATURE_DIR,
    FEATURE,
    withFingerprints(
      {
        requirements: REQUIREMENTS,
        docsHash: collection.docsHash,
        sourceDocs: collection.entries.map((entry) => entry.relPath),
        generatedAt: GENERATED_AT,
      },
      collection.entries,
    ),
  )
  return { docsHash: written.docsHash, requirements: written.requirements.length }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const { docsHash, requirements } = generate()
  console.log(`✔ ${FEATURE}: ${requirements} requirements, docs ${docsHash.slice(0, 12)}…`)
}
