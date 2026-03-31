#!/usr/bin/env node
/**
 * Generate all Tauri icon sizes from icon-source.svg
 * Usage: node scripts/generate-icons.mjs
 */
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICONS_DIR = join(__dirname, '..', 'src-tauri', 'icons')
const SVG_PATH = join(ICONS_DIR, 'icon-source.svg')

// All sizes needed by Tauri
const SIZES = {
  // macOS
  'icon.png': 1024,
  '32x32.png': 32,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  // Windows
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'Square71x71Logo.png': 71,
  'Square89x89Logo.png': 89,
  'Square107x107Logo.png': 107,
  'Square142x142Logo.png': 142,
  'Square150x150Logo.png': 150,
  'Square284x284Logo.png': 284,
  'Square310x310Logo.png': 310,
  'StoreLogo.png': 50,
}

const svgData = readFileSync(SVG_PATH, 'utf8')

console.log('Generating icon PNGs from icon-source.svg...\n')

for (const [filename, size] of Object.entries(SIZES)) {
  const resvg = new Resvg(svgData, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)', // transparent outside rounded rect
  })
  const rendered = resvg.render()
  const pngBuffer = rendered.asPng()
  const outPath = join(ICONS_DIR, filename)
  writeFileSync(outPath, pngBuffer)
  console.log(`  ${filename} (${size}x${size}) — ${(pngBuffer.length / 1024).toFixed(1)} KB`)
}

// Generate .icns for macOS using iconutil
console.log('\nGenerating icon.icns...')
const iconsetDir = join(ICONS_DIR, 'AppIcon.iconset')
mkdirSync(iconsetDir, { recursive: true })

const ICNS_SIZES = {
  'icon_16x16.png': 16,
  'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32,
  'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256,
  'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512,
  'icon_512x512@2x.png': 1024,
}

for (const [filename, size] of Object.entries(ICNS_SIZES)) {
  const resvg = new Resvg(svgData, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  })
  const rendered = resvg.render()
  writeFileSync(join(iconsetDir, filename), rendered.asPng())
}

try {
  execSync(`iconutil -c icns -o "${join(ICONS_DIR, 'icon.icns')}" "${iconsetDir}"`)
  console.log('  icon.icns — OK')
} catch (err) {
  console.error('  icon.icns — FAILED (iconutil error)')
}

// Generate .ico for Windows (embed 16, 32, 48, 256)
console.log('\nGenerating icon.ico...')
const ICO_SIZES = [16, 32, 48, 256]
const icoImages = ICO_SIZES.map(size => {
  const resvg = new Resvg(svgData, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  })
  const rendered = resvg.render()
  return { size, data: rendered.asPng() }
})

// ICO format: header + directory entries + PNG data
function buildIco(images) {
  const headerSize = 6
  const dirEntrySize = 16
  const dirSize = dirEntrySize * images.length
  let dataOffset = headerSize + dirSize

  // Header: reserved(2) + type(2) + count(2)
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)           // reserved
  header.writeUInt16LE(1, 2)           // type: 1 = ICO
  header.writeUInt16LE(images.length, 4)

  const dirEntries = []
  const dataBuffers = []

  for (const img of images) {
    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0)  // width (0 = 256)
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1)  // height
    entry.writeUInt8(0, 2)             // color palette
    entry.writeUInt8(0, 3)             // reserved
    entry.writeUInt16LE(1, 4)          // color planes
    entry.writeUInt16LE(32, 6)         // bits per pixel
    entry.writeUInt32LE(img.data.length, 8)  // data size
    entry.writeUInt32LE(dataOffset, 12)       // data offset

    dirEntries.push(entry)
    dataBuffers.push(img.data)
    dataOffset += img.data.length
  }

  return Buffer.concat([header, ...dirEntries, ...dataBuffers])
}

const icoBuffer = buildIco(icoImages)
writeFileSync(join(ICONS_DIR, 'icon.ico'), icoBuffer)
console.log(`  icon.ico — ${(icoBuffer.length / 1024).toFixed(1)} KB`)

// Cleanup iconset directory
execSync(`rm -rf "${iconsetDir}"`)

console.log('\nDone! All icons generated.')
