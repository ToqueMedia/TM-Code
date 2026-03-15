import '@testing-library/jest-dom'

// Mock Tauri API core — prevents tests from needing the Tauri runtime
jest.mock('@tauri-apps/api/core', () => ({
  invoke: jest.fn(),
}))

// Mock Tauri plugin-fs
jest.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: jest.fn(),
  writeTextFile: jest.fn(),
  exists: jest.fn(),
  mkdir: jest.fn(),
  readDir: jest.fn(),
  remove: jest.fn(),
}))

// Mock Tauri plugin-dialog
jest.mock('@tauri-apps/plugin-dialog', () => ({
  open: jest.fn(),
  save: jest.fn(),
  message: jest.fn(),
  ask: jest.fn(),
}))

// Mock window.crypto.subtle for sessionService hashing
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      subtle: {
        digest: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
      },
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
        return arr
      },
    },
  })
}
