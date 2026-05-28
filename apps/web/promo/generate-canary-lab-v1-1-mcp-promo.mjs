import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(path.resolve('package.json'))
const { chromium } = require('playwright')

const outPath = path.resolve('apps/web/public/promo/canary-lab-v1-1-mcp.webm')
const logicalWidth = 1280
const logicalHeight = 560
const renderScale = 2
fs.mkdirSync(path.dirname(outPath), { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: logicalWidth * renderScale, height: logicalHeight * renderScale }, deviceScaleFactor: 1 })
  const base64 = await page.evaluate(async ({ logicalWidth, logicalHeight, renderScale }) => {
    const canvas = document.createElement('canvas')
    canvas.width = logicalWidth * renderScale
    canvas.height = logicalHeight * renderScale
    document.body.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas context missing')
    ctx.scale(renderScale, renderScale)

    const duration = 16
    const fps = 30
    const frames = duration * fps
    const stream = canvas.captureStream(fps)
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 })
    const chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    const done = new Promise((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mime })
        const buffer = await blob.arrayBuffer()
        let binary = ''
        const bytes = new Uint8Array(buffer)
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
        resolve(btoa(binary))
      }
    })

    const p = {
      base: '#0a0a0a',
      surface: '#141414',
      elevated: '#1c1c1c',
      selected: '#262626',
      border: '#262626',
      borderStrong: '#3a3a3a',
      accent: '#3b82f6',
      accentStrong: '#60a5fa',
      success: '#34d399',
      warning: '#fbbf24',
      text: '#fafafa',
      secondary: '#a3a3a3',
      muted: '#737373',
    }

    function clamp(v) { return Math.max(0, Math.min(1, v)) }
    function ease(v) { const x = clamp(v); return 1 - Math.pow(1 - x, 3) }
    function mix(a, b, t) {
      const av = a.match(/\w\w/g).map((x) => parseInt(x, 16))
      const bv = b.match(/\w\w/g).map((x) => parseInt(x, 16))
      return `rgb(${av.map((x, i) => Math.round(x + (bv[i] - x) * t)).join(',')})`
    }
    function rr(x, y, w, h, r) {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }
    function box(x, y, w, h, r, fill, stroke = p.border) {
      rr(x, y, w, h, r)
      ctx.fillStyle = fill
      ctx.fill()
      if (stroke) {
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
    function label(value, x, y, size, fill = p.text, weight = 600, mono = false) {
      ctx.fillStyle = fill
      ctx.font = `${weight} ${size}px ${mono ? '"JetBrains Mono", ui-monospace, monospace' : '"Inter Tight", system-ui, sans-serif'}`
      ctx.fillText(value, x, y)
    }
    function fitText(value, x, y, maxWidth, size, fill = p.text, weight = 600, mono = false) {
      ctx.fillStyle = fill
      ctx.font = `${weight} ${size}px ${mono ? '"JetBrains Mono", ui-monospace, monospace' : '"Inter Tight", system-ui, sans-serif'}`
      const chars = [...value]
      let out = ''
      for (const ch of chars) {
        if (ctx.measureText(out + ch).width > maxWidth) break
        out += ch
      }
      ctx.fillText(out, x, y)
    }
    function drawGrid() {
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      for (let x = 0; x < 1280; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 560); ctx.stroke()
      }
      for (let y = 0; y < 560; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1280, y); ctx.stroke()
      }
      ctx.restore()
    }
    function drawBackdrop() {
      ctx.fillStyle = p.base
      ctx.fillRect(0, 0, 1280, 560)
      const radial = ctx.createRadialGradient(1010, 150, 0, 1010, 150, 430)
      radial.addColorStop(0, 'rgba(59,130,246,0.24)')
      radial.addColorStop(1, 'rgba(59,130,246,0)')
      ctx.fillStyle = radial
      ctx.fillRect(0, 0, 1280, 560)
      const beam = ctx.createLinearGradient(0, 0, 1280, 0)
      beam.addColorStop(0, 'rgba(59,130,246,0)')
      beam.addColorStop(0.52, 'rgba(59,130,246,0.12)')
      beam.addColorStop(1, 'rgba(59,130,246,0)')
      ctx.fillStyle = beam
      ctx.fillRect(0, 0, 1280, 560)
      drawGrid()
    }
    function actionRow(y, icon, text, active, alpha) {
      ctx.save()
      ctx.globalAlpha = alpha
      box(740, y, 360, 46, 7, active ? 'rgba(59,130,246,0.18)' : p.elevated, active ? p.accent : p.border)
      box(756, y + 12, 22, 22, 6, p.selected, null)
      label(icon, 762, y + 29, 13, p.accentStrong, 700, true)
      label(text, 794, y + 29, 14, active ? p.text : p.secondary, 650)
      ctx.restore()
    }
    function toolRow(y, name, color, alpha) {
      ctx.save()
      ctx.globalAlpha = alpha
      box(118, y, 496, 40, 7, '#151515', p.border)
      ctx.beginPath(); ctx.arc(140, y + 20, 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill()
      label(name, 164, y + 26, 14, p.text, 650, true)
      ctx.restore()
    }
    function draw(frame) {
      const t = frame / fps
      drawBackdrop()
      const shellIn = ease(t / 0.8)
      ctx.save()
      ctx.globalAlpha = shellIn
      box(58, 28, 1164, 504, 10, 'rgba(20,20,20,0.92)', p.border)

      const titleIn = ease((t - 0.35) / 0.75)
      ctx.globalAlpha = titleIn
      label('Run Canary Lab', 740, 148, 46, p.text, 760)
      label('from your agent.', 740, 194, 46, p.text, 760)
      ctx.globalAlpha = ease((t - 0.7) / 0.55)
      label('Ask Codex or Claude Desktop to add tests,', 742, 244, 17, p.secondary, 500)
      label('start runs, and export evaluations.', 742, 268, 17, p.secondary, 500)

      const phase = t < 5.2 ? 'create' : t < 9.2 ? 'run' : 'export'
      actionRow(322, '+', 'Add a feature test', phase === 'create', ease((t - 1.0) / 0.45))
      actionRow(376, '>', 'Run selected test cases', phase === 'run', ease((t - 1.1) / 0.45))
      actionRow(430, 'E', 'Export an evaluation', phase === 'export', ease((t - 1.2) / 0.45))

      const agentIn = ease((t - 1.25) / 0.75)
      ctx.globalAlpha = agentIn
      box(92, 84, 548, 392, 9, '#101010', p.borderStrong)
      box(92, 84, 548, 42, 9, p.surface, p.border)
      label('Codex or Claude Desktop', 118, 111, 12, p.secondary, 650)
      box(500, 94, 54, 24, 5, p.elevated, p.border); label('Codex', 512, 110, 11, p.text, 650)
      box(562, 94, 62, 24, 5, p.elevated, p.border); label('Claude', 574, 110, 11, p.text, 650)

      const command =
        phase === 'create' ? ' add checkout tests'
        : phase === 'run' ? ' run selected test cases'
        : ' export an evaluation'
      ctx.globalAlpha = ease((t - 1.8) / 0.45)
      box(118, 156, 496, 62, 8, p.elevated, p.border)
      label('/canary-lab', 142, 194, 18, p.accentStrong, 750, true)
      fitText(command, 264, 194, 292, 18, p.text, 520, true)
      if (Math.floor(t * 2) % 2 === 0) box(580, 175, 7, 22, 2, p.accent, null)

      const toolA = phase === 'create' ? 'write_feature_doc' : phase === 'run' ? 'start_run' : 'export_evaluation'
      const toolB = phase === 'create' ? 'create_feature' : phase === 'run' ? 'wait_for_heal_task' : 'localized_output'
      toolRow(250, 'connect_canary_lab', p.success, ease((t - 2.25) / 0.42))
      toolRow(304, toolA, p.accent, ease((t - 2.45) / 0.42))
      toolRow(358, toolB, phase === 'run' ? p.warning : p.success, ease((t - 2.65) / 0.42))
      ctx.globalAlpha = ease((t - 3.15) / 0.5)
      box(118, 420, 496, 38, 8, 'rgba(59,130,246,0.13)', p.accent)
      label('Canary Lab handles the run over MCP.', 142, 444, 15, p.text, 730)
      label('MCP', 568, 444, 11, p.secondary, 700, true)

      const pathIn = ease((t - 2.2) / 0.55)
      ctx.globalAlpha = pathIn
      const grad = ctx.createLinearGradient(650, 376, 730, 376)
      grad.addColorStop(0, 'rgba(59,130,246,0)')
      grad.addColorStop(0.5, p.accent)
      grad.addColorStop(1, 'rgba(59,130,246,0)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(650, 376); ctx.lineTo(730, 376); ctx.stroke()
      const dotX = 650 + 80 * ((t * 0.42) % 1)
      ctx.beginPath(); ctx.arc(dotX, 376, 10, 0, Math.PI * 2); ctx.fillStyle = p.accent; ctx.fill()
      ctx.restore()
    }

    recorder.start()
    for (let frame = 0; frame < frames; frame += 1) {
      draw(frame)
      await new Promise((resolve) => setTimeout(resolve, 1000 / fps))
    }
    recorder.stop()
    return done
  }, { logicalWidth, logicalHeight, renderScale })
  fs.writeFileSync(outPath, Buffer.from(base64, 'base64'))
  console.log(outPath)
  console.log(`${fs.statSync(outPath).size} bytes`)
} finally {
  await browser.close()
}
