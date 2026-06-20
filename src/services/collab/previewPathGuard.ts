// Defense-in-depth path blocklist for the live-preview tunnel.
//
// The Live Preview now serves a production BUILD (static output dir), so there
// is no dev-server file-serving (/@fs) and no source to leak. This blocklist is
// a remaining safety net: refuse paths that would leak secrets / VCS / keys IF
// they somehow ended up inside the build output (e.g. a misconfigured copy of
// `.env` into dist). Cheap and harmless on a clean build.

const BLOCKED_PATH =
  /(^|\/)\.(env|git|ssh|aws|npmrc|netrc)(\/|\.|$)|\.(pem|key|p12|pfx|keystore)(\?|$)|(^|\/)id_(rsa|ed25519|ecdsa)(\/|$)/i

/** True when a tunneled request path must be refused (secret/VCS/key material). */
export function isBlockedPreviewPath(path: string): boolean {
  // Compare against the path portion only (strip the query string).
  const p = path.split('?')[0]
  return BLOCKED_PATH.test(p)
}
