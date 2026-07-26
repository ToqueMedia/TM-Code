/**
 * `/plan` on a live task/session-agent run (parallel residual).
 *
 * Under F3 (one agent per project) slash commands used to hard-block on a
 * running task chat because they drive MAIN machinery. For `/plan` specifically
 * we rewire the LIVE run:
 *   1. enable ToolExecutor plan-mode with a refcounted owner lease
 *   2. swap the engine system prompt to the architect role (getSystemPrompt)
 *   3. set X-Request-Type: plan (parity with executePlan)
 *   4. auto-approve diffs only for the architect window; restore on settle
 *   5. steer the architect user message into the next turn boundary
 *   6. on run settle, surface the plan approval card on the TASK session only
 *
 * Other slash commands stay blocked (honest message).
 */

import { useParallelTaskStore } from '../../../stores/parallelTaskStore'
import { useChatStore } from '../../../stores/chatStore'
import { usePermissionStore } from '../../../stores/permissionStore'
import AgentService from '../agentService'
import { preprocessHashtags } from '../hashtagRegistry'
import { detectAiAgentIntent } from '../aiAgentIntent'
import {
  buildArchitectSystemPrompt,
  buildArchitectUserMessage,
  resolvePlanArtifact,
  readPlanReadiness,
} from '../commands/planCommand'
import { t } from '../../../i18n'
import type { ParallelTaskPlanOverride } from '../../../stores/parallelTaskStore'

export type PlanOnLiveResult = 'steered' | 'none' | 'usage'

/**
 * If the active session is a live parallel/session-agent run, convert `/plan`
 * into a mid-run architect switch. Returns:
 *  - `'steered'` — live run rewired
 *  - `'usage'` — empty args; caller should stop (message already shown)
 *  - `'none'` — fall through to normal `executePlan`
 */
export async function tryPlanOnLiveRun(
  args: string,
  projectPath: string,
  activeSessionId: string | null | undefined,
): Promise<PlanOnLiveResult> {
  if (!activeSessionId || !projectPath) return 'none'

  const store = useParallelTaskStore.getState()
  let liveRunId: string | null = null
  for (const r of store.runs.values()) {
    if (
      r.sessionId === activeSessionId
      && (r.status === 'running' || r.status === 'queued')
    ) {
      liveRunId = r.id
      break
    }
  }
  if (!liveRunId) return 'none'

  if (!args.trim()) {
    useChatStore.getState().addSystemMessage(t('plan.usage'))
    return 'usage'
  }

  const planArtifact = await resolvePlanArtifact(projectPath, args)
  const hashtagSignals = preprocessHashtags(args)
  const aiAgentSignal = detectAiAgentIntent(args)
  const systemPrompt = buildArchitectSystemPrompt(planArtifact.fileName)
  const userMessage = buildArchitectUserMessage(
    args,
    projectPath,
    hashtagSignals,
    aiAgentSignal,
    planArtifact,
  )

  const planModeOwnerId = `live-plan:${liveRunId}:${Date.now()}`
  const permStore = usePermissionStore.getState()
  const prevAutoApproveDiffs = permStore.autoApproveDiffs
  const agentService = AgentService.getInstance()
  const prevRequestType = agentService.getRequestType()
  const setRequestTypePlan = prevRequestType !== 'plan'

  const override: ParallelTaskPlanOverride = {
    systemPrompt,
    planFileName: planArtifact.fileName,
    planPath: planArtifact.path,
    originalArgs: args,
    enabledAt: Date.now(),
    planModeOwnerId,
    prevAutoApproveDiffs,
    setRequestTypePlan,
  }

  // Plan-mode is applied on the TASK's isolated ToolExecutor by the runner
  // (syncLivePlanToChild) — not the process singleton. AgentService.requestType
  // still helps any concurrent main path / diagnostics; the task engine sends
  // X-Request-Type via getExtraHeaders when planOverride is set.
  if (setRequestTypePlan) {
    agentService.setRequestType('plan')
  }

  // Auto-approve diffs while architecting (same as executePlan) — MUST restore.
  permStore.setAutoApproveDiffs(true)

  useChatStore.getState().setPlanResumePending({
    projectPath,
    originalArgs: args,
    planPath: planArtifact.path,
    planFileName: planArtifact.fileName,
    updatedAt: Date.now(),
  })

  // Bubble in the task chat + steer payload for the next turn boundary.
  useChatStore.getState().appendMessageToSession(activeSessionId, {
    role: 'user',
    content: `/plan ${args}`,
  })
  store.setPlanOverride(liveRunId, override)
  store.enqueueSteer(liveRunId, {
    text: userMessage,
  })

  useChatStore.getState().appendMessageToSession(activeSessionId, {
    role: 'system',
    level: 'info',
    content: t('parallel.planOnLiveSteered').replace('{file}', planArtifact.fileName),
  })

  return 'steered'
}

/**
 * Called from the parallel task runner `finally` when a plan override was
 * active — restore process state and surface the approval card on the task
 * session only (never a foreign project's active chat).
 */
export async function settlePlanOverrideOnRunEnd(
  planOverride: ParallelTaskPlanOverride,
  projectPath: string,
  sessionId: string | undefined,
): Promise<void> {
  // 1) Restore auto-approve (P0 — was sticky true before this fix).
  try {
    usePermissionStore.getState().setAutoApproveDiffs(planOverride.prevAutoApproveDiffs)
  } catch { /* */ }

  // 2) Clear requestType only if we set it (don't clobber a concurrent main /plan).
  if (planOverride.setRequestTypePlan) {
    try {
      const agent = AgentService.getInstance()
      if (agent.getRequestType() === 'plan') {
        agent.setRequestType(null)
      }
    } catch { /* */ }
  }

  // Plan-mode lease lives on the task's isolated ToolExecutor — released in
  // the runner finally via toolExecutor.disablePlanMode(ownerId) before dispose.

  const chat = useChatStore.getState()
  const readiness = await readPlanReadiness(planOverride.planPath)

  if (readiness.ready) {
    chat.setPlanResumePending(null)
    // Card ONLY on the task session (or active if it is the same project).
    if (sessionId) {
      chat.addCardMessage(
        'plan_approval',
        projectPath,
        {
          planPath: planOverride.planPath,
          planFileName: planOverride.planFileName,
        },
        sessionId,
      )
      // If user is viewing another session, leave a breadcrumb on the task chat
      // (card is already there) and a short note if they're looking at the task.
      if (chat.activeSessionId === sessionId) {
        // card visible — done
      } else {
        chat.appendMessageToSession(sessionId, {
          role: 'system',
          level: 'info',
          content: t('parallel.planReadyOnTask').replace('{file}', planOverride.planFileName),
        })
      }
    } else {
      // No session pin — only write card if active session is same project.
      const active = chat.activeSessionId
        ? chat.sessions.get(chat.activeSessionId)
        : null
      const activePath = active?.projectPath?.replace(/\\/g, '/').replace(/\/+$/, '')
      const targetPath = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
      if (active && activePath === targetPath) {
        chat.addCardMessage('plan_approval', projectPath, {
          planPath: planOverride.planPath,
          planFileName: planOverride.planFileName,
        })
      } else {
        chat.addSystemMessage(
          t('parallel.planReadyOnTask').replace('{file}', planOverride.planFileName),
          'info',
        )
      }
    }
    return
  }

  const message =
    readiness.reason === 'missing'
      ? t('plan.notFinished')
      : readiness.reason === 'draft'
        ? t('plan.cutOff')
        : t('plan.notComplete')
  if (sessionId) {
    chat.appendMessageToSession(sessionId, {
      role: 'system',
      level: 'warn',
      content: message,
    })
  } else {
    chat.addSystemMessage(message, 'warn')
  }
}
