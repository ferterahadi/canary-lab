import type { ReadableTest, ReadableTestStory } from './readable-tests/types'
import type { SpecDiff } from './verification-strength/types'

export interface ReviewTestSource {
  name: string
  line: number
  endLine: number
  readable: ReadableTest
}

export interface ReviewSource {
  source: string
  tests: ReviewTestSource[]
  /** Whole-file English, including module setup and test registration. */
  story?: ReadableTestStory
  parseError?: string
}

/** One read of each version supplies both context and advisory assessments. */
export interface TestFileReview {
  file: string
  currentPath: string
  baseline: 'head' | 'run-start'
  before: ReviewSource
  after: ReviewSource
  patch: string
  assessment: SpecDiff
}
