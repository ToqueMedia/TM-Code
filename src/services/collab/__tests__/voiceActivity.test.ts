import { byteTimeDomainRms, createSpeakingTracker } from '../voiceActivity'

const OPTS = { onRms: 0.04, offRms: 0.015, holdMs: 600 }

describe('voiceActivity', () => {
  it('flips to speaking at the on-threshold', () => {
    const vad = createSpeakingTracker(OPTS)
    expect(vad.feed(0.01, 0)).toBe(false)
    expect(vad.feed(0.05, 200)).toBe(true)
  })

  it('holds speaking through short pauses (hold window)', () => {
    const vad = createSpeakingTracker(OPTS)
    vad.feed(0.05, 0)
    // Quiet, but the hold window hasn't lapsed yet.
    expect(vad.feed(0.001, 200)).toBe(true)
    expect(vad.feed(0.001, 500)).toBe(true)
    // Loud again before the hold expires → the window restarts.
    expect(vad.feed(0.06, 590)).toBe(true)
    expect(vad.feed(0.001, 1000)).toBe(true)
    // Now the full hold elapses in silence → silent.
    expect(vad.feed(0.001, 1200)).toBe(false)
  })

  it('stays silent below the on-threshold and holds state in the ambiguous band', () => {
    const vad = createSpeakingTracker(OPTS)
    // Mid-band before ever speaking: stays silent.
    expect(vad.feed(0.02, 0)).toBe(false)
    vad.feed(0.05, 100)
    // Mid-band while speaking: stays speaking, even long past the hold.
    expect(vad.feed(0.02, 2000)).toBe(true)
    // Truly quiet + hold elapsed (lastLoud was at 100) → silent.
    expect(vad.feed(0.001, 2700)).toBe(false)
  })

  it('reset returns to silent', () => {
    const vad = createSpeakingTracker(OPTS)
    vad.feed(0.05, 0)
    vad.reset()
    expect(vad.feed(0.001, 10)).toBe(false)
  })

  it('computes RMS from byte-domain samples', () => {
    // Flat line at the 128 midpoint = digital silence.
    expect(byteTimeDomainRms(new Uint8Array([128, 128, 128, 128]))).toBe(0)
    // Full-scale square wave (0 / 255) ≈ RMS 1.
    expect(byteTimeDomainRms(new Uint8Array([0, 255, 0, 255]))).toBeCloseTo(1, 1)
    expect(byteTimeDomainRms(new Uint8Array([]))).toBe(0)
  })
})
