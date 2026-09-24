import type { ExtractedTest, FeatureTests, TestCoverage } from '@/shared/api/types'

export interface CoverageTestSource {
  test: ExtractedTest
  absFile: string
}

/** A generated declaration can own several discovered cases at the same line. */
export function coverageTestSources(specs: FeatureTests, test: TestCoverage): CoverageTestSource[] {
  const entries = specs.flatMap((spec) => spec.tests.map((source) => ({
    test: source,
    absFile: source.sourceFile ?? spec.file,
  })))
  const normalize = (file: string) => file.replace(/\\/g, '/')
  const file = test.file && normalize(test.file)
  const atLocation = file && test.line != null
    ? entries.filter((entry) => entry.test.line === test.line
      && (normalize(entry.absFile) === file || normalize(entry.absFile).endsWith(`/${file}`)))
    : []
  if (atLocation.length) {
    const exact = atLocation.filter((entry) => entry.test.name === test.name)
    return exact.length ? exact : atLocation
  }
  // Names can recover a moved declaration, but cannot disambiguate two files.
  const named = entries.filter((entry) => entry.test.name === test.name)
  return named.length === 1 ? named : []
}
