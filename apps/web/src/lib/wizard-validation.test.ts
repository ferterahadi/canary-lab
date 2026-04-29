import { describe, it, expect } from 'vitest'
import { slugifyFeatureName, validateConfigure } from './wizard-validation'

describe('validateConfigure', () => {
  const repo = { name: 'r1', localPath: '/r1' }

  it('reports prdText error when blank', () => {
    const v = validateConfigure({ prdText: '   ', repos: [repo], skills: [] })
    expect(v.ok).toBe(false)
    expect(v.errors.prdText).toBeDefined()
  })

  it('reports repos error when none chosen', () => {
    const v = validateConfigure({ prdText: 'add a thing', repos: [], skills: [] })
    expect(v.ok).toBe(false)
    expect(v.errors.repos).toBeDefined()
  })

  it('passes with prd + at least one repo, no skills required', () => {
    const v = validateConfigure({ prdText: 'add x', repos: [repo], skills: [] })
    expect(v.ok).toBe(true)
    expect(v.errors).toEqual({})
  })

  it('rejects illegal feature name characters', () => {
    const v = validateConfigure({
      prdText: 'p',
      repos: [repo],
      skills: [],
      featureName: 'has spaces',
    })
    expect(v.ok).toBe(false)
    expect(v.errors.featureName).toBeDefined()
  })

  it('accepts a clean feature name', () => {
    const v = validateConfigure({
      prdText: 'p',
      repos: [repo],
      skills: [],
      featureName: 'my-feature_1',
    })
    expect(v.ok).toBe(true)
  })

  it('flags recommenderReady once PRD ≥ 30 chars', () => {
    const short = validateConfigure({ prdText: 'short', repos: [repo], skills: [] })
    expect(short.recommenderReady).toBe(false)
    const long = validateConfigure({
      prdText: 'this is a long enough PRD body for the recommender to fire',
      repos: [repo],
      skills: [],
    })
    expect(long.recommenderReady).toBe(true)
  })

  it('treats undefined featureName as valid', () => {
    const v = validateConfigure({ prdText: 'p', repos: [repo], skills: [] })
    expect(v.errors.featureName).toBeUndefined()
  })

  it('treats whitespace-only featureName as no input', () => {
    const v = validateConfigure({
      prdText: 'p',
      repos: [repo],
      skills: [],
      featureName: '   ',
    })
    expect(v.errors.featureName).toBeUndefined()
  })
})

describe('slugifyFeatureName', () => {
  it('takes the first 4 alpha words of the first line', () => {
    expect(slugifyFeatureName('Add Todo API with rate limit\nand more')).toBe('add-todo-api-with')
  })
  it('falls back when nothing usable', () => {
    expect(slugifyFeatureName('   \n\n')).toBe('untitled-feature')
    expect(slugifyFeatureName('!!!')).toBe('untitled-feature')
  })
  it('normalizes punctuation to dashes', () => {
    expect(slugifyFeatureName('Hello, world!')).toBe('hello-world')
  })
})
