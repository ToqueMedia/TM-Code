// src/utils/errors.ts — Standardized error class for all services
import { t } from '@/i18n'

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

/**
 * Convert any thrown value to a useful string. Tauri's `invoke()` and
 * downstream layers throw a mix of shapes (Error, string, plain object
 * with a `message` field, plain object without it). Naive `String(err)`
 * collapses non-Error objects to `[object Object]` — the literal string
 * the model then sees as the tool result, which is useless for diagnosis.
 *
 * Resolution order:
 *   1. Error instance      → `err.message` (with `err.cause` appended when present)
 *   2. string              → as-is
 *   3. number / boolean    → String(err)
 *   4. null / undefined    → "Unknown error"
 *   5. object with .message → `err.message`
 *   6. object              → JSON.stringify (truncated at 500 chars to avoid blowing
 *                            the context with deep stack-like blobs)
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined && cause !== null) {
      const causeStr = formatError(cause)
      return `${err.message} (cause: ${causeStr})`
    }
    return err.message || err.name || t('error.default')
  }
  if (typeof err === 'string') return err
  if (typeof err === 'number' || typeof err === 'boolean') return String(err)
  if (err === null || err === undefined) return t('error.unknown')
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>

    // Standard message field — Error-like shapes from Node/browser/Web fetch.
    const msg = obj.message
    if (typeof msg === 'string' && msg.length > 0) return msg

    // Tauri serde-tagged enums commonly serialise as `{"VariantName": "..."}`
    // (e.g. FileTreeError -> `{"PathNotFound":"Path not found: /foo"}`).
    // Render as `VariantName: payload` so the model sees a normal sentence
    // instead of a JSON blob.
    const keys = Object.keys(obj)
    if (keys.length === 1) {
      const key = keys[0]
      const value = obj[key]
      if (typeof value === 'string') return `${key}: ${value}`
      if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${String(value)}`
    }

    // Generic fallback — full JSON, truncated. Better than "[object Object]".
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}') return json.length > 500 ? json.slice(0, 500) + '...' : json
    } catch { /* circular ref → fall through */ }
    return 'Unserializable error object'
  }
  return String(err)
}
