import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../shared/api/client'
import { repoPathAddErrorMessage } from './ConfigureStep'

describe('repoPathAddErrorMessage', () => {
  it('localizes relative path validation failures', () => {
    const err = new ApiError(400, { error: 'path must be absolute or start with ~' })

    expect(repoPathAddErrorMessage(err)).toBe('Path not found')
  })

  it('localizes missing path failures', () => {
    const err = new ApiError(404, { error: 'not found' })

    expect(repoPathAddErrorMessage(err)).toBe('Path not found')
  })

  it('keeps non-path server errors readable', () => {
    const err = new ApiError(500, { error: 'workspace unavailable' })

    expect(repoPathAddErrorMessage(err)).toBe('workspace unavailable')
  })
})
