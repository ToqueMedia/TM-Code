import { getVersion } from '@tauri-apps/api/app'
import {
  getInstalledVersionStorageKey,
  syncInstalledTmCodeVersion,
  type WriteInstalledVersion,
} from '../tmCodeVersionSync'

jest.mock('@tauri-apps/api/app', () => ({
  getVersion: jest.fn(),
}))

const mockGetVersion = getVersion as jest.MockedFunction<typeof getVersion>

describe('syncInstalledTmCodeVersion', () => {
  const uid = 'user-123'
  let writeInstalledVersion: jest.MockedFunction<WriteInstalledVersion>

  beforeEach(() => {
    window.localStorage.clear()
    mockGetVersion.mockResolvedValue('0.7.4')
    writeInstalledVersion = jest.fn().mockResolvedValue(undefined)
  })

  it('writes Firestore then localStorage when no local version exists', async () => {
    await expect(syncInstalledTmCodeVersion(uid, writeInstalledVersion)).resolves.toBe('0.7.4')

    expect(writeInstalledVersion).toHaveBeenCalledWith('0.7.4')
    expect(window.localStorage.getItem(getInstalledVersionStorageKey(uid))).toBe('0.7.4')
  })

  it('skips Firestore when localStorage already has the current version', async () => {
    window.localStorage.setItem(getInstalledVersionStorageKey(uid), '0.7.4')

    await syncInstalledTmCodeVersion(uid, writeInstalledVersion)

    expect(writeInstalledVersion).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(getInstalledVersionStorageKey(uid))).toBe('0.7.4')
  })

  it('updates Firestore and localStorage when the installed version changes', async () => {
    window.localStorage.setItem(getInstalledVersionStorageKey(uid), '0.7.3')

    await syncInstalledTmCodeVersion(uid, writeInstalledVersion)

    expect(writeInstalledVersion).toHaveBeenCalledWith('0.7.4')
    expect(window.localStorage.getItem(getInstalledVersionStorageKey(uid))).toBe('0.7.4')
  })

  it('does not update localStorage if the remote write fails', async () => {
    window.localStorage.setItem(getInstalledVersionStorageKey(uid), '0.7.3')
    writeInstalledVersion.mockRejectedValue(new Error('network failed'))

    await expect(syncInstalledTmCodeVersion(uid, writeInstalledVersion)).rejects.toThrow('network failed')

    expect(window.localStorage.getItem(getInstalledVersionStorageKey(uid))).toBe('0.7.3')
  })
})
