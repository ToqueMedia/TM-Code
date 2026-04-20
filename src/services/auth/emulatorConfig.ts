/**
 * Configuração para Firebase Emulators
 *
 * Portas alinhadas com ~/dev/web/toquemedia-studio
 */

import { IS_WINDOWS } from '../../utils/platform'

const EMULATOR_HOST = (import.meta.env.DEV && IS_WINDOWS) ? '192.168.64.1' : '127.0.0.1'

export const EMULATOR_CONFIG = {
  FUNCTIONS: {
    HOST: EMULATOR_HOST,
    PORT: 5001,
  },
  FIRESTORE: {
    HOST: EMULATOR_HOST,
    PORT: 8081,
  },
  AUTH: {
    HOST: EMULATOR_HOST,
    PORT: 9099,
  },
  STORAGE: {
    HOST: EMULATOR_HOST,
    PORT: 9199,
  },
} as const

export const isDevelopment = (): boolean => {
  return import.meta.env.DEV
}

export const shouldUseEmulators = (): boolean => {
  return isDevelopment() && import.meta.env.VITE_USE_EMULATORS !== 'false'
}
