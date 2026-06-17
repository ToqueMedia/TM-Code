#!/usr/bin/env node
/**
 * Generates the promo soundtrack via the MiniMax Music API and writes it to
 * public/assets/audio/tmcode-promo-track-raw.mp3.
 *
 * Docs: https://platform.minimax.io/docs/api-reference/music-generation
 *   POST https://api.minimax.io/v1/music_generation  (Bearer auth)
 *
 * Key resolution order:
 *   1. MINIMAX_API_KEY env var
 *   2. .minimax_key file next to package.json (gitignored)
 *
 * Usage: node scripts/generate-music.mjs [model]   (default: music-2.6)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function resolveKey() {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY.trim()
  const keyFile = join(root, '.minimax_key')
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim()
  console.error(
    'MiniMax API key not found.\n' +
      'Provide it via MINIMAX_API_KEY env var or a .minimax_key file in remotion-video/.',
  )
  process.exit(1)
}

const MODEL = process.argv[2] || 'music-2.6'

// Inspired by the euphoric feel-good party-anthem vibe of late-2000s crossover
// dance-pop (think "I Gotta Feeling") — but an ORIGINAL instrumental, no melody
// copied. Instrumental so it never fights the on-screen UI text. Structure
// mirrors the video arc: shimmering intro → groove kicks in (prompt/agent) →
// filtered build (diff/#design) → triumphant hands-in-the-air drop (deploy) →
// bright uplifting finale (CTA).
const PROMPT = [
  'Euphoric feel-good dance-pop instrumental, around 128 BPM, bright major key,',
  'in the uplifting festival electro-pop spirit of late-2000s crossover party',
  'anthems. Opens with a warm shimmering synth-pad intro and a soft plucked',
  'arpeggio, then a punchy four-on-the-floor kick, crisp hand-claps and an',
  'upbeat bassline drop in. Big anthemic supersaw chord progression, sparkling',
  'synth arpeggios and a catchy whistle-style lead hook. A short filtered build',
  'with a riser and snare roll erupts into a triumphant, joyful drop with',
  'hands-in-the-air energy, then resolves on a bright uplifting final chorus.',
  'Polished, radio-ready, positive and celebratory — perfect under a product',
  'promo. No vocals.',
].join(' ')

const key = resolveKey()

const body = {
  model: MODEL,
  prompt: PROMPT,
  is_instrumental: true,
  output_format: 'hex',
  audio_setting: {
    sample_rate: 44100,
    bitrate: 256000,
    format: 'mp3',
  },
}

console.log(`Requesting ${MODEL} track from MiniMax…`)
const res = await fetch('https://api.minimax.io/v1/music_generation', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

const json = await res.json().catch(() => null)
if (!res.ok || !json) {
  console.error(`HTTP ${res.status}`, JSON.stringify(json).slice(0, 500))
  process.exit(1)
}

const status = json.base_resp?.status_code
if (status !== 0) {
  console.error(
    `MiniMax error ${status}: ${json.base_resp?.status_msg || 'unknown'}\n` +
      (status === 1008 ? 'Insufficient balance — try model "music-2.6-free".' : ''),
  )
  process.exit(1)
}

const hex = json.data?.audio
if (!hex || typeof hex !== 'string') {
  console.error('No audio in response:', JSON.stringify(json).slice(0, 500))
  process.exit(1)
}

const audio = Buffer.from(hex, 'hex')
const outDir = join(root, 'public', 'assets', 'audio')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'tmcode-promo-track-raw.mp3')
writeFileSync(outFile, audio)

const info = json.extra_info || {}
console.log(`Saved ${outFile} (${(audio.length / 1024).toFixed(0)} KB)`)
console.log('extra_info:', JSON.stringify(info))
console.log('\nNext: trim to 42s →')
console.log(
  '  npx remotion ffmpeg -y -i public/assets/audio/tmcode-promo-track-raw.mp3 -t 42 \\\n' +
    '    -af "afade=t=in:st=0:d=0.8,afade=t=out:st=39.0:d=3.0" \\\n' +
    '    public/assets/audio/tmcode-promo-track.mp3',
)
