/**
 * "Does this project have real content worth analyzing?" filter.
 *
 * Gates the `/init` button in ChatView on project open. Suggesting /init on a freshly-created empty folder is
 * noise — TMS.md gets bootstrapped organically as the agent works.
 *
 * Pure function so the rules are testable without Tauri / store mocks.
 *
 * The Rust `glob_files('*')` returns hidden entries by default — `glob`
 * crate v0.3 has `require_literal_leading_dot: false` in its `Default`
 * impl, so `*` matches `.foo`. That surprised the original implementation,
 * which only excluded four named dotfiles. On an "empty" project that
 * has just the IDE's `.toquemedia/` state directory, the filter saw
 * `.toquemedia` as "real content" and the suggestion fired anyway.
 *
 * The right gate isn't "filename != X for X in {list}" — it's "is there
 * anything that isn't (a) hidden / tool metadata, or (b) auto-generated
 * dependency / build output?" Dot-files alone shouldn't trip the gate;
 * `node_modules`/`dist`/`build` alone shouldn't either.
 */

/**
 * Tool-generated artifact directories that don't represent project intent.
 * Listed by exact name because they're created by package managers /
 * bundlers, not authored by the developer.
 */
const ARTIFACT_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'target',  // Rust / Java
  'venv', '.venv',  // Python
  '__pycache__',
])

/**
 * True iff the entry name represents real project content the developer
 * authored. False for hidden dot-files (IDE/git/OS metadata, dot-config)
 * and for tool-generated artifact directories.
 */
export function isMeaningfulEntry(name: string): boolean {
  if (!name) return false
  // Hidden dot-files: .git, .toquemedia, .toquemedia-id, .DS_Store,
  // .gitignore, .env, .vscode, etc. All either metadata or per-user
  // config — none alone justifies "this project has substance".
  if (name.startsWith('.')) return false
  if (ARTIFACT_NAMES.has(name)) return false
  return true
}

/**
 * True iff the project has at least one meaningful top-level entry.
 * Accepts the raw entries returned by `glob_files('*', directory)` —
 * absolute paths OR plain names; the basename is extracted internally.
 */
export function projectHasMeaningfulContent(entries: string[]): boolean {
  for (const entry of entries) {
    const name = entry.split('/').pop() ?? entry
    if (isMeaningfulEntry(name)) return true
  }
  return false
}
