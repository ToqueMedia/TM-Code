#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const EXT_ROOT = process.argv[2] || '/Users/ithustle/dev/extensions/vscode-material-icon-theme'
const SRC_CORE = path.join(EXT_ROOT, 'src', 'core', 'icons')
const OUT_DIR = path.resolve('src/assets/icons/material/mappings')

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function read(p) {
  return fs.readFileSync(p, 'utf8')
}

function parseFolderIcons(ts) {
  const out = {}
  // Roughly match icon blocks: { name: 'folder-XYZ', folderNames: [ 'a', 'b' ] }
  const blockRegex = /\{\s*name:\s*'folder-([^']+)'[\s\S]*?folderNames:\s*\[([\s\S]*?)\][\s\S]*?\}/g
  let m
  while ((m = blockRegex.exec(ts)) !== null) {
    const iconBase = m[1].trim()
    const list = m[2]
    const names = Array.from(list.matchAll(/'([^']+)'/g)).map(mm => mm[1].trim().toLowerCase())
    for (const n of names) {
      out[n] = iconBase
    }
  }
  return out
}

function parseFileIcons(ts) {
  const extMap = {}
  const nameMap = {}
  // Matches: { name: 'xyz', fileExtensions: ['ts','tsx'] }
  const extBlock = /\{[\s\S]*?name:\s*'([^']+)'[\s\S]*?fileExtensions:\s*\[([\s\S]*?)\][\s\S]*?\}/g
  let m
  while ((m = extBlock.exec(ts)) !== null) {
    const iconBase = m[1].trim()
    const list = m[2]
    const exts = Array.from(list.matchAll(/'([^']+)'/g)).map(mm => mm[1].trim().toLowerCase())
    for (const e of exts) {
      extMap[e] = iconBase
    }
  }
  // Matches: { name: 'xyz', fileNames: ['dockerfile','readme'] }
  const nameBlock = /\{[\s\S]*?name:\s*'([^']+)'[\s\S]*?fileNames:\s*\[([\s\S]*?)\][\s\S]*?\}/g
  while ((m = nameBlock.exec(ts)) !== null) {
    const iconBase = m[1].trim()
    const list = m[2]
    const names = Array.from(list.matchAll(/'([^']+)'/g)).map(mm => mm[1].trim().toLowerCase())
    for (const n of names) {
      nameMap[n] = iconBase
    }
  }
  return { extMap, nameMap }
}

function main() {
  const folderTs = read(path.join(SRC_CORE, 'folderIcons.ts'))
  const fileTs = read(path.join(SRC_CORE, 'fileIcons.ts'))

  const folders = parseFolderIcons(folderTs)
  const { extMap, nameMap } = parseFileIcons(fileTs)

  ensureDir(OUT_DIR)
  fs.writeFileSync(path.join(OUT_DIR, 'folders.json'), JSON.stringify(folders, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, 'files.json'), JSON.stringify(extMap, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, 'names.json'), JSON.stringify(nameMap, null, 2))
  console.log('Generated mappings at', OUT_DIR)
}

main()