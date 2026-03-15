// src/utils/errors.ts — Standardized error class for all services

export class ServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean = false
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}
