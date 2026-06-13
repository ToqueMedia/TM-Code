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

// Beat It-inspired, but original: 80s dance-rock with an iconic minor-key
// guitar riff. Instrumental so it never fights the on-screen UI text.
// Structure mirrors the video arc: synth-stab intro → riff kicks in
// (typing/agent) → tension build (diff/E2E) → triumphant resolution
// (tests pass) → virtuoso solo hook finale (branding CTA).
const PROMPT = [
  '1980s dance-rock instrumental in a minor key, around 138 BPM, in the style',
  'of classic 80s pop-rock crossover hits. Opens with 3 seconds of ominous',
  'gong-like synth stabs over silence, then an iconic tight syncopated',
  'palm-muted electric guitar riff kicks in, doubled by a driving rock',
  'bassline and a punchy four-on-the-floor 80s drum groove with crisp snare.',
  'A second rhythm guitar answers with sharp power-chord accents. Tension',
  'builds with rising guitar harmonies and a brief stripped-down breakdown,',
  'then erupts into a blazing virtuoso electric guitar solo with whammy dives',
  'and fast hammer-on runs, finishing on a big triumphant riff restatement.',
  'Cinematic, punchy, polished 80s arena production, suitable as a product',
  'promo soundtrack. No vocals.',
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
