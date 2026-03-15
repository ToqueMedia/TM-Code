import { ServiceError } from '../errors'

describe('ServiceError', () => {
  it('extends Error', () => {
    const err = new ServiceError('test error', 'TEST_CODE')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ServiceError)
  })

  it('has the correct message', () => {
    const err = new ServiceError('Something went wrong', 'GENERIC')
    expect(err.message).toBe('Something went wrong')
  })

  it('has the correct code', () => {
    const err = new ServiceError('Not found', 'NOT_FOUND')
    expect(err.code).toBe('NOT_FOUND')
  })

  it('defaults retryable to false', () => {
    const err = new ServiceError('fail', 'FATAL')
    expect(err.retryable).toBe(false)
  })

  it('accepts retryable = true', () => {
    const err = new ServiceError('Network timeout', 'TIMEOUT', true)
    expect(err.retryable).toBe(true)
  })

  it('has name set to ServiceError', () => {
    const err = new ServiceError('test', 'CODE')
    expect(err.name).toBe('ServiceError')
  })

  it('has a stack trace', () => {
    const err = new ServiceError('with stack', 'STACK_TEST')
    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('ServiceError')
  })

  it('can be caught as Error', () => {
    let caught = false
    try {
      throw new ServiceError('thrown', 'THROWN', true)
    } catch (e) {
      caught = true
      expect(e).toBeInstanceOf(Error)
      if (e instanceof ServiceError) {
        expect(e.code).toBe('THROWN')
        expect(e.retryable).toBe(true)
      }
    }
    expect(caught).toBe(true)
  })
})
