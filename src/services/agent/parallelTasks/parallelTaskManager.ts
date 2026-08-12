/**
 * Project-bound agent runs (F2/F3 multi-project MDI).
 *
 * Policy: `./policy.ts` + ARCHITECTURE.md "Current parallel model".
 * When `ONE_AGENT_PER_PROJECT` (F3): no intra-project fan-out; steer or wait.
 * This module still hosts the runner used when:
 *   - the main agent is busy on project A and the user works on project B
 *     (`addSessionAgentRun` / `addProjectRun`);
 *   - a session needs continuation while another project holds the main loop.
 */

// NOTA: nada de projectStore estático aqui — arrasta windowService → tauri
// (rebenta o jsdom dos testes). projectPath vem da sessão / argumento.
import { useParallelTaskStore, MAX_CONCURRENT_TASKS } from '../../../stores/parallelTaskStore'
import { useChatStore } from '../../../stores/chatStore'
import { useBillingStore } from '../../../stores/billingStore'
import { useByokStore } from '../../../stores/byokStore'
import { getQueryGuard } from '../queryGuard'
import { t } from '../../../i18n'
import { ONE_AGENT_PER_PROJECT } from './policy'
import type { PromptBlock, Attachment } from '../../../types/chat'
import { extractDisplayFromValue } from '../promptValueHelpers'

/** Derive a short card label from the task prompt (never a multi-line dump). */
function deriveDescription(prompt: string): string {
  const firstLine = prompt
    .trim()
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .replace(/^(please\s+|pls\s+|podes\s+|pode\s+|ajuda[- ]me\s+a\s+|help\s+me\s+(to\s+)?)/i, '')
    .trim()
  if (!firstLine) return 'Task'
  if (firstLine.length <= 52) return firstLine
  return firstLine.slice(0, 51).trimEnd() + '…'
}

export function normalizeProjectPath(path: string | null | undefined): string {
  if (!path) return ''
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Live parallel-store run for a project path (running or queued). */
export function findLiveParallelRunForProject(projectPath: string): string | null {
  const target = normalizeProjectPath(projectPath)
  if (!target) return null
  for (const r of useParallelTaskStore.getState().runs.values()) {
    if (
      normalizeProjectPath(r.projectPath) === target
      && (r.status === 'running' || r.status === 'queued')
    ) {
      return r.id
    }
  }
  return null
}

/**
 * True when the main agentService loop is streaming a session of this project.
 * (ToolExecutor project context is checked lazily to avoid pulling the full
 * executor graph into lightweight unit tests.)
 */
function isMainBusyOnProject(projectPath: string): boolean {
  const target = normalizeProjectPath(projectPath)
  if (!target) return false
  try {
    const chat = useChatStore.getState()
    const sid = chat.streamingSessionId
    if (sid) {
      const session = chat.sessions.get(sid)
      if (normalizeProjectPath(session?.projectPath) === target) {
        if (getQueryGuard().getSnapshot() || chat.isStreaming) return true
      }
    }
  } catch { /* tests / early boot */ }
  try {
    // Lazy: toolExecutor → heavy deps; only when chat pin is ambiguous.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ToolExecutor = require('../toolExecutor').default as {
      getInstance: () => { getProjectContext: () => { projectPath: string } | null }
    }
    const ctx = ToolExecutor.getInstance().getProjectContext()
    if (normalizeProjectPath(ctx?.projectPath) !== target) return false
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AgentService = require('../agentService').default as {
      getInstance: () => { isAgentRunning: () => boolean }
    }
    return AgentService.getInstance().isAgentRunning()
  } catch {
    return false
  }
}

/** F3: any live agent (main or parallel) for this project. */
export function isProjectAgentBusy(projectPath: string): boolean {
  if (!projectPath) return false
  if (findLiveParallelRunForProject(projectPath)) return true
  return isMainBusyOnProject(projectPath)
}

/**
 * @deprecated F3: intra-project concurrent tasks are removed. Always refuses.
 * Kept as a named export so stray call sites get a clear system message.
 */
export function addParallelTask(_prompt: string): string | null {
  if (!ONE_AGENT_PER_PROJECT) {
    // Fan-out path intentionally not re-wired while F3 is the product default.
    // Re-enable requires ARCHITECTURE Current model + worktree spawn + tests.
    return null
  }
  try {
    useChatStore.getState().addSystemMessage(t('parallel.oneAgentPerProject'), 'warn')
  } catch { /* no chat */ }
  return null
}

/**
 * Run de CONTINUAÇÃO — "o agente da sessão que estás a ver" enquanto o main
 * está ocupado noutro projecto (F2). No MESMO projecto, se já há agente vivo,
 * a mensagem vira STEER do run existente (F3: 1 agente/projecto).
 */
export type SessionAgentRunOpts = {
  /** Multimodal prompt blocks (text + attachments). When set, bubble + steer carry them. */
  blocks?: PromptBlock[]
}

function userBubbleFields(prompt: string, blocks?: PromptBlock[]): {
  content: string
  attachments?: Attachment[]
  promptBlocks?: PromptBlock[]
} {
  if (!blocks?.length) return { content: prompt }
  const display = extractDisplayFromValue(blocks)
  return {
    content: display.text || prompt,
    attachments: display.attachments.length > 0 ? display.attachments : undefined,
    promptBlocks: blocks,
  }
}

export function addSessionAgentRun(
  sessionId: string,
  prompt: string,
  opts?: SessionAgentRunOpts,
): string | null {
  const chat = useChatStore.getState()
  const session = chat.sessions.get(sessionId)
  if (!session) return null
  const projectPath = session.projectPath
  const bubble = userBubbleFields(prompt, opts?.blocks)
  const steerItem = { text: prompt, blocks: opts?.blocks }

  // F3: already a parallel run on this project → steer it.
  const liveId = findLiveParallelRunForProject(projectPath)
  if (liveId) {
    chat.appendMessageToSession(sessionId, { role: 'user', ...bubble })
    chat.persistSessionNow(sessionId)
    useParallelTaskStore.getState().enqueueSteer(liveId, steerItem)
    return liveId
  }

  // F3: main already working on this project → do not spawn a second agent.
  // Caller should have used the message queue; surface a clear note.
  if (isMainBusyOnProject(projectPath)) {
    try {
      chat.addSystemMessage(t('parallel.oneAgentPerProjectSteer'), 'info')
    } catch { /* */ }
    // Still write the user bubble on the viewed session so nothing is lost;
    // the user can switch to the streaming session to see the live run.
    chat.appendMessageToSession(sessionId, { role: 'user', ...bubble })
    chat.persistSessionNow(sessionId)
    return null
  }

  const byokExempt = useByokStore.getState().enabled && !!session.byokSnapshot
  const billing = useBillingStore.getState()
  if (!byokExempt && (billing.noCredits || billing.status === 'rejected')) {
    try { chat.addSystemMessage(t('parallel.blockedNoBudget'), 'warn') } catch { /* sem chat */ }
    return null
  }
  chat.appendMessageToSession(sessionId, { role: 'user', ...bubble })
  chat.persistSessionNow(sessionId)
  // initialBlocks: first model turn rebuilds multimodal content (runner
  // pops last user from history and would otherwise send plain text only).
  const id = useParallelTaskStore
    .getState()
    .createQueued(prompt, deriveDescription(prompt), sessionId, projectPath, {
      continuation: true,
      initialBlocks: opts?.blocks,
    })
  pumpParallelTasks()
  return id
}

/**
 * F2 — launch an agent bound to a SPECIFIC project, minting a background chat
 * session when the focused session isn't that project's. This is the deliberate
 * entry point for starting a run on a NON-focused project (e.g. a "run this
 * project" action in the project switcher). The live composer path uses
 * `addSessionAgentRun` for the FOCUSED session; both are kept on purpose — they
 * share the steer/refuse/billing/createQueued logic but differ in whether a
 * session must already exist.
 * F3 — refuses if that project already has a live agent (steers it instead).
 */
export function addProjectRun(
  project: { id: string; path: string },
  prompt: string,
  opts?: { sessionId?: string },
): string | null {
  const chat = useChatStore.getState()

  const liveId = findLiveParallelRunForProject(project.path)
  if (liveId) {
    const run = useParallelTaskStore.getState().runs.get(liveId)
    const sid = opts?.sessionId ?? run?.sessionId
    if (sid) {
      chat.appendMessageToSession(sid, { role: 'user', content: prompt })
      chat.persistSessionNow(sid)
    }
    useParallelTaskStore.getState().enqueueSteer(liveId, prompt)
    return liveId
  }
  if (isMainBusyOnProject(project.path)) {
    try {
      chat.addSystemMessage(t('parallel.oneAgentPerProjectSteer'), 'info')
    } catch { /* */ }
    return null
  }

  const byokExempt =
    useByokStore.getState().enabled && !!chat.getActiveSession()?.byokSnapshot
  const billing = useBillingStore.getState()
  if (!byokExempt && (billing.noCredits || billing.status === 'rejected')) {
    try { chat.addSystemMessage(t('parallel.blockedNoBudget'), 'warn') } catch { /* sem chat */ }
    return null
  }

  let sessionId = opts?.sessionId
  if (sessionId) {
    const session = chat.sessions.get(sessionId)
    if (!session || session.projectPath !== project.path) return null
  } else {
    const active = chat.getActiveSession()
    if (active && active.projectPath === project.path) {
      sessionId = active.id
    } else {
      sessionId = chat.createBackgroundSession(project.path, deriveDescription(prompt))
    }
  }

  chat.appendMessageToSession(sessionId, { role: 'user', content: prompt })
  chat.persistSessionNow(sessionId)
  const id = useParallelTaskStore.getState().createQueued(
    prompt,
    deriveDescription(prompt),
    sessionId,
    project.path,
    { continuation: true },
  )
  pumpParallelTasks()
  return id
}

let pumping = false

/**
 * Promote queued project-runs to running. F3: never start two agents for the
 * same projectPath — skip (leave queued) until the live one finishes.
 */
export function pumpParallelTasks(): void {
  if (pumping) return
  pumping = true
  try {
    const store = useParallelTaskStore.getState()
    // Collect project paths already running.
    const busyProjects = new Set<string>()
    for (const r of store.runs.values()) {
      if (r.status === 'running' && r.projectPath) busyProjects.add(r.projectPath)
    }

    while (store.runningCount() < MAX_CONCURRENT_TASKS) {
      // Find next queued whose project is free (or has no path).
      let nextId: string | null = null
      for (const r of store.runs.values()) {
        if (r.status !== 'queued') continue
        if (r.projectPath && busyProjects.has(r.projectPath)) continue
        if (r.projectPath && isMainBusyOnProject(r.projectPath)) continue
        // FIFO among eligible: pick oldest createdAt
        if (!nextId) {
          nextId = r.id
          continue
        }
        const cur = store.runs.get(nextId)!
        if (r.createdAt < cur.createdAt) nextId = r.id
      }
      if (!nextId) break
      const run = store.runs.get(nextId)
      store.markRunning(nextId)
      if (run?.projectPath) busyProjects.add(run.projectPath)
      const id = nextId
      void import('./parallelTaskRunner')
        .then(({ runParallelTask }) => runParallelTask(id))
        .catch((err) => {
          useParallelTaskStore.getState().error(id, err instanceof Error ? err.message : String(err))
          pumpParallelTasks()
        })
    }
  } finally {
    pumping = false
  }
}

/** Stop every parallel task (queued + running). Used by the global Stop-all. */
export function stopAllParallelTasks(): void {
  useParallelTaskStore.getState().abortAll()
}
