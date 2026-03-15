/**
 * Configuração para Firebase Emulators
 *
 * Portas alinhadas com ~/dev/web/toquemedia-studio
 */

export const EMULATOR_CONFIG = {
  FUNCTIONS: {
    HOST: '127.0.0.1',
    PORT: 5001,
  },
  FIRESTORE: {
    HOST: '127.0.0.1',
    PORT: 8081,
  },
  AUTH: {
    HOST: '127.0.0.1',
    PORT: 9099,
  },
  STORAGE: {
    HOST: '127.0.0.1',
    PORT: 9199,
  },
} as const

export const isDevelopment = (): boolean => {
  return import.meta.env.DEV
}

export const shouldUseEmulators = (): boolean => {
  return isDevelopment() && import.meta.env.VITE_USE_EMULATORS !== 'false'
}
