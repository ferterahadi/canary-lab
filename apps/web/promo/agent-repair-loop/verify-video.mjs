import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const webmPath = path.join(root, 'docs/assets/canary-lab-ai-agent-promo.webm')
const gifPath = path.join(root, 'docs/assets/canary-lab-repair-loop.gif')

const WEBM_ELEMENTS = new Map(
  Object.entries({
    '18538067': 'Segment',
    '1549a966': 'Info',
    '2ad7b1': 'TimestampScale',
    '4489': 'Duration',
    '1654ae6b': 'Tracks',
    ae: 'TrackEntry',
    86: 'CodecID',
    e0: 'Video',
    b0: 'PixelWidth',
    ba: 'PixelHeight',
  }),
)

const WEBM_CONTAINER_ELEMENTS = new Set(['Segment', 'Info', 'Tracks', 'TrackEntry', 'Video'])

function readGifDimensions(filePath) {
  const bytes = fs.readFileSync(filePath)
  const header = bytes.subarray(0, 6).toString('ascii')
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    throw new Error(`${filePath} is not a GIF`)
  }
  return {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
    bytes: bytes.length,
  }
}

function readVint(bytes, offset, forId = false) {
  const first = bytes[offset]
  if (first === undefined) throw new Error(`Unexpected end of WebM at offset ${offset}`)

  let marker = 0x80
  let length = 1
  while (length <= 8 && (first & marker) === 0) {
    marker >>= 1
    length += 1
  }
  if (length > 8) throw new Error(`Invalid WebM vint at offset ${offset}`)

  let value = forId ? first : first & ~marker
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]
  }

  return {
    length,
    value,
    raw: bytes.subarray(offset, offset + length).toString('hex'),
  }
}

function readUInt(bytes, offset, size) {
  let value = 0
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + bytes[offset + index]
  }
  return value
}

function readFloat(bytes, offset, size) {
  if (size === 4) return bytes.readFloatBE(offset)
  if (size === 8) return bytes.readDoubleBE(offset)
  throw new Error(`Unsupported WebM float size ${size}`)
}

function readWebmMetadata(filePath) {
  const bytes = fs.readFileSync(filePath)
  let timestampScale = 1000000
  let duration = null
  let width = null
  let height = null
  const codecIds = []

  const parseRange = (start, end) => {
    let offset = start
    while (offset < end) {
      const id = readVint(bytes, offset, true)
      offset += id.length
      const size = readVint(bytes, offset)
      offset += size.length

      const dataStart = offset
      const unknownSize = size.value === 2 ** (7 * size.length) - 1
      const dataEnd = unknownSize ? end : offset + size.value
      const element = WEBM_ELEMENTS.get(id.raw)

      if (element === 'TimestampScale') timestampScale = readUInt(bytes, dataStart, size.value)
      if (element === 'Duration') duration = readFloat(bytes, dataStart, size.value)
      if (element === 'PixelWidth') width = readUInt(bytes, dataStart, size.value)
      if (element === 'PixelHeight') height = readUInt(bytes, dataStart, size.value)
      if (element === 'CodecID') {
        codecIds.push(bytes.subarray(dataStart, dataEnd).toString('utf8'))
      }
      if (WEBM_CONTAINER_ELEMENTS.has(element)) parseRange(dataStart, dataEnd)

      offset = dataEnd
    }
  }

  parseRange(0, bytes.length)

  return {
    width,
    height,
    duration: duration == null ? null : (duration * timestampScale) / 1e9,
    canPlayVp8: codecIds.includes('V_VP8') ? 'probably' : '',
    codecIds,
  }
}

const webm = readWebmMetadata(webmPath)
const gif = readGifDimensions(gifPath)

if (webm.width !== 1920 || webm.height !== 1080) {
  throw new Error(`Unexpected WebM size ${webm.width}x${webm.height}`)
}
if (Math.abs(webm.duration - 20) > 0.35) {
  throw new Error(`Unexpected WebM duration ${webm.duration}`)
}
if (gif.width !== 1920 || gif.height !== 1080) {
  throw new Error(`Unexpected GIF size ${gif.width}x${gif.height}`)
}

console.log(JSON.stringify({ webm, gif }, null, 2))
