import type { SlashCommand } from './slashCommandRegistry'
import { invoke } from '@/utils/invokeMetrics'
import { useChatStore, clearMessageQueue } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import { useMcpStore } from '../../stores/mcpStore'
import { sessionService } from './sessionService'
import type { SessionSummary } from '../../types/chat'
import { useProjectStore } from '../../stores/projectStore'
import { usePermissionStore } from '../../stores/permissionStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import { useCmdOverlayStore } from '../../stores/cmdOverlayStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import AgentService from './agentService'
import MCPService from '../mcp/mcpService'
import { devServerManager } from '../devServerManager'
import { MCP_REGISTRY, findRegistryEntry, buildConfigEntry, type McpRegistryEntry } from '../../utils/mcpRegistry'
import { clearPromptHistory } from '../cmdPromptHistory'
import { t } from '../../i18n/useTranslation'
import type { TranslationKey } from '../../i18n/translations'
import { logger } from '../../utils/logger'

/** Lightweight {placeholder} interpolation for translated strings with named slots. */
function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`))
}

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
  state.addSystemMessage('Nova sessão criada. Contexto limpo.', 'success', { ephemeral: true })
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
  state.addSystemMessage('Contexto limpo. Sessão mantida. Tokens resetados.', 'success', { ephemeral: true })
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

  state.addSystemMessage(`Sessão renomeada para "${name}".`, 'success', { ephemeral: true })
}

// ─── /resume — Open the keyboard-driven session picker overlay ───
//
// The previous version of this command dumped the list as a system message,
// which forced the user to type `/resume <n>` afterwards. The picker owns
// Escape while open (see TerminalView) so it can be cancelled without
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
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success', { ephemeral: true })
    return
  }
  try {
    await state.switchSession(projectPath, sessionId)
    const loadedSession = state.getActiveSession()
    const name = loadedSession?.name || `#${sessionId.slice(0, 6)}`
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success', { ephemeral: true })
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
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success', { ephemeral: true })
    return
  }

  // Load from disk
  try {
    await state.switchSession(projectPath, resolvedId)
    const loadedSession = state.getActiveSession()
    const name = loadedSession?.name || `#${n || resolvedId.slice(0, 6)}`
    state.addSystemMessage(`Sessão ${name} carregada.`, 'success', { ephemeral: true })
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

// ─── /mcp-install, /mcp-browse — unified registry-backed install flow ───
//
// Both commands funnel through `installRegistryEntry` so there is exactly one
// read-merge-write + addSingleServer implementation.

type MessageSlot = 'installing' | 'installed' | 'registered' | 'alreadyInstalled'

/** Resolve the i18n key for a slot, honoring per-entry overrides from the registry. */
function messageKey(entry: McpRegistryEntry, slot: MessageSlot): TranslationKey {
  const override = entry.messageKeys?.[slot]
  if (override) return override as TranslationKey
  const defaults: Record<MessageSlot, TranslationKey> = {
    installing: 'cmd.mcp.installing',
    installed: 'cmd.mcp.installed',
    registered: 'cmd.mcp.installedNoTools',
    alreadyInstalled: 'cmd.mcp.alreadyInstalled',
  }
  return defaults[slot]
}

/**
 * Read-merge-write a registry entry into ~/.toquemedia-studio/mcp.json and start it.
 * Single source of truth for MCP install — used by /mcp-install and /mcp-browse.
 */
async function installRegistryEntry(entry: McpRegistryEntry, projectPath: string): Promise<void> {
  const state = useChatStore.getState()

  const isAlreadyConnected = useMcpStore.getState().servers.some(
    s => s.name === entry.name && s.status === 'running',
  )
  if (isAlreadyConnected) {
    state.addSystemMessage(fmt(t(messageKey(entry, 'alreadyInstalled')), { label: entry.label }), 'info')
    return
  }

  let globalConfigPath: string
  try {
    const homeDir = await invoke<string>('get_home_directory')
    globalConfigPath = `${homeDir}/.toquemedia-studio/mcp.json`
  } catch (err) {
    logger.error('cmd', 'Failed to resolve home directory:', err)
    state.addSystemMessage(t('cmd.mcp.homeFailed'), 'error')
    return
  }

  // Read-merge-write so we don't stomp on other MCP entries the user has configured.
  let existing: { mcpServers?: Record<string, unknown> } = {}
  try {
    const raw = await invoke<string>('read_file', { path: globalConfigPath })
    existing = JSON.parse(raw)
  } catch {
    // Config doesn't exist yet — fresh write is fine
  }

  const updated = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers || {}),
      [entry.name]: buildConfigEntry(entry),
    },
  }

  try {
    const dir = globalConfigPath.slice(0, globalConfigPath.lastIndexOf('/'))
    await invoke('create_directories_all', { path: dir })
    await invoke('write_file', { path: globalConfigPath, content: JSON.stringify(updated, null, 2) })
  } catch (err) {
    logger.error('cmd', `Failed to write ${entry.name} MCP config:`, err)
    const msg = err instanceof Error ? err.message : String(err)
    state.addSystemMessage(fmt(t('cmd.mcp.writeFailed'), { msg }), 'error')
    return
  }

  state.addSystemMessage(fmt(t(messageKey(entry, 'installing')), { label: entry.label }), 'info')

  try {
    await MCPService.getInstance().addSingleServer(projectPath, entry.name)
  } catch (err) {
    logger.error('cmd', `Failed to start ${entry.name} MCP server:`, err)
    const msg = err instanceof Error ? err.message : String(err)
    state.addSystemMessage(fmt(t('cmd.mcp.installFailed'), { label: entry.label, msg }), 'error')
    return
  }

  const server = useMcpStore.getState().servers.find(s => s.name === entry.name)
  const note = entry.postInstallNote || ''
  if (server?.status === 'running') {
    state.addSystemMessage(
      fmt(t(messageKey(entry, 'installed')), { label: entry.label, n: server.tools.length, note }),
      'success',
    )
  } else if (server?.status === 'error') {
    state.addSystemMessage(
      fmt(t('cmd.mcp.installFailed'), { label: entry.label, msg: server.error || 'unknown error' }),
      'error',
    )
  } else {
    state.addSystemMessage(
      fmt(t(messageKey(entry, 'registered')), { label: entry.label, note }),
      'info',
    )
  }
}

async function executeMcpInstall(args: string, projectPath: string): Promise<void> {
  const state = useChatStore.getState()
  const name = args.trim().toLowerCase()
  if (!name) {
    state.addSystemMessage(t('cmd.mcp.usageInstall'), 'info')
    return
  }
  const entry = findRegistryEntry(name)
  if (!entry) {
    state.addSystemMessage(fmt(t('cmd.mcp.unknown'), { name }), 'error')
    return
  }
  await installRegistryEntry(entry, projectPath)
}

async function executeMcpBrowse(_args: string, _projectPath: string): Promise<void> {
  const state = useChatStore.getState()
  if (MCP_REGISTRY.length === 0) {
    state.addSystemMessage(t('cmd.mcp.browseEmpty'), 'info')
    return
  }
  const header = t('cmd.mcp.browseHeader')
  const lines = MCP_REGISTRY.map(e =>
    fmt(t('cmd.mcp.browseEntry'), {
      name: e.name,
      label: e.label,
      category: e.category,
      description: e.description,
    }),
  )
  state.addSystemMessage([header, '', ...lines].join('\n'), 'info')
}

// ─── /history-clear — Drop the persisted ArrowUp prompt history for this project ───
//
// The `/clear` command wipes the active chat session. This one wipes the
// *prompt input* history (what ArrowUp recalls). Separated intentionally —
// users often want to forget a typed command without losing the whole session.

async function executeHistoryClear(_args: string, projectPath: string): Promise<void> {
  const state = useChatStore.getState()
  try {
    await clearPromptHistory(projectPath)
    state.addSystemMessage(t('cmd.history.cleared'), 'success')
  } catch (err) {
    logger.error('cmd', 'Failed to clear prompt history:', err)
    const msg = err instanceof Error ? err.message : String(err)
    state.addSystemMessage(fmt(t('cmd.history.clearFailed'), { msg }), 'error')
  }
}

// ─── /start-server, /stop-server — Manual dev server control in Terminal mode ───
//
// Terminal mode has no preview, so dev servers don't auto-start the way they do
// in chat mode. These commands let the user explicitly fire / stop the project's
// dev script. Detection: lockfile picks the PM, package.json picks the script.

async function readPackageJsonScripts(projectPath: string): Promise<Record<string, string> | null> {
  try {
    const raw = await invoke<string>('read_file', { path: `${projectPath}/package.json` })
    const parsed = JSON.parse(raw)
    const scripts = parsed?.scripts
    return scripts && typeof scripts === 'object' ? scripts as Record<string, string> : null
  } catch {
    return null
  }
}

async function detectProjectPackageManager(projectPath: string): Promise<'yarn' | 'pnpm' | 'bun' | 'npm'> {
  const checks: Array<[string, 'yarn' | 'pnpm' | 'bun' | 'npm']> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ]
  for (const [file, pm] of checks) {
    try {
      await invoke<string>('read_file', { path: `${projectPath}/${file}` })
      return pm
    } catch {
      // file not present, try next
    }
  }
  return 'npm'
}

function buildDevCommand(pm: 'yarn' | 'pnpm' | 'bun' | 'npm', scriptName: string): string {
  // yarn 1.x and pnpm accept the bare script name; npm/bun require `run`.
  if (pm === 'yarn' || pm === 'pnpm') return `${pm} ${scriptName}`
  return `${pm} run ${scriptName}`
}

async function executeStartServer(_args: string, projectPath: string): Promise<void> {
  const state = useChatStore.getState()
  const existing = useLayoutStore.getState().devServer
  if (existing && existing.status !== 'stopped') {
    const url = existing.frontendUrl || existing.backendUrl || 'unknown URL'
    state.addSystemMessage(`Dev server já está a correr (PID ${existing.pid}) — ${url}`, 'info')
    return
  }

  const scripts = await readPackageJsonScripts(projectPath)
  if (!scripts) {
    state.addSystemMessage('Não encontrei package.json válido na raiz do projecto.', 'error')
    return
  }
  const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : null
  if (!scriptName) {
    state.addSystemMessage('package.json não tem script "dev" nem "start". Adiciona um e tenta de novo.', 'error')
    return
  }

  const pm = await detectProjectPackageManager(projectPath)
  const command = buildDevCommand(pm, scriptName)

  state.addSystemMessage(`A iniciar dev server: ${command}`, 'info')
  try {
    const { resolveFrontendPortHint } = await import('../templateService')
    const frontendPortHint = await resolveFrontendPortHint(projectPath, 'fullstack')
    await devServerManager.start(projectPath, command, { projectKind: 'fullstack', frontendPortHint })
    // Brief pause so URL detection has a chance to populate the slot.
    await new Promise(resolve => setTimeout(resolve, 600))
    const slot = useLayoutStore.getState().devServer
    if (slot && (slot.frontendUrl || slot.backendUrl)) {
      const urls = [slot.frontendUrl, slot.backendUrl].filter(Boolean).join(' · ')
      state.addSystemMessage(`Dev server activo (PID ${slot.pid}) — ${urls}`, 'success', { ephemeral: true })
    } else if (slot) {
      state.addSystemMessage(`Dev server lançado (PID ${slot.pid}). URL ainda a aparecer nos logs.`, 'info', { ephemeral: true })
    }
  } catch (err) {
    logger.error('cmd', 'Failed to start dev server:', err)
    const msg = err instanceof Error ? err.message : String(err)
    state.addSystemMessage(`Falhou ao iniciar dev server: ${msg}`, 'error')
  }
}

async function executeStopServer(_args: string, _projectPath: string): Promise<void> {
  const state = useChatStore.getState()
  const slot = useLayoutStore.getState().devServer
  if (!slot) {
    state.addSystemMessage('Nenhum dev server activo.', 'info')
    return
  }
  try {
    await devServerManager.stop()
    state.addSystemMessage('Dev server parado.', 'success', { ephemeral: true })
  } catch (err) {
    logger.error('cmd', 'Failed to stop dev server:', err)
    const msg = err instanceof Error ? err.message : String(err)
    state.addSystemMessage(`Falhou ao parar dev server: ${msg}`, 'error')
  }
}

// ─── /terminal — Toggle the side PTY panel (xterm.js + real shell) ───

async function executeTerminal(_args: string, _projectPath: string): Promise<void> {
  useTerminalPanelStore.getState().toggle()
}

// ─── /exit — Save → Stop → Close terminal panel → Return to WelcomeScreen ───

async function executeExit(_args: string, _projectPath: string): Promise<void> {
  const state = useChatStore.getState()

  if (state.isStreaming) {
    await stopAgent()
  }

  // Kill the PTY before leaving so we don't strand a shell process when the
  // user comes back to a different project.
  useTerminalPanelStore.getState().close()

  const activeSession = state.getActiveSession()
  if (activeSession && activeSession.messages.length > 0) {
    await state.saveSessionToDisk()
    state.addSystemMessage('Sessão guardada.', 'success', { ephemeral: true })
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
    argHint: '[nome da sessão]',
  },
  {
    name: '/resume',
    description: 'Listar sessões — /resume <n> para carregar',
    enabled: true,
    argHint: '[número ou ID da sessão]',
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
    name: '/mcp-install',
    description: 'Instalar integração MCP do registo (ex: /mcp-install gamma)',
    enabled: true,
    execute: executeMcpInstall,
    argHint: '[nome da integração MCP]',
  },
  {
    name: '/mcp-browse',
    description: 'Listar integrações MCP disponíveis',
    enabled: true,
    execute: executeMcpBrowse,
  },
  {
    name: '/history-clear',
    description: 'Limpar histórico de prompts (ArrowUp) deste projeto',
    enabled: true,
    execute: executeHistoryClear,
  },
  {
    name: '/start-server',
    description: 'Arrancar dev server do projecto (npm/yarn/pnpm/bun run dev)',
    enabled: true,
    execute: executeStartServer,
  },
  {
    name: '/stop-server',
    description: 'Parar dev server activo',
    enabled: true,
    execute: executeStopServer,
  },
  {
    name: '/terminal',
    description: 'Abrir/fechar painel de terminal real (PTY)',
    enabled: true,
    execute: executeTerminal,
  },
  {
    name: '/exit',
    description: 'Guardar e fechar',
    enabled: true,
    execute: executeExit,
  },
]
