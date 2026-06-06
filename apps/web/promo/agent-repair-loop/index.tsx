import React, { type CSSProperties } from 'react'
import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  interpolate,
  registerRoot,
  staticFile,
  useCurrentFrame,
} from 'remotion'
import { loadFont as loadDisplay } from '@remotion/google-fonts/BricolageGrotesque'
import { loadFont as loadSans } from '@remotion/google-fonts/Sora'
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono'

const { fontFamily: DISPLAY } = loadDisplay('normal', { weights: ['600', '700', '800'], subsets: ['latin'] })
const { fontFamily: SANS } = loadSans('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] })
const { fontFamily: MONO } = loadMono('normal', { weights: ['400', '500', '700'], subsets: ['latin'] })

const WIDTH = 1920
const HEIGHT = 1080
const FPS = 24
const DURATION = FPS * 20
const CENTER_X = WIDTH / 2
const CENTER_Y = HEIGHT / 2

// Timing boundaries are locked to the captured live-app frames (see capture-live-app.mjs).
const timing = {
  introIn: 0,
  introOut: 72,
  appIn: 56,
  appOut: 400,
  healingStart: 128,
  healingEnd: 166,
  agentFixIn: 158,
  agentFixOut: 238,
  rerunIn: 226,
  journalIn: 300,
  finalIn: 374,
  finalOut: DURATION,
}

const journalScrollEnd = timing.finalIn - 3

// Neutral, near-black product base (matches the real Canary Lab UI). Color is used
// sparingly as functional accents only: teal/green = pass, blue = running, amber = heal.
const C = {
  bgDeep: '#08090B',
  ink: '#ECEFF1',
  inkMid: '#99A2A6',
  inkLow: '#646D71',
  green: '#34E2AE',
  cyan: '#54E6DF',
  blue: '#5B9DF9',
  amber: '#F2B85C',
  glassBorder: 'rgba(255, 255, 255, 0.08)',
  glassBorderActive: 'rgba(52, 226, 174, 0.28)',
}
const ACCENT = 'linear-gradient(135deg, #34E2AE 0%, #54E6DF 100%)'

type Shot = {
  frame: number
  x: number
  y: number
  zoom: number
}

function seconds(value: number): number {
  return Math.round(value * FPS)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fade(frame: number, start: number, end: number, inFrames = 8, outFrames = 8): number {
  const rawIn = inFrames <= 0
    ? (frame >= start ? 1 : 0)
    : interpolate(frame, [start, start + inFrames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  const fadeIn = inFrames <= 0 ? rawIn : Easing.out(Easing.cubic)(rawIn)
  const rawOut = outFrames <= 0
    ? (frame < end ? 1 : 0)
    : interpolate(frame, [end - outFrames, end], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  const fadeOut = outFrames <= 0 ? rawOut : 1 - Easing.in(Easing.cubic)(1 - rawOut)
  return Math.min(fadeIn, fadeOut)
}

function eased(frame: number, start: number, end: number): number {
  const t = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  return Easing.out(Easing.cubic)(t)
}

// Gentle, symmetric ease for UI elements — no overshoot, no snap.
function softEased(frame: number, start: number, end: number): number {
  const t = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  return Easing.inOut(Easing.cubic)(t)
}

// Promotional camera: fast, punchy ease-out (rapid move, hard settle) for hyperzooms.
const punch = Easing.bezier(0.16, 1, 0.3, 1)
function cameraValue(frame: number, start: number, end: number, from: number, to: number): number {
  const t = punch(interpolate(frame, [start, end], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))
  return from + (to - from) * t
}

function uiValue(frame: number, start: number, end: number, from: number, to: number): number {
  const t = softEased(frame, start, end)
  return from + (to - from) * t
}

// Hyperzoom targets in full-res (1920x1080) coords. Establish the whole app, then punch in hard.
// Establish wide, then a fast hyperzoom into the FAILURE ("Expected $124.00 but received $112.00").
function holdCamera(): Shot[] {
  return [
    { frame: timing.appIn, x: CENTER_X, y: CENTER_Y, zoom: 1.0 },
    { frame: 104, x: 950, y: 524, zoom: 1.08 },
    { frame: 116, x: 800, y: 690, zoom: 2.35 },
    { frame: timing.healingStart, x: 808, y: 694, zoom: 2.5 },
  ]
}

// Punch into the AI Agent heal card (EXTERNAL HEAL SESSION · HEALING · cycles).
function healingCamera(): Shot[] {
  return [
    { frame: timing.healingStart, x: 940, y: 652, zoom: 1.3 },
    { frame: timing.healingStart + 9, x: 952, y: 660, zoom: 1.9 },
    { frame: timing.healingEnd + 24, x: 968, y: 666, zoom: 2.0 },
  ]
}

// Punch into the test list as badges cascade to PASSED (green) — "going green".
function rerunCamera(): Shot[] {
  return [
    { frame: timing.rerunIn, x: 900, y: 470, zoom: 1.2 },
    { frame: timing.rerunIn + 9, x: 440, y: 430, zoom: 2.2 },
    { frame: timing.journalIn, x: 470, y: 560, zoom: 2.26 },
  ]
}

// Punch into the repair journal, then drift down through the iterations.
function journalCamera(): Shot[] {
  return [
    { frame: timing.journalIn, x: 950, y: 640, zoom: 1.22 },
    { frame: timing.journalIn + 9, x: 950, y: 560, zoom: 1.95 },
    { frame: timing.finalIn, x: 958, y: 720, zoom: 2.0 },
  ]
}

// Short, strong motion blur centered on each hyperzoom — sells the speed of the move.
function cameraBlur(frame: number, ranges: Array<[number, number]>): number {
  const strength = ranges.reduce((max, [start, end]) => {
    const mid = start + (end - start) / 2
    const distance = Math.abs(frame - mid) / ((end - start) / 2)
    return Math.max(max, clamp(1 - distance, 0, 1))
  }, 0)
  return strength * 8
}

function cameraAt(frame: number, shots: Shot[]): Shot {
  if (shots.length === 0) return { frame, x: CENTER_X, y: CENTER_Y, zoom: 1 }
  if (frame <= shots[0].frame) return shots[0]
  for (let index = 0; index < shots.length - 1; index += 1) {
    const from = shots[index]
    const to = shots[index + 1]
    if (frame >= from.frame && frame <= to.frame) {
      return {
        frame,
        x: cameraValue(frame, from.frame, to.frame, from.x, to.x),
        y: cameraValue(frame, from.frame, to.frame, from.y, to.y),
        zoom: cameraValue(frame, from.frame, to.frame, from.zoom, to.zoom),
      }
    }
  }
  return shots[shots.length - 1]
}

function frameSource(frame: number): string {
  const index = clamp(Math.round(frame), 0, DURATION - 1)
  return staticFile(`live-app/frame-${String(index).padStart(4, '0')}.jpg`)
}

function LiveAppShot({
  opacity,
  shots,
  blurRanges = [],
  brightness = 0.96,
}: {
  opacity: number
  shots: Shot[]
  blurRanges?: Array<[number, number]>
  brightness?: number
}) {
  const frame = useCurrentFrame()
  const shot = cameraAt(frame, shots)
  const blur = cameraBlur(frame, blurRanges)
  const x = CENTER_X - shot.x * shot.zoom
  const y = CENTER_Y - shot.y * shot.zoom

  return (
    <AbsoluteFill
      style={{
        overflow: 'hidden',
        opacity,
        background: C.bgDeep,
        filter: `blur(${blur}px) brightness(${brightness}) saturate(1.05) contrast(1.02)`,
      }}
    >
      <Img
        src={frameSource(frame)}
        style={{
          width: WIDTH,
          height: HEIGHT,
          objectFit: 'cover',
          transform: `translate3d(${x}px, ${y}px, 0) scale(${shot.zoom})`,
          transformOrigin: '0 0',
        }}
      />
      <div style={screenGradeStyle} />
      <div style={vignetteStyle} />
    </AbsoluteFill>
  )
}

function JournalWarpShot({ opacity }: { opacity: number }) {
  const frame = useCurrentFrame()
  const backgroundY = uiValue(frame, timing.journalIn, timing.finalIn, -30, 60)

  return (
    <>
      <AbsoluteFill
        style={{
          overflow: 'hidden',
          opacity: opacity * fade(frame, timing.journalIn, timing.finalIn, 1, 10),
          background: C.bgDeep,
          filter: 'blur(13px) brightness(0.5) saturate(0.95)',
          transform: `translate3d(0, ${backgroundY}px, 0) scale(1.06)`,
        }}
      >
        <Img
          src={frameSource(frame)}
          style={{ width: WIDTH, height: HEIGHT, objectFit: 'cover' }}
        />
      </AbsoluteFill>
      <LiveAppShot
        opacity={opacity}
        shots={journalCamera()}
        blurRanges={[[timing.journalIn, timing.journalIn + 12]]}
        brightness={1.0}
      />
    </>
  )
}

function ProductScene() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.appIn, timing.appOut, 8, 10)
  const fullOpacity = frame < timing.healingStart ? opacity : 0
  const healingOpacity = opacity * fade(frame, timing.healingStart, timing.healingEnd, 0, 6)
  const rerunOpacity = opacity * fade(frame, timing.rerunIn, timing.journalIn + 5, 4, 5)
  const journalOpacity = opacity * fade(frame, timing.journalIn, timing.finalIn, 1, 8)

  return (
    <>
      <LiveAppShot
        opacity={frame < timing.healingStart ? opacity : fullOpacity}
        shots={holdCamera()}
        blurRanges={[[110, 122]]}
      />
      <LiveAppShot
        opacity={healingOpacity}
        shots={healingCamera()}
        blurRanges={[[timing.healingStart, timing.healingStart + 12]]}
      />
      <LiveAppShot
        opacity={rerunOpacity}
        shots={rerunCamera()}
        blurRanges={[[timing.rerunIn, timing.rerunIn + 12]]}
      />
      <JournalWarpShot opacity={journalOpacity} />
    </>
  )
}

function AgentIntro() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.introIn, timing.introOut, 9, 7)
  const command = '/canary-lab run checkout. Fix failures. Rerun until green.'
  const typed = command.slice(0, Math.round(command.length * eased(frame, seconds(0.45), seconds(1.55))))
  const replyOpacity = fade(frame, seconds(1.6), timing.introOut - 3, 6, 5)
  const bootOpacity = fade(frame, seconds(2.05), timing.introOut, 6, 5)

  return (
    <AbsoluteFill style={{ ...agentSceneStyle, opacity, ...sceneKick(frame, timing.introIn, timing.introOut) }}>
      <Atmosphere accent="teal" />
      <div style={{ ...agentWindowStyle, ...agentWindowMotion(frame, timing.introIn, timing.introOut) }}>
        <AgentTitleBar status="Canary Lab connected" />
        <div style={agentBodyStyle}>
          <Sidebar heading="Workspace" items={['canary-lab', 'checkout', 'payments']} active={0} />
          <div style={chatPaneStyle}>
            <Message author="You" text={typed} active />
            <div style={{ opacity: replyOpacity }}>
              <Message
                author="AI Agent"
                text="Starting Canary Lab. I'll read the evidence, fix the app, and rerun until it's green."
              />
            </div>
            <div style={{ ...statusRowStyle, opacity: bootOpacity }}>
              <PulseDot frame={frame} />
              Canary Lab run is starting
            </div>
          </div>
          <RunRail stage="intro" frame={frame} reveal={fade(frame, seconds(0.7), timing.introOut, 8, 5)} />
        </div>
      </div>
    </AbsoluteFill>
  )
}

function AgentFixScene() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.agentFixIn, timing.agentFixOut, 7, 7)
  const first = fade(frame, timing.agentFixIn + 5, timing.agentFixOut, 5, 6)
  const second = fade(frame, timing.agentFixIn + 18, timing.agentFixOut, 5, 6)
  const patch = fade(frame, timing.agentFixIn + 30, timing.agentFixOut, 5, 6)

  return (
    <AbsoluteFill style={{ ...agentSceneStyle, opacity, ...sceneKick(frame, timing.agentFixIn, timing.agentFixOut) }}>
      <Atmosphere accent="teal" />
      <div style={{ ...agentWindowStyle, ...agentWindowMotion(frame, timing.agentFixIn, timing.agentFixOut) }}>
        <AgentTitleBar status="Reading Canary Lab context" />
        <div style={agentBodyStyle}>
          <Sidebar heading="Context" items={['failed test', 'screenshot', 'app logs']} active={0} />
          <div style={chatPaneStyle}>
            <div style={{ opacity: first }}>
              <Message author="AI Agent" text="I read the saved error, screenshot, and app logs." />
            </div>
            <div style={{ opacity: second }}>
              <Message author="AI Agent" text="Found the checkout total bug and patched it." />
            </div>
            <div style={{ ...patchBlockStyle, opacity: patch, transform: `translate3d(0, ${(1 - patch) * 12}px, 0)` }}>
              <div style={patchHeaderStyle}>checkout-total.ts</div>
              <div style={codeLineStyle}><span style={minusStyle}>-</span> return subtotal</div>
              <div style={codeLineStyle}><span style={plusStyle}>+</span> return subtotal + tax - discount</div>
            </div>
            <div style={{ ...statusRowStyle, opacity: patch }}>
              <PulseDot frame={frame} />
              Asking Canary Lab to rerun
            </div>
          </div>
          <RunRail stage="fix" frame={frame} reveal={fade(frame, timing.agentFixIn + 8, timing.agentFixOut, 8, 6)} />
        </div>
      </div>
    </AbsoluteFill>
  )
}

function FinalScene() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.finalIn, timing.finalOut, 8, 0)
  const snapIn = softEased(frame, timing.finalIn, timing.finalIn + 14)
  const scale = 0.97 + snapIn * 0.03
  const itemMotion = (index: number): CSSProperties => {
    const start = timing.finalIn + 20 + index * 4
    const enter = softEased(frame, start, start + 9)
    return {
      opacity: fade(frame, start, timing.finalOut, 4, 0),
      transform: `translate3d(0, ${(1 - enter) * 16}px, 0)`,
    }
  }

  return (
    <AbsoluteFill style={{ ...finalSceneStyle, opacity }}>
      <Atmosphere accent="final" />
      <LoopGraphic frame={frame} />
      <div style={{ ...finalContentStyle, transform: `translateY(${(1 - snapIn) * 14}px) scale(${scale})` }}>
        <div style={{ ...finalKickerStyle, opacity: fade(frame, timing.finalIn, timing.finalOut, 6, 0) }}>
          <span style={kickerDotStyle} />
          CANARY LAB &times; AI AGENT
        </div>
        <h1 style={finalTitleStyle}>
          Run tests.<br />Capture context.<br /><span style={titleAccentStyle}>Fix fast.</span>
        </h1>
        <p style={finalCopyStyle}>
          A local Playwright repair loop for apps that span services and repos.
        </p>
        <div style={finalGridStyle}>
          {[
            'Run local Playwright tests',
            'Save failure evidence',
            'Let an AI agent fix & rerun',
            'Keep the repair journal',
          ].map((item, index) => (
            <div key={item} style={{ ...finalItemStyle, ...itemMotion(index) }}>
              <span style={finalItemDotStyle} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  )
}

function Sidebar({ heading, items, active }: { heading: string; items: string[]; active: number }) {
  return (
    <div style={agentSidebarStyle}>
      <div style={sidebarHeadingStyle}>{heading}</div>
      {items.map((item, index) => (
        <div key={item} style={index === active ? sidebarItemActiveStyle : sidebarItemStyle}>
          {index === active ? <span style={sidebarTickStyle} /> : <span style={sidebarBulletStyle} />}
          {item}
        </div>
      ))}
    </div>
  )
}

function RunRail({ stage, frame, reveal }: { stage: 'intro' | 'fix'; frame: number; reveal: number }) {
  const isFix = stage === 'fix'
  const rows = isFix
    ? [
      { label: 'Run failed', value: '1 test', tone: 'fail' as const },
      { label: 'Heal cycle', value: '06', tone: 'heal' as const },
      { label: 'Evidence', value: 'trace · shot · logs', tone: 'mute' as const },
    ]
    : [
      { label: 'Services', value: '3 booting', tone: 'mute' as const },
      { label: 'Env', value: 'local', tone: 'mute' as const },
      { label: 'Tests', value: '0 / 22', tone: 'mute' as const },
    ]
  const status = isFix ? 'HEALING' : 'STARTING'
  const passed = isFix ? 5 : 0
  const total = 22

  return (
    <div style={{ ...runRailStyle, opacity: reveal, transform: `translate3d(${(1 - reveal) * 18}px, 0, 0)` }}>
      <div style={railLabelStyle}>Canary Lab Run</div>
      <div style={railRunIdStyle}>2026-06-01 · checkout</div>
      <div style={{ ...railStatusStyle, color: isFix ? C.amber : C.blue, borderColor: isFix ? 'rgba(242,184,92,0.3)' : 'rgba(91,157,249,0.3)', background: isFix ? 'rgba(242,184,92,0.08)' : 'rgba(91,157,249,0.08)' }}>
        <span style={{ ...railStatusDotStyle, background: isFix ? C.amber : C.blue }} />
        {status}
      </div>

      <div style={railMetersStyle}>
        {rows.map((row) => (
          <div key={row.label} style={railRowStyle}>
            <span style={railRowLabelStyle}>{row.label}</span>
            <span style={{
              ...railRowValueStyle,
              color: row.tone === 'fail' ? '#ff8aa6' : row.tone === 'heal' ? C.amber : C.ink,
            }}>{row.value}</span>
          </div>
        ))}
      </div>

      <div style={railProgressLabelStyle}>
        <span>Checkout suite</span>
        <span>{passed} / {total}</span>
      </div>
      <div style={railProgressTrackStyle}>
        <div style={{
          ...railProgressFillStyle,
          width: `${(passed / total) * 100}%`,
        }} />
      </div>

      <div style={railSparkStyle}>
        {Array.from({ length: 14 }).map((_, index) => {
          const wobble = (Math.sin(frame / 7 + index) + 1) / 2
          const lit = isFix ? index < 9 : index < 2
          return (
            <span
              key={index}
              style={{
                ...railSparkBarStyle,
                height: 8 + wobble * (lit ? 26 : 10),
                background: lit ? ACCENT : 'rgba(255,255,255,0.09)',
                opacity: lit ? 0.55 + wobble * 0.45 : 0.5,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

function LoopGraphic({ frame }: { frame: number }) {
  const reveal = fade(frame, timing.finalIn + 14, timing.finalOut, 14, 0)
  const rot = (frame - timing.finalIn) * 0.45
  const pulse = (Math.sin(frame / 9) + 1) / 2
  const nodes = ['RUN', 'FAIL', 'HEAL', 'RERUN', 'PASS']
  const R = 168
  const cx = 280
  const cy = 280

  return (
    <div style={{ ...loopWrapStyle, opacity: reveal, transform: `translateY(${(1 - reveal) * 24}px) scale(${0.92 + reveal * 0.08})` }}>
      <div style={loopGlowStyle} />
      <svg width={560} height={560} viewBox="0 0 560 560" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <linearGradient id="loopAccent" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#2EE6B0" />
            <stop offset="1" stopColor="#54E6DF" />
          </linearGradient>
        </defs>
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={1.5} />
        <circle
          cx={cx}
          cy={cy}
          r={R}
          fill="none"
          stroke="url(#loopAccent)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray="150 906"
          transform={`rotate(${rot} ${cx} ${cy})`}
          opacity={0.9}
        />
        {nodes.map((label, index) => {
          const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2
          const nx = cx + Math.cos(angle) * R
          const ny = cy + Math.sin(angle) * R
          const isPass = label === 'PASS'
          return (
            <g key={label}>
              <circle
                cx={nx}
                cy={ny}
                r={isPass ? 9 + pulse * 2 : 5}
                fill={isPass ? '#2EE6B0' : '#0a1a17'}
                stroke={isPass ? '#7dffd9' : 'rgba(255,255,255,0.28)'}
                strokeWidth={isPass ? 2 : 1.5}
              />
              <text
                x={nx}
                y={ny + (Math.sin(angle) >= 0 ? 30 : -22)}
                textAnchor="middle"
                fontFamily={MONO}
                fontSize={17}
                fontWeight={500}
                letterSpacing={1.5}
                fill={isPass ? '#9affe0' : C.inkLow}
              >
                {label}
              </text>
            </g>
          )
        })}
      </svg>
      <div style={loopCenterStyle}>
        <div style={loopCheckStyle}>
          <svg width={34} height={34} viewBox="0 0 24 24" fill="none">
            <path d="M4 12.5l5 5L20 6" stroke="#03100D" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={loopCountStyle}>22 / 22</div>
        <div style={loopCountLabelStyle}>TESTS GREEN</div>
      </div>
    </div>
  )
}

function AgentTitleBar({ status }: { status: string }) {
  return (
    <div style={agentTitleBarStyle}>
      <div style={windowDotsStyle}>
        <span style={{ ...windowDotStyle, background: '#ff5f57' }} />
        <span style={{ ...windowDotStyle, background: '#febc2e' }} />
        <span style={{ ...windowDotStyle, background: '#28c840' }} />
      </div>
      <div style={agentTitleStyle}>
        <span style={agentMarkStyle} />
        AI&nbsp;Agent
      </div>
      <div style={agentStatusPillStyle}>
        <span style={statusDotStyle} />
        {status}
      </div>
      <div style={titleBarAccentStyle} />
    </div>
  )
}

function Message({ author, text, active = false }: { author: string; text: string; active?: boolean }) {
  return (
    <div style={messageStyle}>
      <div style={messageAuthorStyle}>{author}</div>
      <div style={active ? messageBubbleActiveStyle : messageBubbleStyle}>{text}</div>
    </div>
  )
}

function PulseDot({ frame }: { frame: number }) {
  const pulse = (Math.sin(frame / 6) + 1) / 2
  return (
    <span style={{
      ...pulseDotStyle,
      boxShadow: `0 0 ${10 + pulse * 16}px rgba(46,230,176,${0.5 + pulse * 0.4})`,
      transform: `scale(${0.85 + pulse * 0.3})`,
    }} />
  )
}

function Atmosphere({ accent }: { accent: 'teal' | 'final' }) {
  const frame = useCurrentFrame()
  const sweep = ((frame % 240) / 240) * 160 - 30
  return (
    <>
      <div style={accent === 'final' ? glowFinalOneStyle : glowOneStyle} />
      <div style={accent === 'final' ? glowFinalTwoStyle : glowTwoStyle} />
      <div style={gridStyle} />
      <div style={{ ...sweepStyle, transform: `translateY(${sweep}%)` }} />
      <div style={grainStyle} />
      <div style={vignetteStyle} />
    </>
  )
}

function sceneKick(frame: number, start: number, end: number): CSSProperties {
  const kickIn = softEased(frame, start, start + 10)
  const kickOut = softEased(frame, end - 9, end)
  const opacity = Math.min(kickIn, 1 - kickOut)
  const scale = 0.99 + kickIn * 0.01 - kickOut * 0.008
  return { transform: `scale(${scale})`, opacity }
}

function agentWindowMotion(frame: number, start: number, end: number): CSSProperties {
  const enter = softEased(frame, start, start + 11)
  const exit = interpolate(frame, [end - 8, end], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const presence = Math.min(enter, exit)
  const y = (1 - enter) * 20
  const scale = 0.975 + enter * 0.025
  return {
    transform: `translate3d(0, ${y}px, 0) scale(${scale})`,
    opacity: presence,
  }
}

function CanaryLabAgentPromo() {
  return (
    <AbsoluteFill style={rootStyle}>
      <ProductScene />
      <AgentIntro />
      <AgentFixScene />
      <FinalScene />
    </AbsoluteFill>
  )
}

function RemotionRoot() {
  return (
    <Composition
      id="CanaryLabAgentPromo"
      component={CanaryLabAgentPromo}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  )
}

const rootStyle: CSSProperties = {
  fontFamily: SANS,
  color: C.ink,
  background: C.bgDeep,
}

// ---------- Product-scene grade ----------

const screenGradeStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(0,0,0,0) 22%, rgba(8,9,11,0.18) 100%)',
}

const vignetteStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  background: 'radial-gradient(120% 120% at 50% 42%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.32) 86%, rgba(0,0,0,0.55) 100%)',
}

// ---------- Atmosphere ----------

const glowOneStyle: CSSProperties = {
  position: 'absolute',
  left: '4%',
  top: '-18%',
  width: 680,
  height: 680,
  borderRadius: 999,
  background: 'radial-gradient(circle, rgba(52,226,174,0.08), rgba(52,226,174,0) 60%)',
  filter: 'blur(30px)',
}

const glowTwoStyle: CSSProperties = {
  position: 'absolute',
  right: '-8%',
  bottom: '-22%',
  width: 760,
  height: 760,
  borderRadius: 999,
  background: 'radial-gradient(circle, rgba(91,157,249,0.06), rgba(91,157,249,0) 60%)',
  filter: 'blur(34px)',
}

const glowFinalOneStyle: CSSProperties = {
  ...glowOneStyle,
  left: '-10%',
  top: '-22%',
  width: 820,
  height: 820,
  background: 'radial-gradient(circle, rgba(52,226,174,0.07), rgba(52,226,174,0) 58%)',
}

const glowFinalTwoStyle: CSSProperties = {
  ...glowTwoStyle,
  right: '2%',
  top: '6%',
  bottom: 'auto',
  width: 860,
  height: 860,
  background: 'radial-gradient(circle, rgba(91,157,249,0.05), rgba(91,157,249,0) 60%)',
}

const gridStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  opacity: 0.6,
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)',
  backgroundSize: '76px 76px',
  maskImage: 'radial-gradient(circle at 50% 40%, black 0%, transparent 72%)',
  WebkitMaskImage: 'radial-gradient(circle at 50% 40%, black 0%, transparent 72%)',
}

const sweepStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: '40%',
  pointerEvents: 'none',
  background: 'linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.018) 50%, rgba(255,255,255,0) 100%)',
  mixBlendMode: 'screen',
}

// Static film grain via fractal-noise SVG data URI.
const grainStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  opacity: 0.045,
  mixBlendMode: 'overlay',
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
  backgroundSize: '180px 180px',
}

// ---------- Agent window ----------

const agentSceneStyle: CSSProperties = {
  background: 'radial-gradient(130% 100% at 50% 24%, #121418 0%, #0c0d10 48%, #08090b 100%)',
  overflow: 'hidden',
}

const agentWindowStyle: CSSProperties = {
  position: 'absolute',
  left: 175,
  top: 110,
  width: 1570,
  height: 840,
  borderRadius: 26,
  background: 'linear-gradient(180deg, rgba(22,24,28,0.95) 0%, rgba(13,14,17,0.96) 100%)',
  border: `1px solid ${C.glassBorder}`,
  boxShadow: '0 50px 130px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.06)',
  overflow: 'hidden',
}

const agentTitleBarStyle: CSSProperties = {
  position: 'relative',
  height: 72,
  display: 'flex',
  alignItems: 'center',
  padding: '0 28px',
  gap: 20,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01))',
  borderBottom: `1px solid ${C.glassBorder}`,
}

const titleBarAccentStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: -1,
  height: 1,
  background: 'linear-gradient(90deg, rgba(52,226,174,0) 0%, rgba(52,226,174,0.22) 22%, rgba(84,230,223,0.22) 50%, rgba(52,226,174,0) 90%)',
}

const windowDotsStyle: CSSProperties = { display: 'flex', gap: 9 }

const windowDotStyle: CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: 999,
}

const agentTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  fontFamily: DISPLAY,
  fontSize: 24,
  fontWeight: 700,
  color: '#f4fbf8',
  letterSpacing: -0.2,
}

const agentMarkStyle: CSSProperties = {
  width: 18,
  height: 18,
  borderRadius: 6,
  background: ACCENT,
  boxShadow: '0 0 16px rgba(46,230,176,0.55)',
}

const agentStatusPillStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 15px',
  borderRadius: 999,
  background: 'rgba(46,230,176,0.1)',
  border: '1px solid rgba(46,230,176,0.24)',
  color: '#bffbe9',
  fontFamily: MONO,
  fontSize: 15,
  fontWeight: 500,
  letterSpacing: 0.3,
}

const statusDotStyle: CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: 999,
  background: C.green,
  boxShadow: '0 0 18px rgba(46,230,176,0.9)',
}

const agentBodyStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '290px 1fr 372px',
  height: 768,
}

const agentSidebarStyle: CSSProperties = {
  borderRight: `1px solid ${C.glassBorder}`,
  padding: 26,
  background: 'rgba(255,255,255,0.015)',
}

const sidebarHeadingStyle: CSSProperties = {
  marginBottom: 22,
  color: C.inkLow,
  fontFamily: MONO,
  fontSize: 14,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: 3,
}

const sidebarItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 13,
  padding: '16px 16px',
  borderRadius: 13,
  color: C.inkMid,
  fontSize: 20,
  fontWeight: 500,
  marginBottom: 8,
}

const sidebarItemActiveStyle: CSSProperties = {
  ...sidebarItemStyle,
  color: '#f3fcf9',
  background: 'rgba(46,230,176,0.1)',
  border: '1px solid rgba(46,230,176,0.22)',
}

const sidebarBulletStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: 'rgba(150,240,215,0.28)',
  flexShrink: 0,
}

const sidebarTickStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: C.green,
  boxShadow: '0 0 12px rgba(46,230,176,0.8)',
  flexShrink: 0,
}

const chatPaneStyle: CSSProperties = {
  padding: '40px 44px',
}

const messageStyle: CSSProperties = { marginBottom: 26 }

const messageAuthorStyle: CSSProperties = {
  marginBottom: 10,
  color: C.inkLow,
  fontFamily: MONO,
  fontSize: 14,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: 2.5,
}

const messageBubbleStyle: CSSProperties = {
  width: 'fit-content',
  maxWidth: 760,
  padding: '22px 28px',
  borderRadius: '22px 22px 22px 8px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: '#eaf4f1',
  fontSize: 29,
  lineHeight: 1.36,
  fontWeight: 500,
}

const messageBubbleActiveStyle: CSSProperties = {
  ...messageBubbleStyle,
  borderRadius: '22px 22px 8px 22px',
  background: 'rgba(255,255,255,0.07)',
  border: '1px solid rgba(52,226,174,0.22)',
  color: '#f4fffb',
}

const statusRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 12,
  marginTop: 12,
  padding: '12px 18px',
  borderRadius: 999,
  color: '#c8fbef',
  background: 'rgba(46,230,176,0.08)',
  border: '1px solid rgba(46,230,176,0.2)',
  fontFamily: MONO,
  fontSize: 18,
  fontWeight: 500,
}

const pulseDotStyle: CSSProperties = {
  width: 11,
  height: 11,
  borderRadius: 999,
  background: C.green,
  flexShrink: 0,
}

const patchBlockStyle: CSSProperties = {
  width: 720,
  marginTop: 22,
  borderRadius: 18,
  overflow: 'hidden',
  background: 'rgba(2,8,7,0.78)',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: '0 24px 70px rgba(0,0,0,0.36)',
}

const patchHeaderStyle: CSSProperties = {
  padding: '14px 22px',
  color: C.inkMid,
  background: 'rgba(255,255,255,0.04)',
  fontFamily: MONO,
  fontSize: 16,
  fontWeight: 500,
  letterSpacing: 0.5,
  borderBottom: '1px solid rgba(255,255,255,0.07)',
}

const codeLineStyle: CSSProperties = {
  padding: '12px 22px',
  fontFamily: MONO,
  fontSize: 22,
  color: '#d6e6e2',
}

const minusStyle: CSSProperties = { color: '#ff7d9c', marginRight: 16, fontWeight: 700 }
const plusStyle: CSSProperties = { color: C.green, marginRight: 16, fontWeight: 700 }

// ---------- Run rail ----------

const runRailStyle: CSSProperties = {
  borderLeft: `1px solid ${C.glassBorder}`,
  padding: '32px 30px',
  background: 'rgba(255,255,255,0.012)',
  display: 'flex',
  flexDirection: 'column',
}

const railLabelStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 14,
  fontWeight: 500,
  letterSpacing: 3,
  textTransform: 'uppercase',
  color: C.inkLow,
}

const railRunIdStyle: CSSProperties = {
  marginTop: 8,
  fontFamily: MONO,
  fontSize: 17,
  color: C.inkMid,
}

const railStatusStyle: CSSProperties = {
  marginTop: 18,
  alignSelf: 'flex-start',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 9,
  padding: '8px 14px',
  borderRadius: 999,
  border: '1px solid',
  fontFamily: MONO,
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: 1.5,
}

const railStatusDotStyle: CSSProperties = { width: 9, height: 9, borderRadius: 999 }

const railMetersStyle: CSSProperties = {
  marginTop: 26,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const railRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '14px 0',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
}

const railRowLabelStyle: CSSProperties = { color: C.inkLow, fontSize: 18, fontWeight: 500 }
const railRowValueStyle: CSSProperties = { fontFamily: MONO, fontSize: 18, fontWeight: 500 }

const railProgressLabelStyle: CSSProperties = {
  marginTop: 30,
  display: 'flex',
  justifyContent: 'space-between',
  color: C.inkMid,
  fontFamily: MONO,
  fontSize: 15,
  letterSpacing: 0.5,
}

const railProgressTrackStyle: CSSProperties = {
  marginTop: 12,
  height: 8,
  borderRadius: 999,
  background: 'rgba(255,255,255,0.07)',
  overflow: 'hidden',
}

const railProgressFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 999,
  background: ACCENT,
  boxShadow: '0 0 18px rgba(46,230,176,0.6)',
}

const railSparkStyle: CSSProperties = {
  marginTop: 'auto',
  display: 'flex',
  alignItems: 'flex-end',
  gap: 7,
  height: 40,
}

const railSparkBarStyle: CSSProperties = {
  flex: 1,
  borderRadius: 3,
}

// ---------- Final scene ----------

const finalSceneStyle: CSSProperties = {
  background: 'radial-gradient(120% 110% at 24% 28%, #14161a 0%, #0c0e11 48%, #08090b 100%)',
  overflow: 'hidden',
}

const finalContentStyle: CSSProperties = {
  position: 'absolute',
  left: 150,
  top: 158,
  width: 1060,
  transformOrigin: 'left top',
}

const finalKickerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 11,
  padding: '11px 18px',
  borderRadius: 999,
  background: 'rgba(46,230,176,0.1)',
  border: '1px solid rgba(46,230,176,0.24)',
  color: '#c7fbec',
  fontFamily: MONO,
  fontSize: 19,
  fontWeight: 500,
  letterSpacing: 2,
}

const kickerDotStyle: CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: 999,
  background: C.green,
  boxShadow: '0 0 14px rgba(46,230,176,0.9)',
}

const finalTitleStyle: CSSProperties = {
  margin: '30px 0 22px',
  color: '#f6fffb',
  fontFamily: DISPLAY,
  fontSize: 92,
  lineHeight: 1.0,
  fontWeight: 800,
  letterSpacing: -1.5,
}

const titleAccentStyle: CSSProperties = {
  background: ACCENT,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: 'transparent',
}

const finalCopyStyle: CSSProperties = {
  margin: 0,
  maxWidth: 760,
  color: C.inkMid,
  fontSize: 30,
  lineHeight: 1.4,
  fontWeight: 400,
}

const finalGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 16,
  width: 880,
  marginTop: 50,
}

const finalItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  minHeight: 78,
  padding: '0 24px',
  borderRadius: 16,
  background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))',
  border: `1px solid ${C.glassBorder}`,
  color: '#edf6f3',
  fontSize: 24,
  fontWeight: 600,
}

const finalItemDotStyle: CSSProperties = {
  width: 11,
  height: 11,
  borderRadius: 999,
  background: ACCENT,
  boxShadow: '0 0 16px rgba(46,230,176,0.7)',
  flexShrink: 0,
}

// ---------- Loop graphic ----------

const loopWrapStyle: CSSProperties = {
  position: 'absolute',
  right: 150,
  top: 250,
  width: 560,
  height: 560,
}

const loopGlowStyle: CSSProperties = {
  position: 'absolute',
  inset: 40,
  borderRadius: 999,
  background: 'radial-gradient(circle, rgba(46,230,176,0.18), rgba(46,230,176,0) 64%)',
  filter: 'blur(20px)',
}

const loopCenterStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
}

const loopCheckStyle: CSSProperties = {
  width: 60,
  height: 60,
  borderRadius: 999,
  background: ACCENT,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 0 34px rgba(46,230,176,0.55)',
  marginBottom: 6,
}

const loopCountStyle: CSSProperties = {
  fontFamily: DISPLAY,
  fontSize: 56,
  fontWeight: 800,
  color: '#f6fffb',
  letterSpacing: -1,
}

const loopCountLabelStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 16,
  fontWeight: 500,
  letterSpacing: 3,
  color: C.green,
}

registerRoot(RemotionRoot)
