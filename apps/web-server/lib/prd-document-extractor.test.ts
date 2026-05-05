import { describe, expect, it, vi } from 'vitest'
import { combinePrdText, extractPrdDocument } from './prd-document-extractor'

const parserMocks = vi.hoisted(() => ({
  pdfText: 'PDF body',
  pdfDestroy: vi.fn(),
  docxText: 'DOCX body',
}))

vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() {
      return { text: parserMocks.pdfText }
    }

    async destroy() {
      parserMocks.pdfDestroy()
    }
  },
}))

vi.mock('mammoth', () => ({
  extractRawText: async () => ({ value: parserMocks.docxText }),
}))

describe('extractPrdDocument', () => {
  it('extracts txt files', async () => {
    const doc = await extractPrdDocument({
      filename: 'prd.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('Hello PRD\n'),
    })
    expect(doc.filename).toBe('prd.txt')
    expect(doc.text).toBe('Hello PRD')
    expect(doc.characters).toBe(9)
  })

  it('defaults filename and content type for plain text content', async () => {
    const doc = await extractPrdDocument({
      filename: '',
      contentType: 'text/plain',
      buffer: Buffer.from('Fallback name'),
    })
    expect(doc.filename).toBe('document')
    expect(doc.contentType).toBe('text/plain')
    expect(doc.text).toBe('Fallback name')
  })

  it('extracts pdf files and destroys the parser', async () => {
    parserMocks.pdfDestroy.mockClear()
    parserMocks.pdfText = 'PDF body\r\nwith spaces   \n\n\n\nend'

    const doc = await extractPrdDocument({
      filename: 'prd.pdf',
      contentType: 'application/pdf',
      buffer: Buffer.from('%PDF'),
    })

    expect(doc.text).toBe('PDF body\nwith spaces\n\n\nend')
    expect(parserMocks.pdfDestroy).toHaveBeenCalledTimes(1)
  })

  it('extracts docx files by content type', async () => {
    parserMocks.docxText = 'DOCX body'

    const doc = await extractPrdDocument({
      filename: 'prd',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('docx'),
    })

    expect(doc.text).toBe('DOCX body')
  })

  it('rejects unsupported files', async () => {
    await expect(extractPrdDocument({
      filename: 'image.png',
      contentType: 'image/png',
      buffer: Buffer.from('x'),
    })).rejects.toThrow(/Unsupported PRD/)
  })

  it('rejects empty extracted text', async () => {
    await expect(extractPrdDocument({
      filename: 'empty.md',
      contentType: 'text/markdown',
      buffer: Buffer.from('\n\n'),
    })).rejects.toThrow(/No extractable text/)
  })

  it('defaults to application/octet-stream when content type is omitted', async () => {
    await expect(extractPrdDocument({
      filename: 'unknown.bin',
      buffer: Buffer.from('x'),
    })).rejects.toThrow(/Unsupported PRD file type: unknown.bin/)
  })
})

describe('combinePrdText', () => {
  it('combines pasted text and documents', () => {
    const text = combinePrdText({
      pastedText: 'Pasted',
      documents: [{
        filename: 'a.md',
        contentType: 'text/markdown',
        text: 'Doc body',
        characters: 8,
      }],
    })
    expect(text).toContain('# Pasted PRD')
    expect(text).toContain('# a.md')
    expect(text).toContain('Doc body')
  })

  it('returns an empty string when there is no pasted text or document', () => {
    expect(combinePrdText({ documents: [] })).toBe('')
  })
})
