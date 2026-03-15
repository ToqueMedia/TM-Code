import { logger, LogLevel, logError, logWarn, logInfo, logDebug } from '../logger'

describe('logger', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('singleton', () => {
    it('exports a logger instance', () => {
      expect(logger).toBeDefined()
    })

    it('is the same instance every time', () => {
      // The module exports a singleton — two accesses give the same object
      const { logger: logger2 } = require('../logger')
      expect(logger).toBe(logger2)
    })
  })

  describe('log methods', () => {
    it('has error method that does not throw', () => {
      expect(() => logger.error('test', 'error message')).not.toThrow()
    })

    it('has warn method that does not throw', () => {
      expect(() => logger.warn('test', 'warn message')).not.toThrow()
    })

    it('has info method that does not throw', () => {
      expect(() => logger.info('test', 'info message')).not.toThrow()
    })

    it('has debug method that does not throw', () => {
      expect(() => logger.debug('test', 'debug message')).not.toThrow()
    })
  })

  describe('convenience category methods', () => {
    it('has fileWatcher method', () => {
      expect(() => logger.fileWatcher('file changed')).not.toThrow()
    })

    it('has theme method', () => {
      expect(() => logger.theme('theme loaded')).not.toThrow()
    })

    it('has editor method', () => {
      expect(() => logger.editor('editor ready')).not.toThrow()
    })

    it('has window method', () => {
      expect(() => logger.window('window resized')).not.toThrow()
    })

    it('has terminal method', () => {
      expect(() => logger.terminal('terminal started')).not.toThrow()
    })
  })

  describe('convenience exported functions', () => {
    it('logError does not throw', () => {
      expect(() => logError('cat', 'msg')).not.toThrow()
    })

    it('logWarn does not throw', () => {
      expect(() => logWarn('cat', 'msg')).not.toThrow()
    })

    it('logInfo does not throw', () => {
      expect(() => logInfo('cat', 'msg')).not.toThrow()
    })

    it('logDebug does not throw', () => {
      expect(() => logDebug('cat', 'msg')).not.toThrow()
    })
  })

  describe('configuration methods', () => {
    it('setLogLevel does not throw', () => {
      expect(() => logger.setLogLevel(LogLevel.WARN)).not.toThrow()
    })

    it('enableCategory does not throw', () => {
      expect(() => logger.enableCategory('custom')).not.toThrow()
    })

    it('disableCategory does not throw', () => {
      expect(() => logger.disableCategory('custom')).not.toThrow()
    })

    it('getStats returns an array', () => {
      const stats = logger.getStats()
      expect(Array.isArray(stats)).toBe(true)
    })
  })

  describe('LogLevel enum', () => {
    it('defines expected levels', () => {
      expect(LogLevel.ERROR).toBe(0)
      expect(LogLevel.WARN).toBe(1)
      expect(LogLevel.INFO).toBe(2)
      expect(LogLevel.DEBUG).toBe(3)
    })
  })
})
