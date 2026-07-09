// Pure voice-activity detection (VAD) logic — extracted from the WebAudio
// plumbing in collabVoice so the hysteresis/hold behavior is unit-testable
// without an AudioContext.
//
// Two thresholds (enter loud / exit quiet) prevent flapping right at the
// boundary, and a hold window keeps "speaking" alive through natural
// inter-word pauses so the indicator doesn't strobe while someone talks.

export interface SpeakingTrackerOptions {
  /** RMS at/above which we flip to speaking. */
  onRms: number
  /** RMS below which (after the hold) we flip back to silent. Must be < onRms. */
  offRms: number
  /** How long the signal must stay quiet before we flip back to silent. */
  holdMs: number
}

export const SPEAKING_DEFAULTS: SpeakingTrackerOptions = {
  onRms: 0.04,
  offRms: 0.015,
  holdMs: 600,
}

export interface SpeakingTracker {
  /** Feed one RMS sample at `nowMs`; returns the current speaking state. */
  feed(rms: number, nowMs: number): boolean
  reset(): void
}

export function createSpeakingTracker(
  opts: SpeakingTrackerOptions = SPEAKING_DEFAULTS,
): SpeakingTracker {
  let speaking = false
  let lastLoudAt = 0
  return {
    feed(rms, nowMs) {
      if (rms >= opts.onRms) {
        lastLoudAt = nowMs
        speaking = true
      } else if (speaking && rms < opts.offRms && nowMs - lastLoudAt >= opts.holdMs) {
        speaking = false
      }
      // Between the two thresholds: ambiguous — hold the current state.
      return speaking
    },
    reset() {
      speaking = false
      lastLoudAt = 0
    },
  }
}

/**
 * RMS of a byte-domain waveform (AnalyserNode.getByteTimeDomainData: 0..255
 * centered on 128, normalized here to 0..1). The byte API — not the float
 * one — because it's the variant WebKit has always supported.
 */
export function byteTimeDomainRms(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / samples.length)
}
