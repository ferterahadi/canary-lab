import path from 'path'

export interface ExtractedPrdDocument {
  filename: string
  contentType: string
  text: string
  characters: number
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown'])

export async function extractPrdDocument(input: {
  filename: string
  contentType?: string
  buffer: Buffer
}): Promise<ExtractedPrdDocument> {
  const filename = input.filename || 'document'
  const contentType = input.contentType || 'application/octet-stream'
  const ext = path.extname(filename).toLowerCase()
  let text: string

  if (TEXT_EXTENSIONS.has(ext) || contentType.startsWith('text/')) {
    text = input.buffer.toString('utf8')
  } else if (ext === '.pdf' || contentType === 'application/pdf') {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: input.buffer })
    try {
      const parsed = await parser.getText()
      text = parsed.text ?? ''
    } finally {
      await parser.destroy()
    }
  } else if (
    ext === '.docx'
    || contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = await import('mammoth')
    const parsed = await mammoth.extractRawText({ buffer: input.buffer })
    text = parsed.value ?? ''
  } else {
    throw new Error(`Unsupported PRD file type: ${filename}`)
  }

  const normalized = normalizePrdText(text)
  if (!normalized) throw new Error(`No extractable text found in ${filename}`)
  return {
    filename,
    contentType,
    text: normalized,
    characters: normalized.length,
  }
}

export function combinePrdText(input: {
  pastedText?: string
  documents: ExtractedPrdDocument[]
}): string {
  const parts: string[] = []
  const pasted = normalizePrdText(input.pastedText ?? '')
  if (pasted) parts.push(`# Pasted PRD\n\n${pasted}`)
  for (const doc of input.documents) {
    parts.push(`# ${doc.filename}\n\n${doc.text}`)
  }
  return parts.join('\n\n---\n\n').trim()
}

function normalizePrdText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}
