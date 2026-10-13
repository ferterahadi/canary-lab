import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob } from './download'
import { downloadText } from '@/features/benchmark/components/BenchmarkReport'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

function browser() {
  const urlApi = { createObjectURL: vi.fn((_blob: Blob) => 'blob:download'), revokeObjectURL: vi.fn() }
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return { urlApi, click }
}

describe('downloadBlob', () => {
  it('downloads the supplied blob and filename, then releases the link and URL', () => {
    const { urlApi, click } = browser()
    const blob = new Blob(['report'], { type: 'text/plain' })
    click.mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('report.txt')
      expect(this.href).toBe('blob:download')
      expect(this.isConnected).toBe(true)
      expect(this.style.display).toBe('none')
    })
    downloadBlob(blob, 'report.txt', { documentRef: document, urlApi })
    expect(urlApi.createObjectURL).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalledTimes(1)
    expect(document.querySelector('a')).toBeNull()
    expect(urlApi.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download')
  })

  it.each(['create', 'append', 'click', 'remove'] as const)('releases the URL when %s fails', (stage) => {
    const { urlApi, click } = browser()
    const fail = () => { throw new Error(stage) }
    if (stage === 'create') vi.spyOn(document, 'createElement').mockImplementation(fail)
    if (stage === 'append') vi.spyOn(document.body, 'appendChild').mockImplementation(fail)
    if (stage === 'click') click.mockImplementation(fail)
    if (stage === 'remove') vi.spyOn(HTMLAnchorElement.prototype, 'remove').mockImplementation(fail)
    expect(() => downloadBlob(new Blob(), 'report.txt', { urlApi })).toThrow(stage)
    expect(urlApi.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download')
    if (stage !== 'remove') expect(document.querySelector('a')).toBeNull()
  })

  it('does not allocate a link when object URL creation fails', () => {
    const { urlApi } = browser()
    urlApi.createObjectURL.mockImplementation(() => { throw new Error('allocation') })
    expect(() => downloadBlob(new Blob(), 'report.txt', { urlApi })).toThrow('allocation')
    expect(document.querySelector('a')).toBeNull()
    expect(urlApi.revokeObjectURL).not.toHaveBeenCalled()
  })

  it('preserves benchmark text and MIME type through the browser defaults', async () => {
    const { urlApi, click } = browser()
    vi.stubGlobal('URL', urlApi)
    click.mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe('benchmark.md') })
    downloadText('benchmark.md', '# Result', 'text/markdown')
    const blob = urlApi.createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/markdown')
    expect(await blob.text()).toBe('# Result')
    expect(urlApi.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download')
  })
})
