/**
 * Compare two semver strings (major.minor.patch, pre-release segment ignored).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Intentionally minimal — the project only compares its own release versions
 * against the updater's reported target, both of which follow the
 * "major.minor.patch[-prerelease]" shape. Not a general-purpose semver.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const pa = parse(a), pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0, db = pb[i] ?? 0
    if (da < db) return -1
    if (da > db) return 1
  }
  return 0
}
