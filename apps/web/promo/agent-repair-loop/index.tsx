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

const WIDTH = 1920
const HEIGHT = 1080
const FPS = 24
const DURATION = FPS * 24
const CENTER_X = WIDTH / 2
const CENTER_Y = HEIGHT / 2

const timing = {
  introIn: 0,
  introOut: 88,
  appIn: 76,
  appOut: 508,
  healingStart: 188,
  healingEnd: 244,
  agentFixIn: 236,
  agentFixOut: 324,
  rerunIn: 316,
  journalIn: 392,
  finalIn: 500,
  finalOut: DURATION,
}

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
  const fadeIn = inFrames <= 0
    ? (frame >= start ? 1 : 0)
    : interpolate(frame, [start, start + inFrames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  const fadeOut = outFrames <= 0
    ? (frame < end ? 1 : 0)
    : interpolate(frame, [end - outFrames, end], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  return Math.min(fadeIn, fadeOut)
}

function eased(frame: number, start: number, end: number): number {
  const t = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  return Easing.out(Easing.cubic)(t)
}

function snapEased(frame: number, start: number, end: number): number {
  const t = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  return Easing.bezier(0.14, 0.86, 0.2, 1)(t)
}

function valueBetween(frame: number, start: number, end: number, from: number, to: number): number {
  const t = snapEased(frame, start, end)
  return from + (to - from) * t
}

function holdCamera(): Shot[] {
  return [
    { frame: timing.appIn, x: CENTER_X, y: CENTER_Y, zoom: 1 },
    { frame: timing.appOut, x: CENTER_X, y: CENTER_Y, zoom: 1 },
  ]
}

function healingCamera(): Shot[] {
  return [
    { frame: timing.healingStart, x: CENTER_X, y: CENTER_Y, zoom: 1 },
    { frame: timing.healingStart + 7, x: 1035, y: 575, zoom: 1.72 },
    { frame: timing.healingStart + 11, x: 1050, y: 585, zoom: 1.64 },
    { frame: timing.healingEnd, x: 1050, y: 585, zoom: 1.64 },
  ]
}

function rerunCamera(): Shot[] {
  return [
    { frame: timing.rerunIn, x: 1050, y: 585, zoom: 1.64 },
    { frame: timing.rerunIn + 12, x: 1050, y: 585, zoom: 1.64 },
    { frame: timing.rerunIn + 20, x: 940, y: 532, zoom: 0.96 },
    { frame: timing.rerunIn + 24, x: CENTER_X, y: CENTER_Y, zoom: 1 },
    { frame: timing.journalIn, x: CENTER_X, y: CENTER_Y, zoom: 1 },
  ]
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
        x: valueBetween(frame, from.frame, to.frame, from.x, to.x),
        y: valueBetween(frame, from.frame, to.frame, from.y, to.y),
        zoom: valueBetween(frame, from.frame, to.frame, from.zoom, to.zoom),
      }
    }
  }
  return shots[shots.length - 1]
}

function cameraBlur(frame: number, ranges: Array<[number, number]>): number {
  const strength = ranges.reduce((max, [start, end]) => {
    const mid = start + (end - start) / 2
    const distance = Math.abs(frame - mid) / ((end - start) / 2)
    return Math.max(max, clamp(1 - distance, 0, 1))
  }, 0)
  return strength * 3.8
}

function agentWindowMotion(frame: number, start: number, end: number): CSSProperties {
  const enter = snapEased(frame, start, start + 12)
  const exit = interpolate(frame, [end - 10, end], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const presence = Math.min(enter, exit)
  const y = (1 - enter) * 22
  const scale = 0.972 + enter * 0.028
  const blur = (1 - presence) * 5
  return {
    transform: `translate3d(0, ${y}px, 0) scale(${scale})`,
    filter: `blur(${blur}px)`,
  }
}

function frameSource(frame: number): string {
  const index = clamp(Math.round(frame), 0, DURATION - 1)
  return staticFile(`live-app/frame-${String(index).padStart(4, '0')}.jpg`)
}

function LiveAppShot({
  opacity,
  shots,
  blurRanges,
  brightness = 0.92,
}: {
  opacity: number
  shots: Shot[]
  blurRanges: Array<[number, number]>
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
        background: '#020403',
        filter: `blur(${blur}px) brightness(${brightness})`,
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
      <div style={scanlineStyle} />
    </AbsoluteFill>
  )
}

function ProductScene() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.appIn, timing.appOut, 6, 10)
  const fullOpacity = frame < timing.healingStart ? opacity : 0
  const healingOpacity = opacity * fade(frame, timing.healingStart, timing.healingEnd, 1, 6)
  const rerunOpacity = opacity * fade(frame, timing.rerunIn, timing.appOut, 2, 6)

  return (
    <>
      <LiveAppShot
        opacity={frame < timing.healingStart ? opacity : fullOpacity}
        shots={holdCamera()}
        blurRanges={[]}
      />
      <LiveAppShot
        opacity={healingOpacity}
        shots={healingCamera()}
        blurRanges={[[timing.healingStart, timing.healingStart + 11]]}
        brightness={0.96}
      />
      <LiveAppShot
        opacity={rerunOpacity}
        shots={rerunCamera()}
        blurRanges={[[timing.rerunIn + 12, timing.rerunIn + 24]]}
        brightness={0.96}
      />
    </>
  )
}

function AgentIntro() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.introIn, timing.introOut, 10, 10)
  const command = '/canary-lab run checkout. Fix failures. Rerun until green.'
  const typed = command.slice(0, Math.round(command.length * eased(frame, seconds(0.8), seconds(2.5))))
  const replyOpacity = fade(frame, seconds(2.6), timing.introOut - 4, 8, 6)
  const bootOpacity = fade(frame, seconds(3.2), timing.introOut, 8, 8)

  return (
    <AbsoluteFill style={{ ...agentSceneStyle, opacity }}>
      <AgentGlow />
      <div style={{ ...agentWindowStyle, ...agentWindowMotion(frame, timing.introIn, timing.introOut) }}>
        <AgentTitleBar label="AI Agent" status="Canary Lab connected" />
        <div style={agentBodyStyle}>
          <div style={agentSidebarStyle}>
            <div style={sidebarHeadingStyle}>Workspace</div>
            <div style={sidebarItemActiveStyle}>canary-lab</div>
            <div style={sidebarItemStyle}>checkout</div>
            <div style={sidebarItemStyle}>payments</div>
          </div>
          <div style={chatPaneStyle}>
            <Message author="You" text={typed} active />
            <div style={{ opacity: replyOpacity }}>
              <Message
                author="AI Agent"
                text="Starting Canary Lab. I will read the evidence, fix the app, and rerun."
              />
            </div>
            <div style={{ ...agentStatusRowStyle, opacity: bootOpacity }}>
              <span style={pulseDotStyle} />
              Canary Lab run is starting
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}

function AgentFixScene() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.agentFixIn, timing.agentFixOut, 8, 8)
  const first = fade(frame, timing.agentFixIn + 10, timing.agentFixOut, 6, 8)
  const second = fade(frame, timing.agentFixIn + 34, timing.agentFixOut, 6, 8)
  const patch = fade(frame, timing.agentFixIn + 46, timing.agentFixOut, 5, 8)

  return (
    <AbsoluteFill style={{ ...agentSceneStyle, opacity }}>
      <AgentGlow />
      <div style={{ ...agentWindowStyle, ...agentWindowMotion(frame, timing.agentFixIn, timing.agentFixOut) }}>
        <AgentTitleBar label="AI Agent" status="Reading Canary Lab context" />
        <div style={agentBodyStyle}>
          <div style={agentSidebarStyle}>
            <div style={sidebarHeadingStyle}>Context</div>
            <div style={sidebarItemActiveStyle}>failed test</div>
            <div style={sidebarItemStyle}>screenshot</div>
            <div style={sidebarItemStyle}>app logs</div>
          </div>
          <div style={chatPaneStyle}>
            <div style={{ opacity: first }}>
              <Message author="AI Agent" text="I read the saved error, screenshot, and app logs." />
            </div>
            <div style={{ opacity: second }}>
              <Message author="AI Agent" text="Found the checkout total bug and patched it." />
            </div>
            <div style={{ ...patchBlockStyle, opacity: patch }}>
              <div style={patchHeaderStyle}>checkout-total.ts</div>
              <div style={codeLineStyle}><span style={minusStyle}>-</span> return subtotal</div>
              <div style={codeLineStyle}><span style={plusStyle}>+</span> return subtotal + tax - discount</div>
            </div>
            <div style={{ ...agentStatusRowStyle, opacity: patch }}>
              <span style={pulseDotStyle} />
              Asking Canary Lab to rerun
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  )
}

function FinalScene() {
  const frame = useCurrentFrame()
  const opacity = fade(frame, timing.finalIn, timing.finalOut, 10, 0)
  const scale = interpolate(frame, [timing.finalIn, timing.finalIn + 18], [0.96, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const itemOpacity = (index: number) => fade(frame, timing.finalIn + 28 + index * 6, timing.finalOut, 4, 0)

  return (
    <AbsoluteFill style={{ ...finalSceneStyle, opacity }}>
      <AgentGlow />
      <div style={{ ...finalContentStyle, transform: `scale(${scale})` }}>
        <div style={finalKickerStyle}>Canary Lab + AI Agent</div>
        <h1 style={finalTitleStyle}>Run tests. Capture context. Fix fast.</h1>
        <p style={finalCopyStyle}>
          Local Playwright repair loop for apps that span services and repos.
        </p>
        <div style={finalGridStyle}>
          {[
            'Run local Playwright tests',
            'Save failure evidence',
            'Let AI Agent fix and rerun',
            'Keep the repair journal',
          ].map((item, index) => (
            <div key={item} style={{ ...finalItemStyle, opacity: itemOpacity(index) }}>
              <span style={finalItemDotStyle} />
              {item}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  )
}

function AgentTitleBar({ label, status }: { label: string; status: string }) {
  return (
    <div style={agentTitleBarStyle}>
      <div style={windowDotsStyle}>
        <span style={{ ...windowDotStyle, background: '#ff5f57' }} />
        <span style={{ ...windowDotStyle, background: '#febc2e' }} />
        <span style={{ ...windowDotStyle, background: '#28c840' }} />
      </div>
      <div style={agentTitleStyle}>{label}</div>
      <div style={agentStatusPillStyle}>
        <span style={statusDotStyle} />
        {status}
      </div>
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

function AgentGlow() {
  return (
    <>
      <div style={glowOneStyle} />
      <div style={glowTwoStyle} />
      <div style={gridStyle} />
    </>
  )
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
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  color: '#f6fbff',
  background: '#030706',
}

const scanlineStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0) 14%, rgba(0,0,0,0.08))',
  boxShadow: 'inset 0 0 90px rgba(0,0,0,0.38)',
}

const agentSceneStyle: CSSProperties = {
  background: 'radial-gradient(circle at 50% 35%, #172323 0%, #08110f 44%, #020303 100%)',
  overflow: 'hidden',
}

const agentWindowStyle: CSSProperties = {
  position: 'absolute',
  left: 175,
  top: 105,
  width: 1570,
  height: 850,
  borderRadius: 28,
  background: 'rgba(10, 14, 17, 0.91)',
  border: '1px solid rgba(255,255,255,0.13)',
  boxShadow: '0 44px 120px rgba(0,0,0,0.56), 0 0 70px rgba(32,231,176,0.08)',
  overflow: 'hidden',
}

const agentTitleBarStyle: CSSProperties = {
  height: 72,
  display: 'flex',
  alignItems: 'center',
  padding: '0 26px',
  gap: 20,
  background: 'rgba(255,255,255,0.035)',
  borderBottom: '1px solid rgba(255,255,255,0.1)',
}

const windowDotsStyle: CSSProperties = {
  display: 'flex',
  gap: 9,
}

const windowDotStyle: CSSProperties = {
  width: 13,
  height: 13,
  borderRadius: 999,
}

const agentTitleStyle: CSSProperties = {
  fontSize: 25,
  fontWeight: 800,
  color: '#f4f7fa',
}

const agentStatusPillStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '9px 14px',
  borderRadius: 999,
  background: 'rgba(32, 231, 176, 0.1)',
  border: '1px solid rgba(32, 231, 176, 0.22)',
  color: '#bffbe9',
  fontSize: 18,
  fontWeight: 700,
}

const statusDotStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: '#20e7b0',
  boxShadow: '0 0 20px rgba(32,231,176,0.9)',
}

const agentBodyStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '310px 1fr',
  height: 778,
}

const agentSidebarStyle: CSSProperties = {
  borderRight: '1px solid rgba(255,255,255,0.1)',
  padding: 26,
  background: 'rgba(255,255,255,0.02)',
}

const sidebarHeadingStyle: CSSProperties = {
  marginBottom: 24,
  color: '#8da0a2',
  fontSize: 18,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 3,
}

const sidebarItemStyle: CSSProperties = {
  padding: '17px 18px',
  borderRadius: 14,
  color: '#aebabc',
  fontSize: 21,
  fontWeight: 650,
  marginBottom: 10,
}

const sidebarItemActiveStyle: CSSProperties = {
  ...sidebarItemStyle,
  color: '#f5fbff',
  background: 'rgba(32,231,176,0.12)',
  border: '1px solid rgba(32,231,176,0.22)',
}

const chatPaneStyle: CSSProperties = {
  padding: 42,
}

const messageStyle: CSSProperties = {
  marginBottom: 28,
}

const messageAuthorStyle: CSSProperties = {
  marginBottom: 10,
  color: '#8fa1a4',
  fontSize: 18,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: 2.5,
}

const messageBubbleStyle: CSSProperties = {
  width: 'fit-content',
  maxWidth: 880,
  padding: '24px 28px',
  borderRadius: 24,
  background: 'rgba(255,255,255,0.07)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: '#ecf3f6',
  fontSize: 32,
  lineHeight: 1.34,
  fontWeight: 700,
  letterSpacing: 0,
}

const messageBubbleActiveStyle: CSSProperties = {
  ...messageBubbleStyle,
  background: 'linear-gradient(135deg, rgba(38,122,255,0.28), rgba(32,231,176,0.16))',
  border: '1px solid rgba(118,175,255,0.35)',
}

const agentStatusRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 13,
  marginTop: 14,
  padding: '13px 18px',
  borderRadius: 999,
  color: '#c8fbef',
  background: 'rgba(32,231,176,0.1)',
  border: '1px solid rgba(32,231,176,0.22)',
  fontSize: 22,
  fontWeight: 750,
}

const pulseDotStyle: CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: 999,
  background: '#20e7b0',
  boxShadow: '0 0 24px rgba(32,231,176,0.9)',
}

const patchBlockStyle: CSSProperties = {
  width: 840,
  marginTop: 24,
  borderRadius: 20,
  overflow: 'hidden',
  background: 'rgba(2,6,7,0.72)',
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 24px 80px rgba(0,0,0,0.32)',
}

const patchHeaderStyle: CSSProperties = {
  padding: '15px 22px',
  color: '#9eb0b5',
  background: 'rgba(255,255,255,0.055)',
  fontSize: 18,
  fontWeight: 800,
  letterSpacing: 1,
}

const codeLineStyle: CSSProperties = {
  padding: '13px 22px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 24,
  color: '#dce8eb',
}

const minusStyle: CSSProperties = {
  color: '#ff6b8f',
  marginRight: 16,
}

const plusStyle: CSSProperties = {
  color: '#20e7b0',
  marginRight: 16,
}

const glowOneStyle: CSSProperties = {
  position: 'absolute',
  left: 250,
  top: 30,
  width: 520,
  height: 520,
  borderRadius: 999,
  background: 'radial-gradient(circle, rgba(32,231,176,0.16), rgba(32,231,176,0) 64%)',
  filter: 'blur(12px)',
}

const glowTwoStyle: CSSProperties = {
  position: 'absolute',
  right: 140,
  bottom: 20,
  width: 560,
  height: 560,
  borderRadius: 999,
  background: 'radial-gradient(circle, rgba(65,137,255,0.17), rgba(65,137,255,0) 64%)',
  filter: 'blur(14px)',
}

const gridStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  opacity: 0.16,
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)',
  backgroundSize: '64px 64px',
  maskImage: 'radial-gradient(circle at 50% 45%, black 0%, transparent 72%)',
}

const finalSceneStyle: CSSProperties = {
  background: 'linear-gradient(135deg, #06130f 0%, #081315 45%, #030405 100%)',
  overflow: 'hidden',
}

const finalContentStyle: CSSProperties = {
  position: 'absolute',
  left: 180,
  top: 172,
  width: 1260,
  transformOrigin: 'left center',
}

const finalKickerStyle: CSSProperties = {
  display: 'inline-flex',
  padding: '12px 18px',
  borderRadius: 999,
  background: 'rgba(32,231,176,0.12)',
  border: '1px solid rgba(32,231,176,0.22)',
  color: '#c7fbec',
  fontSize: 24,
  fontWeight: 850,
  letterSpacing: 0,
}

const finalTitleStyle: CSSProperties = {
  margin: '34px 0 22px',
  maxWidth: 1180,
  color: '#f7fbff',
  fontSize: 94,
  lineHeight: 0.98,
  fontWeight: 900,
  letterSpacing: 0,
}

const finalCopyStyle: CSSProperties = {
  margin: 0,
  maxWidth: 920,
  color: '#bdd0d3',
  fontSize: 34,
  lineHeight: 1.3,
  fontWeight: 650,
  letterSpacing: 0,
}

const finalGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 18,
  width: 960,
  marginTop: 56,
}

const finalItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  minHeight: 82,
  padding: '0 24px',
  borderRadius: 18,
  background: 'rgba(255,255,255,0.07)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#eef6f8',
  fontSize: 26,
  fontWeight: 800,
  letterSpacing: 0,
}

const finalItemDotStyle: CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: 999,
  background: '#20e7b0',
  boxShadow: '0 0 18px rgba(32,231,176,0.78)',
  flexShrink: 0,
}

registerRoot(RemotionRoot)
