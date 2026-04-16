import type { SlashCommand } from './slashCommandRegistry'
import { useChatStore, clearMessageQueue } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { sessionService } from './sessionService'
import type { SessionSummary } from '../../types/chat'
import { useProjectStore } from '../../stores/projectStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import { useCmdOverlayStore } from '../../stores/cmdOverlayStore'
import AgentService from './agentService'
import { logger } from '../../utils/logger'

/**
 * CMD-mode-only slash commands — not available in regular chat mode.
 * These are session management commands that only make sense in the
 * terminal/agentic context.
 */

// ─── Session list cache — populated by /resume (list), consumed by /resume <n> ───
// Module-level so the mapping survives across multiple /resume calls within a session.
let _lastListedSessions: SessionSummary[] = []

// ─── Helpers ───

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const diffMin = Math.floor(diffMs / 60_000)
  const diffH = Math.floor(diffMs / 3_600_000)
  const diffD = Math.floor(diffMs / 86_400_000)

  if (diffMin < 1) return 'agora'
  if (diffMin < 60) return `há ${diffMin}m`
  if (diffH < 24) return `há ${diffH}h`
  if (diffD === 1) return 'ontem'
  if (diffD < 7) return `há ${diffD}d`
  const d = new Date(ts)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

// ─── Shared: stop agent (DRY) ───

/**
 * Atomically stops the running agent, clears pending approvals,
 * resets agent status to idle, and finalizes the current assistant message. Idempotent.
 */
export async function stopAgent(): Promise<void> {
  usePermissionStore.getState().clearPending()
  usePermissionStore.getState().resetAutoApprove()
  AgentService.getInstance().cancelLoop()
  useChatStore.getState().finalizeAssistantMessage()
  useAgentStore.getState().setStatus('idle')
}

// ─── /new — Stop → Save → Clear queue → Create new session ───

async function executeNew(_args: string, projectPath: string): Promise<void> {
  const state = useChatStore.getState()

  // 1. Stop agent FIRST (before saving — avoids partial/corrupt save)
  if (state.isStreaming) {
    await stopAgent()
  }

  // 2. Save current session (only if it has content)
  const activeSession = state.getActiveSession()
  if (activeSession && activeSession.messages.length > 0) {
    await state.saveSessionToDisk()
  }

  // 3. Clear message queue — queued commands belong to the old session
  clearMessageQueue()

  // 4. Create a fresh session
  state.createSession(projectPath)
  state.addSystemMessage('Nova sessão criada. Contexto limpo.', 'success')
}

// ─── /clear — Stop agent → Clear messages (keeps session, resets tokens/turns) ───

async function executeClear(_args: string, _projectPath: string): Promise<void> {
  const state = useChatStore.getState()
  const activeSession = state.getActiveSession()
  if (!activeSession) return

  // Stop agent before clearing — otherwise it continues on empty context
  if (state.isStreaming) {
    await stopAgent()
  }

  // Clear messages but keep the session alive; also resets tokens and turn count
  state.clearSessionMessages(activeSession.id)
  state.addSystemMessage('Contexto limpo. Sessão mantida. Tokens resetados.', 'success')
}

// ─── /save <name> — Persist name on session object ───

async function executeSave(args: string, _projectPath: string): Promise<void> {
  const name = args.trim()
  if (!name) {
    useChatStore.getState().addSystemMessage('Uso: /save <nome_da_sessao>', 'info')
    return
  }

  const state = useChatStore.getState()
  const activeSession = state.getActiveSession()
  if (!activeSession) {
    useChatStore.getState().addSystemMessage('Nenhuma sessão ativa para salvar.', 'warn')
    return
  }

  // Persist name on the session object (stored in memory)
  state.renameSession(name)

  // Save to disk so the name survives app restart
  try {
    await state.saveSessionToDisk()
  } catch (err) {
    // If save fails, the name is still in memory and will be saved on next
    // auto-save (every 30s). Report but don't block the operation.
    logger.error('cmd', 'Failed to persist session name:', err)
  }

  state.addSystemMessage(`Sessão renomeada para "${name}".`, 'success')
}

// ─── /resume — Open the keyboard-driven session picker overlay ───
//
// The previous version of this command dumped the list as a system message,
// which forced the user to type `/resume <n>` afterwards. The picker owns
// Escape while open (see CmdModeView) so it can be cancelled without
// exiting CMD Mode.

async function executeResume(_args: string, projectPath: string): Promise<void> {
  const summaries = await sessionService.listSessions(projectPath)

  if (summaries.length === 0) {
    useChatStore.getState().addSystemMessage('Nenhuma sessão guardada para este projeto.', 'info')
    return
  }

  // Sort by most recently updated first; cache so `/resume <n>` still works
  // for muscle-memory users (and for screen readers that prefer text lists).
  const sorted = [...summaries].sort((a, b) => b.updatedAt - a.updatedAt)
  _lastListedSessions = sorted

  const activeId = useChatStore.getState().activeSessionId
  useCmdOverlayStore.getState().openSessionPicker(sorted, activeId)
}

// Retained for reference but no longer wired — formatRelativeTime now lives
// solely in the picker component. Keep the symbol exported-like for backward
// binary compatibility with any test that imports it.
void formatRelativeTime

/**
 * Load a session by its full ID. Exposed for the picker overlay which
 * already has the SessionSummary in hand and doesn't need the numeric
 * lookup path. Mirrors executeResumeTarget's in-memory/on-disk handling.
 */
export async function loadSessionById(sessionId: string, projectPath: string): Promise<void> {
  const state = useChatStore.getState()
  if (state.sessions.has(sessionId)) {
    if (state.isStreaming) await stopAgent()
    clearMessageQueue()
    usePermissionStore.getState().resetAutoApprove()
    state.setActiveSession(sessionId)
    const session = state.sessions.get(sessionId)
    const name = session?.name || `#${sessionId.slice(0, 6)}`
    useCheckpointStore.getState().clear()
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success')
    return
  }
  try {
    await state.switchSession(projectPath, sessionId)
    const loadedSession = state.getActiveSession()
    const name = loadedSession?.name || `#${sessionId.slice(0, 6)}`
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('cmd', `Failed to resume session ${sessionId}:`, err)
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      state.addSystemMessage(`Sessão não encontrada. Use /resume para ver a lista.`, 'error')
    } else {
      state.addSystemMessage(`Erro ao carregar sessão: ${msg}`, 'error')
    }
  }
}

// ─── /resume <n|id> — Load specific session (by number or ID prefix) ───

async function executeResumeTarget(target: string, projectPath: string): Promise<void> {
  // Resolve number → session ID using the last-listed cache
  const n = parseInt(target, 10)
  let resolvedId = target

  if (!isNaN(n) && n >= 1) {
    if (_lastListedSessions.length === 0) {
      // Cache is empty — list first, then resolve
      await executeResume('', projectPath)
    }
    const entry = _lastListedSessions[n - 1]
    if (!entry) {
      useChatStore.getState().addSystemMessage(
        `Sessão #${n} não existe. Use /resume para ver a lista.`,
        'error'
      )
      return
    }
    resolvedId = entry.id
  }

  const state = useChatStore.getState()

  // Check memory first
  if (state.sessions.has(resolvedId)) {
    if (state.isStreaming) await stopAgent()
    clearMessageQueue()
    usePermissionStore.getState().resetAutoApprove()
    state.setActiveSession(resolvedId)
    const session = state.sessions.get(resolvedId)
    const name = session?.name || `#${n || resolvedId.slice(0, 6)}`
    useCheckpointStore.getState().clear()
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success')
    return
  }

  // Load from disk
  try {
    await state.switchSession(projectPath, resolvedId)
    const loadedSession = state.getActiveSession()
    const name = loadedSession?.name || `#${n || resolvedId.slice(0, 6)}`
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('cmd', `Failed to resume session ${resolvedId}:`, err)
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      state.addSystemMessage(`Sessão não encontrada. Use /resume para ver a lista.`, 'error')
    } else {
      state.addSystemMessage(`Erro ao carregar sessão: ${msg}`, 'error')
    }
  }
}

// ─── /exit — Save → Stop → Brief feedback → Return to WelcomeScreen ───

async function executeExit(_args: string, _projectPath: string): Promise<void> {
  const state = useChatStore.getState()

  if (state.isStreaming) {
    await stopAgent()
  }

  const activeSession = state.getActiveSession()
  if (activeSession && activeSession.messages.length > 0) {
    await state.saveSessionToDisk()
    state.addSystemMessage('Sessão guardada.', 'success')
    // Brief pause so the user sees the confirmation before the view closes
    await new Promise(resolve => setTimeout(resolve, 380))
  }

  useProjectStore.getState().setCmdModeProjectPath(null)
}

// ─── Registry ───

export const CMD_MODE_COMMANDS: SlashCommand[] = [
  {
    name: '/new',
    description: 'Nova sessão — guarda a atual e limpa contexto',
    enabled: true,
    execute: executeNew,
  },
  {
    name: '/clear',
    description: 'Limpar contexto — mantém sessão, reseta tokens',
    enabled: true,
    execute: executeClear,
  },
  {
    name: '/save',
    description: 'Dar nome à sessão: /save <nome>',
    enabled: true,
    execute: executeSave,
  },
  {
    name: '/resume',
    description: 'Listar sessões — /resume <n> para carregar',
    enabled: true,
    execute: async (args: string, projectPath: string) => {
      const trimmed = args.trim()
      if (trimmed) {
        await executeResumeTarget(trimmed, projectPath)
      } else {
        await executeResume('', projectPath)
      }
    },
  },
  {
    name: '/exit',
    description: 'Guardar e fechar',
    enabled: true,
    execute: executeExit,
  },
]
