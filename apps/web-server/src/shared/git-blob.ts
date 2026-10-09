import { createHash } from 'crypto'

/** The object id git gives `content` as a blob: SHA-1 over `blob <bytes>\0`
 *  followed by the bytes. A rebuilt file is checked against a patch's `index`
 *  line with this, so a wrong rebuild is refused rather than shown. */
export function gitBlobSha1(content: Buffer | string): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

/** The all-zero id a patch writes for the side of an added or deleted file. */
export function isZeroBlob(abbrev: string): boolean {
  return /^0+$/.test(abbrev)
}

/** Whether a full blob id is the one a patch's abbreviated `index` hash names.
 *  Fewer than four characters, or the zero id, names nothing. */
export function matchesBlob(full: string, abbrev: string): boolean {
  return abbrev.length >= 4 && !isZeroBlob(abbrev) && full.startsWith(abbrev)
}
