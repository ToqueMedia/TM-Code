// Tiny self-contained notification chime via the Web Audio API — no asset to
// bundle/load. Used to alert about an incoming team-chat message when the chat
// panel is closed. Fails silent if audio is unavailable.

let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      ctx = new Ctor()
    }
    // Browsers/WebKit suspend the context until a gesture; resume best-effort.
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/**
 * Play a short two-note "blip" (≈140 ms). Soft sine tones with a quick
 * attack/decay so it reads as a gentle alert, not a system beep.
 */
export function playMessageChime(): void {
  const ac = audioContext()
  if (!ac) return
  try {
    const now = ac.currentTime
    const notes = [
      { freq: 660, at: 0 },
      { freq: 880, at: 0.08 },
    ]
    for (const note of notes) {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = note.freq
      gain.gain.setValueAtTime(0.0001, now + note.at)
      gain.gain.exponentialRampToValueAtTime(0.11, now + note.at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + 0.12)
      osc.connect(gain)
      gain.connect(ac.destination)
      osc.start(now + note.at)
      osc.stop(now + note.at + 0.14)
    }
  } catch {
    /* audio glitched — never let a chime break message handling */
  }
}

// Prime the AudioContext on the first user gesture so the very first incoming
// chime isn't swallowed by the browser's autoplay/suspend policy. One-shot;
// no-op in jsdom (AudioContext is undefined → audioContext() returns null).
if (typeof document !== 'undefined') {
  const prime = () => {
    audioContext()
    document.removeEventListener('pointerdown', prime)
    document.removeEventListener('keydown', prime)
  }
  document.addEventListener('pointerdown', prime, { once: true })
  document.addEventListener('keydown', prime, { once: true })
}
