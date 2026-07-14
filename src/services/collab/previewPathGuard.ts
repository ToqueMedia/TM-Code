// Defense-in-depth path blocklist for the live-preview tunnel.
//
// Pure static SPAs are served from a production BUILD (no dev endpoints), but
// the FULLSTACK strategy tunnels the real DEV server — and Vite's dev server
// exposes `/@fs/<absolute path>`, which reads files ANYWHERE fs.allow permits
// (typically well beyond the project). Teammates are inside the team trust
// boundary, but "trusted for this project's preview" must not mean "can read
// the sharer's disk". `/@fs` is therefore refused outright: plain apps never
// need it in the browser (it shows up for monorepo/linked-dep imports; if a
// preview legitimately breaks on this, the viewer's error page names the
// blocked path). The keyword net below stays as the second layer for
// secret/VCS/key material that leaks into otherwise-servable paths.

const BLOCKED_PATH =
  /(^|\/)\.(env|git|ssh|aws|npmrc|netrc)(\/|\.|$)|\.(pem|key|p12|pfx|keystore)(\?|$)|(^|\/)id_(rsa|ed25519|ecdsa)(\/|$)/i

/** Vite dev-server escape hatches: arbitrary-path file serving + the
 *  open-in-editor helper some plugins register. */
const BLOCKED_DEV_ENDPOINT = /^\/(@fs(\/|$)|__open-in-editor)/i

/** True when a tunneled request path must be refused (secret/VCS/key material
 *  or a dev-server endpoint that reaches outside the shared app). */
export function isBlockedPreviewPath(path: string): boolean {
  // Compare against the path portion only (strip the query string).
  const p = path.split('?')[0]
  return BLOCKED_DEV_ENDPOINT.test(p) || BLOCKED_PATH.test(p)
}
