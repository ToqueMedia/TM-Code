// Shared dev-command flag injection. Both the Chat-preview server
// (devServerManager, injects `--host`) and the team Live Preview server
// (livePreviewServer, injects `--port`) need to append flags to a dev command,
// handling the package-manager indirection (`npm run dev -- <flags>`) vs a
// direct framework binary (`vite <flags>`). Kept in one place so the two stay
// in sync on the framework command shapes they recognise.

/** A dev command run through a package manager (`npm run dev`, `pnpm start`…). */
export const PM_DEV_CMD_RE = /^(npm|yarn|pnpm|bun)\s+(run\s+\w+|start|dev)\b/

/** A direct framework dev binary (vite, next dev, ng serve, …). */
export const FRAMEWORK_DEV_CMD_RE =
  /^(npx\s+)?(ng\s+serve|next\s+dev|vite|nuxt\s+dev|astro\s+dev|svelte-kit\s+dev)\b/

/**
 * Append `flags` to a dev command, inserting the `--` separator when it runs
 * through a package manager. Returns null when the command shape isn't
 * recognised (caller keeps the command unchanged / relies on env vars).
 */
export function appendDevFlags(command: string, flags: string): string | null {
  if (PM_DEV_CMD_RE.test(command)) return `${command} -- ${flags}`
  if (FRAMEWORK_DEV_CMD_RE.test(command)) return `${command} ${flags}`
  return null
}
