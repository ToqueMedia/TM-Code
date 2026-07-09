import { invoke } from '@/utils/invokeMetrics'
import { t } from '../../../i18n'
import { useChatStore } from '../../../stores/chatStore'
import { runAgentWithCallbacks } from '../agentRunner'
import SkillService from '../skillService'
import { logger } from '../../../utils/logger'

/**
 * Hashtag-triggered skill flows (currently `#design`).
 *
 * The hashtag detector (see `hashtagRegistry.ts`) inspects the user's prompt
 * at submit time, strips the recognised tags, and routes here. The flow
 * pre-loads the authoritative skill content and injects it into the agent's
 * prompt as inline skill blocks — no round-trip to read_skill mid-turn.
 *
 * Wired in both prompt inputs (`usePromptBar.ts` and `useCmdPromptLogic.ts`)
 * through the handleSend / executePrompt branches.
 *
 * NOTE (2026-07): the managed GIP auth scaffolding flow (`runAuthFlow`,
 * `#auth-email-password` / `#auth-google`, provision_auth) was removed with
 * the MANAGED-PLATFORM layer — that product surface lives in TM Code Web.
 */

interface SkillEntry {
  name: string
  path: string
}

interface SkillContent {
  content: string
  references: string[]
}

async function fetchBundledSkill(name: string): Promise<string | null> {
  try {
    const entries = await invoke<SkillEntry[]>('list_skills_bundled')
    const entry = entries.find((e) => e.name === name)
    if (!entry) {
      logger.warn('auth', `Bundled skill not found: ${name}`)
      return null
    }
    const result = await invoke<SkillContent>('read_skill_content', { skillPath: entry.path })
    return result.content
  } catch (err) {
    logger.error('auth', `Failed to load skill ${name}:`, err)
    return null
  }
}

/**
 * Lightweight flow for `#design` alone (no auth). Force-loads the
 * frontend-design skill and injects its body inline so the agent commits
 * to a deliberate aesthetic before generating UI. Mirrors claude-vaz's
 * pattern of opt-in plugin install — explicit user signal, full skill
 * body in context, no decision needed by the model on whether to read it.
 */
export async function runDesignFlow(
  instructions: string,
  userMessageText: string,
  cmdOnlyMode: boolean = false,
): Promise<void> {
  const chatStore = useChatStore.getState()
  const designSkill = await fetchBundledSkill('frontend-design')

  if (!designSkill) {
    chatStore.addSystemMessage(
      t('auth.designSkillMissing')
    )
    // Still run the agent with the cleaned text — user's request shouldn't be lost.
    await runAgentWithCallbacks(instructions || userMessageText, {
      addUserMessage: true,
      userMessageText,
      useConversationHistory: true,
      cmdOnlyMode,
    })
    return
  }

  SkillService.getInstance().forceLoadSkill('frontend-design')

  // Envelope copy is the load-bearing part of this flow. Earlier wording
  // ("Apply the recipe to ALL UI you build in this turn") sent the model
  // into greenfield mode even when the project was already built — which
  // is the common shape for `#design` ("make the existing app look
  // better"). The model would `write_file` whole components and drop
  // handlers / API calls / hook deps along the way (see PLAN-DATA-VIEWER's
  // sibling discussion; user-reported regression in login + backend after
  // running `#design` on a working app). The reframed envelope below
  // splits the directive into two beats:
  //   1. Greenfield → apply the recipe in full, as before.
  //   2. Refactor (file already exists) → apply only to presentation
  //      surfaces; every handler, API call, hook dep, auth-contract step
  //      survives verbatim; backend files out of scope unless named.
  // It is still a prompt-level mitigation — the model decides whether to
  // honour it. The rollback-banner path is the real defense (see
  // recommendation in this turn's analysis); this is the cheap
  // intervention while that bigger change is queued.
  const prompt = [
    `<design_skill name="frontend-design">`,
    designSkill,
    `</design_skill>`,
    ``,
    `The developer dropped \`#design\` in the prompt. The aesthetic direction in the recipe above is the goal — distinctive typography (avoid Inter / system defaults), cohesive color palette with intentional accents, asymmetric layout where it serves the design, one orchestrated motion moment over many scattered ones. Commit to ONE direction; refined minimalism and maximalist chaos both work, the timid middle does not. The result should be visually striking AND production-grade — not generic AI chrome.`,
    ``,
    `Decide first which mode you are in for each file you touch:`,
    ``,
    `- **Greenfield** — the target file does not exist yet. Apply the recipe in full: new tokens, new typography, new layout. Free hand.`,
    `- **Refactor** — the target file already exists. The design pass applies to **presentation surfaces only**: JSX/template structure, theme tokens, className / style props, typography choices, layout primitives, motion. **Preserve verbatim**: every event handler, every \`useEffect\`/\`useMemo\`/\`useCallback\` dependency, every API call, every router target, every state-management call (\`setAuthToken\`, \`authFetch\`, \`setUser\`, \`onSuccess\`, store actions, fetcher hooks), every imported helper that has side effects. If the file has \`useState\`, \`useEffect\`, \`fetch\`/\`axios\`, or any auth/data-layer import, **assume refactor**.`,
    ``,
    `When in doubt about a single line — keep it. The bar is "the prior behaviour survives the rewrite minus the visual swap"; removing anything that is not part of the visual layer is a regression, even when the new layout reads better without it. If you find yourself rewriting a handler "while you're there", stop and revert that part of the change before continuing.`,
    ``,
    `Out of scope for this turn unless the developer explicitly named them: backend files (\`server/\`, \`api/\`, \`*.route.ts\`, \`*.controller.ts\`), database schemas, migration files, build / lint / TS config. "Make the app look better" is a frontend presentation request — touching the backend is scope creep.`,
    ``,
    `Developer's request:`,
    `> ${instructions || userMessageText}`,
  ].join('\n')

  await runAgentWithCallbacks(prompt, {
    addUserMessage: true,
    userMessageText,
    useConversationHistory: true,
    cmdOnlyMode,
  })
}
