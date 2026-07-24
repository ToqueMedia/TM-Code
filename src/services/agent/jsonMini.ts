/**
 * Minified JSON for the model-input path.
 *
 * Kept in a zero-dependency module so hot paths (toolExecutor diffs, search
 * fallbacks) never pull `@toon-format/toon` into the bundle graph.
 *
 * Never use `JSON.stringify(x, null, 2)` for prompt content — pretty-print is
 * for disk/UI only.
 */
export function jsonMini(value: unknown): string {
  return JSON.stringify(value)
}
