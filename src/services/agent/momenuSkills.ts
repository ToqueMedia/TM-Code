// momenuSkills.ts — remote MoMenu (Factura) payment skills.
//
// These payment-integration skills are NOT bundled in the app and NOT on disk:
// they live in a public GitHub repo so they can be updated without shipping a
// new IDE build. Two callers share this single source of truth:
//   - the `/payments` slash command (commands/paymentsCommand.ts) — fetches ALL
//     skills and injects them up-front as <payment_skills> context.
//   - the `read_skill` tool's remote fallback (toolExecutor/taskOps.ts) — fetches
//     ONE skill on demand when the agent follows the scaffolding-aware hint
//     ("payments.* → read_skill('mom-factura-payments')", chatSections.ts) after
//     payments are already integrated in the project.
//
// Always fetched FRESH from `main` (no app-side cache) so the latest skill
// revision is picked up automatically — bounded only by GitHub's raw CDN
// (~5 min). Uses the browser `fetch` (raw.githubusercontent.com sends a
// permissive `access-control-allow-origin: *`), the same transport `/payments`
// always used — distinct from tauriFetch/the workers.

export const MOMENU_SKILLS_BASE =
  'https://raw.githubusercontent.com/ithustle/momenu-skills/main/skills'

/**
 * Catalog of remote skills → the files that make up each one (SKILL.md first,
 * the rest treated as references). This is the authoritative list both callers
 * read from; add a skill here and it becomes available to `/payments` AND the
 * `read_skill` fallback at once.
 */
export const MOMENU_SKILL_FILES: ReadonlyArray<{ name: string; files: readonly string[] }> = [
  { name: 'mom-factura-payments', files: ['SKILL.md', 'references/STATUS-POLLING.md'] },
  { name: 'mom-factura-webhooks', files: ['SKILL.md'] },
  { name: 'mom-factura-testing', files: ['SKILL.md'] },
]

/** True when `name` is a known remote MoMenu skill — gates the read_skill fallback. */
export function isMomenuSkill(name: string): boolean {
  return MOMENU_SKILL_FILES.some(s => s.name === name)
}

/** Fetch a single file fresh from the repo. Returns null on 404 / network error. */
async function fetchFile(skillName: string, file: string): Promise<string | null> {
  try {
    const res = await fetch(`${MOMENU_SKILLS_BASE}/${skillName}/${file}`)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

/**
 * Fetch ONE skill (SKILL.md + its reference files) shaped for the read_skill
 * tool — the result matches `SkillService.getCachedSkillContent` so the same
 * `formatSkillForReading` formatter renders it identically to a local skill.
 *
 * Returns null when the skill is unknown or its SKILL.md can't be fetched
 * (offline / moved / 404). Reference files that fail individually are omitted
 * rather than failing the whole read.
 */
export async function fetchMomenuSkill(
  name: string,
): Promise<{ name: string; content: string; references: string[] } | null> {
  const entry = MOMENU_SKILL_FILES.find(s => s.name === name)
  if (!entry) return null

  const [mainFile, ...refFiles] = entry.files
  const content = await fetchFile(name, mainFile)
  if (content == null) return null

  const references: string[] = []
  for (const file of refFiles) {
    const text = await fetchFile(name, file)
    if (text != null) references.push(`${file}\n${text}`)
  }
  return { name, content, references }
}

/**
 * Fetch ALL MoMenu skills concatenated as <skill> blocks — used by `/payments`
 * to inject the full payment reference up-front. Returns '' when nothing could
 * be fetched (caller surfaces a "load failed" / "none found" message).
 */
export async function fetchAllMomenuSkills(): Promise<string> {
  const fetches = MOMENU_SKILL_FILES.flatMap(skill =>
    skill.files.map(async file => {
      const content = await fetchFile(skill.name, file)
      if (content == null) return null
      const label = file === 'SKILL.md' ? skill.name : `${skill.name}/${file}`
      return `<skill name="${label}">\n${content}\n</skill>`
    }),
  )
  const parts = (await Promise.all(fetches)).filter((p): p is string => p != null)
  return parts.join('\n\n')
}
