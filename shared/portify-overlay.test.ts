import { describe, expect, it } from 'vitest'
import { OVERLAY_DIRNAME, patchFileName } from './portify-overlay'

describe('portify overlay naming', () => {
  it('pins the overlay directory name', () => {
    // The server writes here and the UI's "Stored in" row reads it — a rename
    // on either side has to come through this constant.
    expect(OVERLAY_DIRNAME).toBe('portify')
  })

  it('slugifies a repo name into a filesystem-safe patch filename', () => {
    expect(patchFileName('todo-api')).toBe('todo-api.patch')
    expect(patchFileName('Acme FnB')).toBe('acme-fnb.patch')
    expect(patchFileName('acme_web.service')).toBe('acme-web-service.patch')
  })

  it('trims leading and trailing separator runs', () => {
    expect(patchFileName('--edge--')).toBe('edge.patch')
    expect(patchFileName('  spaced  ')).toBe('spaced.patch')
  })

  it('falls back to `repo` when nothing slug-worthy survives', () => {
    expect(patchFileName('///')).toBe('repo.patch')
    expect(patchFileName('')).toBe('repo.patch')
  })
})
