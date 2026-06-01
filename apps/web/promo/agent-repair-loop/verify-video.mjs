import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const webmPath = path.join(root, 'docs/assets/canary-lab-ai-agent-promo.webm')
const gifPath = path.join(root, 'docs/assets/canary-lab-repair-loop.gif')

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

async function readVideoMetadata(filePath) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  })
  try {
    const page = await browser.newPage()
    const src = `data:video/webm;base64,${fs.readFileSync(filePath).toString('base64')}`
    await page.setContent(`<video id="promo" muted preload="metadata" src="${src}"></video>`)
    return await page.evaluate(async () => {
      const video = document.getElementById('promo')
      const read = () => ({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        canPlayVp8: video.canPlayType('video/webm; codecs="vp8"'),
      })
      if (video.readyState >= 1 && Number.isFinite(video.duration)) return read()
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('metadata load timed out')), 5000)
        video.addEventListener('loadedmetadata', resolve, { once: true })
        video.addEventListener('error', () => reject(new Error('metadata load failed')), { once: true })
        video.addEventListener('loadedmetadata', () => window.clearTimeout(timeout), { once: true })
      })
      return read()
    })
  } finally {
    await browser.close()
  }
}

const webm = await readVideoMetadata(webmPath)
const gif = readGifDimensions(gifPath)

if (webm.width !== 1920 || webm.height !== 1080) {
  throw new Error(`Unexpected WebM size ${webm.width}x${webm.height}`)
}
if (Math.abs(webm.duration - 24) > 0.35) {
  throw new Error(`Unexpected WebM duration ${webm.duration}`)
}
if (gif.width !== 1920 || gif.height !== 1080) {
  throw new Error(`Unexpected GIF size ${gif.width}x${gif.height}`)
}

console.log(JSON.stringify({ webm, gif }, null, 2))
