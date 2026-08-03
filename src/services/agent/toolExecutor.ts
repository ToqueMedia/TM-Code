import { checkRepoOwnership, ensureGitInfoExclude } from '../repoOwnership'
import { invoke } from '@/utils/invokeMetrics'
import { listen } from '@tauri-apps/api/event'
import { t } from '@/i18n'
import { useFileTreeRepository } from '../../stores/fileTreeStore'
import { useEditorRepository } from '../../stores/editorStore'
import { useProjectStore } from '../../stores/projectStore'
import { getProjectGrants } from '../../stores/permissionStore'
import { findBlockingClaim, registerFileClaim, MAIN_CLAIM_OWNER } from './fileClaims'
import { useSettingsStore } from '../../stores/settingsStore'
import { useLayoutStore } from '../../stores/layoutStore'
import { useCheckpointStore } from '../../stores/checkpointStore'
import FirebaseAuthService from '../auth/firebaseAuth'
import { registerTaskTools } from './toolExecutor/taskOps'
import { registerMemoryTools } from './toolExecutor/memoryOps'
import { createPermissionAwareTimeout } from './toolExecutor/permissionAwareTimeout'
import { formatSearchResultsByFile, matchesAnyGlob } from './toolExecutor/searchFormatters'
import { registerInteractionTools } from './toolExecutor/interactionOps'
import type { ToolRegistrationContext } from './toolExecutor/context'
import {
  isEnvFile,
  commandReferencesSealedEnv,
  isSensitiveFile,
  simpleHash,
  matchDangerousCommand,
  matchStateMutatingCommand,
  WRITE_COMMAND_PATTERNS,
  DANGEROUS_COMMANDS,
  STATE_MUTATING_COMMANDS,
  normalizePath,
} from './toolExecutor/checks'
import { devServerManager } from '../devServerManager'
import { resolveAIWorkerUrl } from '../../utils/devUrls'
import { htmlToText, looksLikeHtml } from '../../utils/htmlToText'
import { stripAnsi } from '@/utils/stripAnsi'
import { jsonMini } from './jsonMini'

// Browser-like UA for web_fetch — many docs/CDN sites 403 a bot-looking UA.
const WEB_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
// Appended to fetch-failure messages so the model doesn't wrongly conclude a
// page is permanently unreachable after one transient/blocked fetch.
// Template literal, NÃO aspas simples: esta constante interpola nomes de tools.
// Em aspas simples o `${WEB_SEARCH_ALIAS}` chegava ao modelo como texto
// literal — apanhado em produção quando um fetch devolveu 404 e a mensagem
// mandava "try ${WEB_SEARCH_ALIAS}". Um nome de tool por interpolar é pior do
// que o nome errado: não corresponde a nada.
// FUNÇÃO, não const: esta constante vive ACIMA do bloco de imports e
// interpola um nome de tool. Como `const` era avaliada antes de o módulo dos
// nomes existir ("Cannot access 'toolNames_1' before initialization"). Adiada
// para a chamada, resolve no momento em que é precisa.
const webFetchFallbackHint = (): string =>
  `Do not conclude the page is inaccessible from this single failure. Retry once, try ${WEB_SEARCH_ALIAS} for a canonical/alternate URL, or (if shell access is available) fetch it with \`curl -L -A "Mozilla/5.0" <url>\` and extract the text locally before reporting it unavailable.`
import { formatError } from '../../utils/errors'
import { checkPlanModeAccess, isPlanArtefactAtRoot } from './planMode'
import {
  GLOB_ALIAS,
  BASH_ALIAS,
  GREP_ALIAS,
  LS_ALIAS,
  READ_AROUND,
  READ_ALIAS,
  WRITE_ALIAS,
  EDIT_ALIAS,
  TASK_ALIAS,
  WEB_FETCH_ALIAS,
  WEB_SEARCH_ALIAS,
  WRITE_FILE,
  EDIT_FILE,
  CREATE_FILE,
  DELETE_FILE,
  RENAME_FILE,
  CREATE_DIRECTORY,
  STOP_DEV_SERVER,
  LSP,
  CAPTURE_URL_DESIGN,
  ENTER_WORKTREE,
  EXIT_WORKTREE,
  canonicalToolName,
  advertisedToolName,
  routeTrainedToolCall,
  normalizeToolInputForCanonical,
  DIVERGENT_TRAINED_TOOLS,
  CHECK_BACKGROUND_COMMANDS,
} from './toolNames'
import { notifyHost, emitToolProgress } from './host/hostBus'
import { processRegistry } from './processRegistry'
import { getAgentHost } from './host/agentHost'
import { ENTER_WORKTREE_DESCRIPTION, EXIT_WORKTREE_DESCRIPTION } from './toolExecutor/worktrees'
import { createFileStateCacheWithSizeLimit, type FileContentSignature, type FileState, type FileStateCache } from './toolExecutor/fileStateCache'
import { recordReadRange, clearReadRangeTracker } from './toolExecutor/readRangeTracker'
import { clearMentionContextTracker } from './mentionContextTracker'
import { addLineNumbers } from './toolExecutor/lineNumbers'
import { hasBinaryExtension } from './toolExecutor/binaryExtensions'
import { getSnippetForTwoFileDiff } from './toolExecutor/changedFileSnippet'
import { extractReadFilesFromMessages } from './toolExecutor/readStateRecovery'
import { logger } from '../../utils/logger'
import { budgetMcpDescriptions } from './mcpDescriptionBudget'
import { getLegacyProjectStateDir, getProjectStateDir } from '../projectStatePaths'
// Os caminhos que o PROJECTO declara gerados. Partilhado com o system prompt
// (secção `# Environment`) de propósito: a guarda de apagar e o que o modelo
// lê têm de vir da mesma fonte, senão divergem.
import { readGeneratedPaths } from './contextBuilder/projectUtils'
import { getFsVersion, bumpFsVersion } from '../fsVersion'
import CheckpointService from './checkpointService'
import { markReadBeforeWriteBlocked, markTmsCreated, markTmsFullContextSent } from './tmsContext'
import type { MCPTool } from '../mcp/mcpService'

// === Types ===

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /**
   * True iff this tool can run in parallel with other concurrency-safe tools
   * without risking races or correctness bugs. Read-only operations
   * (read_file, list_directory, glob, web_fetch, etc.) are safe. Anything that
   * mutates the filesystem, spawns processes, or mutates agent state is not.
   *
   * Default: false (serial). Gates the loop's parallel dispatch (query.ts
   * stream-dispatch + post-stream prefix) via isStreamSafeTool.
   * Not sent to the API — getToolDefinitions() only copies name/description/parameters.
   */
  concurrencySafe?: boolean
  /**
   * True iff this tool is handled server-side by the AI provider (e.g.
   * DashScope native web_search). The frontend registers the schema so
   * the model can call it, but no execute handler runs locally. If the
   * provider doesn't handle it, a skip notice is returned.
   *
   * Default: false (local execution). Not sent to the API.
   */
  passive?: boolean
}

export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

interface ToolEntry {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>) => Promise<string>
  /**
   * Def DIFERIDO (2026-08-03, só MCP): não segue em getToolDefinitions().
   * O prompt anuncia nome+resumo e o modelo carrega o schema via o meta-tool
   * `load_tools` quando precisa. O execute continua registado e funcional —
   * a deferral é sobre o que VIAJA nos pedidos, não sobre o que existe.
   */
  deferred?: boolean
}

interface ReadFileWithSignatureResult {
  content: string
  signature: FileContentSignature
}

interface ReadFileRangeWithSignatureResult extends ReadFileWithSignatureResult {
  startLine: number
  lineCount: number
  totalLines: number
  hasMore: boolean
}

interface ReadVisibility {
  range: { offset?: number; limit?: number } | null
  partialView: boolean
}

interface AgentShellSession {
  id: string
  cwd: string
  output: string
  readOffset: number
  activeToolCallId: string | null
  exited: boolean
  exitCode: number | null
  createdAt: number
  updatedAt: number
}

interface PtyOutputEvent {
  session_id: string
  data: string
}

interface PtyExitEvent {
  session_id: string
  exit_code: number
}

interface InteractiveShellInfo {
  command: string
  args: string[]
  kind: string
  commandStyle: string
  platform: string
  warning?: string | null
}

const AGENT_SHELL_MAX_BUFFER_CHARS = 200_000

/** Teto do backstop MCP — ver o comentário no execute dos MCP tools. */
const MCP_TOOL_TIMEOUT_MS = 10 * 60_000

/**
 * Tecto de espera por output do agent shell. TEM de bater certo com o `Max`
 * anunciado nos schemas do agent_shell_write/read — um tecto mais baixo do que
 * o prometido devolve o controlo ao modelo antes de o trabalho acabar e
 * empurra-o para o polling que essas mesmas descrições proíbem.
 */
const AGENT_SHELL_MAX_WAIT_MS = 120_000

// Tools whose execution can change git state. After any of these completes,
// we nudge the shared git poller + Monaco gutters via 'git:refreshGutter'
// (debounced on the listener side) — in an agent-first IDE the agent's own
// edits are the dominant source of git changes, so this makes the Source
// Control panel reactive instead of waiting for the background tick.
// execute_command* are included because shell commands (git commit, mv, …)
// mutate the worktree too.
const GIT_MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file',
  'create_directory', 'execute_command', 'execute_command_background',
])

/**
 * Tools que executam texto de shell arbitrário. Qualquer gate que valha para
 * uma TEM de valer para as três — o comando é o mesmo, só muda a superfície.
 * (Auditoria 2026-07-28: o gate de comandos perigosos e o selo do .env viviam
 * só no execute_command, e o gémeo em background auto-aprovava por scope o que
 * o de primeiro plano obrigava a confirmar.)
 */
const SHELL_COMMAND_TOOLS = new Set([
  'execute_command', 'execute_command_background', 'agent_shell_write',
])

// === Tool Executor ===

/**
 * Detect commands whose output should stream in real-time to the UI.
 * These are long-running commands (build, test, lint, script execution)
 * where the user benefits from seeing live logs instead of waiting for
 * the final result.
 *
 * Install commands (npm install, etc.) are handled separately by
 * `executeInstallStreaming` which has additional PID-based cancellation.
 */
function isStreamingCommand(cmd: string): boolean {
  const normalized = cmd.replace(/\s+/g, ' ').trim()

  // Shell scripts (.sh, .bash)
  if (/\.(?:sh|bash)(?:\s|$)/.test(normalized)) return true
  if (/\bbash\b/.test(normalized) && /\.sh/.test(normalized)) return true

  // Build commands
  if (/(?:npm|yarn|pnpm|bun)\s+run\s+(?:build|compile|dist|package|bundle)/.test(normalized)) return true
  if (/\b(?:make|cmake|gradle|mvn|cargo\s+build|go\s+build)\b/.test(normalized)) return true
  if (/\bwebpack\b|\bvite\s+build\b|\brollup\b|\besbuild\b/.test(normalized)) return true

  // Test commands
  if (/(?:npm|yarn|pnpm|bun)\s+run\s+(?:test|test:\w+|spec|e2e)/.test(normalized)) return true
  if (/(?:npm|yarn|pnpm|bun)\s+test\b/.test(normalized)) return true
  if (/\bjest\b|\bvitest\b|\bmocha\b|\bcypress\b|\bplaywright\b/.test(normalized)) return true
  if (/\bcargo\s+test\b|\bgo\s+test\b|\bpytest\b/.test(normalized)) return true

  // Lint / format commands
  if (/(?:npm|yarn|pnpm|bun)\s+run\s+(?:lint|format|check|typecheck)/.test(normalized)) return true
  if (/\btsc\b|\beslint\b|\bprettier\b/.test(normalized)) return true
  if (/\bflake8\b|\bruff\b|\bblack\b/.test(normalized)) return true

  // Compound commands with && that include streaming-capable parts
  if (/&&/.test(normalized)) {
    const parts = normalized.split('&&').map(p => p.trim())
    if (parts.some(p => isStreamingCommand(p))) return true
  }

  return false
}

function formatBackgroundCommandResult(cmd: {
  id: string; command: string; status: string; pid: number;
  exitCode: number | null; output: string; startedAt: number; completedAt: number | null
}, opts?: { full?: boolean }): string {
  const elapsed = cmd.completedAt
    ? `${Math.round((cmd.completedAt - cmd.startedAt) / 1000)}s`
    : `${Math.round((Date.now() - cmd.startedAt) / 1000)}s (still running)`

  const lines: string[] = [
    `[${cmd.status.toUpperCase()}] ${cmd.command} (id: ${cmd.id}, PID: ${cmd.pid}, elapsed: ${elapsed})`,
  ]

  if (cmd.exitCode !== null) {
    lines.push(`Exit code: ${cmd.exitCode}`)
  }

  if (cmd.output) {
    // Vista COMPACTA (listagem de todos): cauda de 4k com um ponteiro que
    // FUNCIONA — pedir pelo id devolve o output completo (via truncateResult,
    // que guarda o corpo no large-result store com refId real). O pre-slice
    // antigo dizia só "(truncated)" e a cabeça era irrecuperável (auditoria
    // 2026-07-28, o mesmo padrão do bug do execute_command).
    const MAX_OUTPUT = 4000
    // O convite a pedir por id SÓ vale para comandos que já terminaram.
    //
    // Era emitido sempre, e contradizia o guardrail: a tool dizia "call
    // check_background_commands with id ... for the full output" e a chamada
    // seguinte recebia "do not ask again". Medido no export de 2026-08-02
    // (deploy do momenu-fact): o modelo obedeceu ao convite três vezes
    // seguidas — chamadas 54, 55, 56 — e levou com a recusa as três. Seguiu a
    // instrução que prometia os dados, que é a escolha racional entre duas
    // instruções contraditórias.
    //
    // Enquanto corre não há "output completo" para ir buscar — só um output
    // parcial que vai crescer. Dizê-lo é honesto E remove a contradição.
    const truncatedHint = cmd.status === 'running'
      ? `...(output parcial, ${cmd.output.length} chars até agora — o comando ainda corre; o output fica completo quando terminar)`
      : `...(truncated — call ${CHECK_BACKGROUND_COMMANDS} with id: ${cmd.id} for the full output)`
    const output = !opts?.full && cmd.output.length > MAX_OUTPUT
      ? `${truncatedHint}\n${cmd.output.slice(-MAX_OUTPUT)}`
      : cmd.output
    lines.push(output)
  }

  return lines.join('\n')
}

class ToolExecutor {
  private static instance: ToolExecutor
  private tools: Map<string, ToolEntry> = new Map()
  /** Tracks when files were last read by the model — for read-before-write enforcement.
   *  Stores timestamp + a simple content hash to detect concurrent modifications. */
  private readFileTimestamps: Map<string, { timestamp: number; hash: number }> = new Map()
  /** Content cache for files read by the model — enables dedup (avoids
   *  re-sending identical content) and state recovery after session resume.
   *  Mirrors claude-vaz's `FileStateCache` / `readFileState`. */
  private readFileState: FileStateCache = createFileStateCacheWithSizeLimit()
  /**
   * Cwd-scoped execution root. When set, no project-store entry is required,
   * file writes go directly to disk, and path validation is scoped to this
   * directory instead of the open-project root.
   */
  private cmdModeCwd: string | null = null
  /** Active worktree session (enter_worktree) — while set, getProjectRoot()
   *  resolves here so every file/shell operation lands in the isolated
   *  checkout. Forked to delegate children; cleared on session reset. */
  private worktreeState: import('./toolExecutor/worktrees').WorktreeState | null = null

  /**
   * The project this executor's run BELONGS to, for in-window multi-project.
   * Set by a background project-run's isolated executor so path resolution,
   * the Rust cwd clamp and permission grants target the RUN's project instead
   * of whatever project the developer is currently VIEWING (`currentProject`).
   * Null for the foreground/main agent, which follows `currentProject`.
   */
  private runProjectContext: { projectId: string; projectPath: string } | null = null

  /**
   * Plan mode — when true, /plan is active and only architecture-producing
   * tools may run. Implementation tools (request_credentials,
   * execute_command, start_dev_server, install commands) are blocked at
   * execute() entry with an instructive error so the model is forced back
   * onto producing PLAN.md. Belt-and-braces over the architect system prompt:
   * if a model with strong "build the thing" priors ignores the role, the
   * mechanical block returns a tool result the model cannot ignore.
   */
  private planMode: boolean = false
  private planModePlanFileName: string = 'PLAN.md'
  /**
   * Owners that currently hold plan-mode (refcounted). Live-task `/plan` and
   * main `executePlan` each register an owner so one finishing does not clear
   * plan-mode for the other (singleton ToolExecutor under F2 multi-project).
   */
  private planModeOwners: Set<string> = new Set()

  /** Assinatura dos comandos em background ainda a correr na última consulta,
   *  e quantas vezes seguidas foi pedida sem nada mudar. Ver a recusa de
   *  polling em `check_background_commands`. */
  private lastBackgroundPollSignature = ''
  private backgroundPollRepeats = 0
  // Mesmo circuito para o collect_results. A descrição da tool sempre disse
  // "não chames outra vez para esperar" — e nada o impedia (auditoria
  // 2026-07-29). Pedir por palavras o que se pode negar por construção é o
  // mesmo erro que custou 42% dos turnos no polling de comandos de fundo.
  private lastCollectResultsSignature = ''
  private collectResultsRepeats = 0

  /**
   * Ficheiros que NÃO existiam antes desta sessão e foram criados pelo agente,
   * mapeados para o hash do conteúdo que ele escreveu.
   *
   * Serve a guarda de apagar. Apagar um ficheiro ignorado força o diálogo
   * porque o git não o restaura — mas se foi o agente que o criou agora, o
   * estado anterior é "não existia" e apagá-lo devolve exactamente isso. Aí o
   * diálogo é atrito puro, e atrito percebido como ruído é o que empurra as
   * pessoas para o YOLO, que desliga TODAS as guardas. Uma guarda que empurra
   * para o YOLO tem retorno negativo.
   *
   * O hash é a parte que torna a isenção segura: se o conteúdo em disco já não
   * é o que o agente escreveu, alguém mexeu no ficheiro entretanto e passa a
   * haver algo a perder — a isenção cai e o diálogo volta.
   */
  private createdThisSession: Map<string, number> = new Map()

  /** Regista uma criação (só é chamado onde se sabe que o ficheiro não existia). */
  private recordCreatedFile(absPath: string, content: string): void {
    this.createdThisSession.set(absPath, this.simpleHash(content))
  }

  /**
   * O agente criou este ficheiro nesta sessão E ele continua como o agente o
   * deixou? Se alguém lhe mexeu entretanto há algo a perder, e a isenção cai.
   */
  private async isUntouchedAgentCreation(absPath: string): Promise<boolean> {
    const writtenHash = this.createdThisSession.get(absPath)
    if (writtenHash === undefined) return false
    try {
      const current = await invoke<string>('read_file', { path: absPath })
      return this.simpleHash(typeof current === 'string' ? current : '') === writtenHash
    } catch {
      // Não existe / ilegível: não há nada a perder ao apagar.
      return true
    }
  }

  /**
   * Classifica o que se perde ao apagar/renomear este caminho.
   *
   * Distinguir os dois casos não é cosmética. O primeiro desenho tratava
   * "ignorado pelo git" como sinónimo de "output de build" e dizia isso ao
   * modelo — mas um `.log`, um `.DS_Store` ou um rascunho também são
   * ignorados, e afirmar-lhe que são output de build é dizer-lhe uma coisa
   * falsa. Foi exactamente esse o defeito que originou toda esta série: tools
   * que asseveram ao modelo aquilo que não sabem.
   */
  private async classifyDeletionRisk(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ kind: 'generated' | 'ignored' | 'none'; declaredBy?: string }> {
    if (toolName !== 'delete_file' && toolName !== 'rename_file') return { kind: 'none' }
    const target = (input.file_path || input.oldPath || '') as string
    const projectRoot = this.getProjectRoot()
    if (!target || !projectRoot) return { kind: 'none' }

    const abs = this.resolveToAbsolute(target)
    if (await this.isUntouchedAgentCreation(abs)) return { kind: 'none' }

    try {
      const ignored = await invoke<boolean>('is_path_gitignored', {
        projectPath: projectRoot,
        filePath: abs,
      })
      if (!ignored) return { kind: 'none' }

      // Ignorado. Está dentro de algo que o projecto DECLARA como output?
      // Só nesse caso é que "muda a fonte e reconstrói" é conselho verdadeiro.
      const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/$/, '')
      const rel = abs.replace(/\\/g, '/').startsWith(`${normalizedRoot}/`)
        ? abs.replace(/\\/g, '/').slice(normalizedRoot.length + 1)
        : ''
      if (rel) {
        for (const gen of await readGeneratedPaths(normalizedRoot)) {
          if (rel === gen.path || rel.startsWith(`${gen.path}/`)) {
            return { kind: 'generated', declaredBy: gen.source }
          }
        }
      }
      return { kind: 'ignored' }
    } catch (error) {
      // Falhar aberto é a escolha certa — uma verificação indisponível não
      // pode bloquear a tool. Mas falhar CALADO não é: se `is_path_gitignored`
      // deixar de estar na allow-list de permissões (todo `#[tauri::command]`
      // novo tem de lá ir, e esquecer é fácil), o invoke é rejeitado antes de
      // chegar ao Rust, este catch devolve 'none' e a guarda fica MORTA sem
      // nada o denunciar. Nem os testes: em Jest o invoke é mock.
      //
      // Uma guarda de segurança que se desliga em silêncio é pior do que não
      // existir, porque ninguém volta a olhar para ela. Fica ruidosa.
      logger.error(
        'agent',
        '[deletion-guard] a verificação de gitignore falhou — a guarda de apagar está INACTIVA para este caminho. ' +
          'Verifica se `is_path_gitignored` continua registado em lib.rs E em permissions/autogenerated.toml.',
        error,
      )
      return { kind: 'none' }
    }
  }

  /**
   * Memory scope — set per-invocation by execute() when a sub-agent
   * passes its agentType. Memory tools read from execInput._memoryScope
   * (via getMemoryScope(input) helper in memoryOps.ts), which is set
   * from this field at the start of each execute() call.
   * No shared mutable state between concurrent sub-agents.
   */
  private memoryScopeAgentType: string | null = null
  private requestType: string | null = null

  /** Telemetry from the last delegate call — read by query.ts onRequestUsage. */
  lastDelegateInfo: {
    requestedMember: string | null
    resolvedMember: string | null
    blocked: boolean
    blockedReason: string | null
    inputSchemaVersion: string
    recoveryAttempted: boolean
  } | null = null

  /**
   * Plan-mode progress flags. Together they enforce the architect contract:
   *
   *   1. update_tasks is BLOCKED until the plan file is written (no task list without a plan).
   *   2. After both the plan file is written AND update_tasks has run once, ANY further
   *      tool call is blocked — the architect's role is complete and continuing
   *      drifts into implementation.
   *
   * Both reset to false on every enablePlanMode() so each /plan run starts clean.
   */
  private planFileWritten: boolean = false
  private planTasksSeeded: boolean = false
  private agentShellSessions: Map<string, AgentShellSession> = new Map()
  private agentShellListenersReady: Promise<void> | null = null
  private lastAgentShellSessionId: string | null = null

  /** Shared context — passed to domain registration functions. */
  private readonly ctx: ToolRegistrationContext

  /** Home dir cache para expandir `~/...` em resolveToAbsolute (que é sync).
   *  Populado fire-and-forget no arranque; até resolver, paths com `~` caem
   *  no comportamento antigo (tratados como relativos). */
  private homeDir: string | null = null

  private constructor() {
    this.ctx = this.buildContext()
    this.registerTools()
    void invoke<string>('get_home_directory')
      .then((home) => { this.homeDir = home })
      .catch(() => { /* sem home dir, `~` não expande — não é fatal */ })
  }

  static getInstance(): ToolExecutor {
    if (!ToolExecutor.instance) {
      ToolExecutor.instance = new ToolExecutor()
    }
    return ToolExecutor.instance
  }

  /**
   * Create an isolated executor for a sub-agent run.
   *
   * The child gets its own read-file cache, large-result store, shell sessions,
   * and memory scope state, while inheriting the parent execution scope. This
   * mirrors the claude-vaz pattern of per-agent tool contexts without changing
   * the main-agent singleton contract.
   */
  createIsolatedChild(): ToolExecutor {
    const child = new ToolExecutor()
    child.cmdModeCwd = this.cmdModeCwd
    child.worktreeState = this.worktreeState
    child.runProjectContext = this.runProjectContext
    child.permissionOrigin = this.permissionOrigin
    child.requestType = this.requestType
    child.planMode = this.planMode
    child.planModePlanFileName = this.planModePlanFileName
    child.planFileWritten = this.planFileWritten
    child.planTasksSeeded = this.planTasksSeeded
    child.largeResultsDir = this.largeResultsDir
    return child
  }

  /** Release session-scoped state owned by an isolated child executor. */
  disposeIsolatedChild(): void {
    this.resetSessionState()
    this.cmdModeCwd = null
    this.disablePlanMode()
    this.largeResultsDir = null
    this.memoryScopeAgentType = null
  }

  setRequestType(type: string | null): void {
    this.requestType = type
  }

  /**
   * Attribution for permission prompts raised by THIS executor. Set by the
   * parallel-task runner on its isolated child so the dialog + task rows can
   * say WHICH task is asking ("Autorização" badge). Also carries projectId
   * for in-window multi-project so grants resolve to the RUN's project.
   * Null for the main agent (uses focused project grants).
   */
  private permissionOrigin: import('../../stores/permissionStore').PermissionOrigin | null = null

  setPermissionOrigin(origin: import('../../stores/permissionStore').PermissionOrigin | null): void {
    this.permissionOrigin = origin
  }

  /**
   * Effective permission origin for this executor: explicit origin (task) with
   * projectId filled from runProjectContext when missing, so background
   * project-runs always check/write the correct project's grants.
   */
  private resolvePermissionOrigin(): import('../../stores/permissionStore').PermissionOrigin | undefined {
    const projectId = this.runProjectContext?.projectId
    if (this.permissionOrigin) {
      if (projectId && !this.permissionOrigin.projectId) {
        return { ...this.permissionOrigin, projectId }
      }
      return this.permissionOrigin
    }
    // No task origin: still stamp projectId when this is a bound project-run
    // so requestPermission does not fall through to the focused project.
    // Label is the folder name (not the UUID) so the attention inbox can say
    // "my-app · write_file" when the user is focused on another project.
    if (projectId) {
      const path = this.runProjectContext?.projectPath ?? ''
      const folder = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || projectId
      return { taskId: `project:${projectId}`, label: folder, projectId }
    }
    return undefined
  }

  /**
   * Bind this executor to a specific project (in-window multi-project runs).
   * A background project-run sets this so getProjectRoot() / path scope / the
   * Rust cwd clamp resolve to the RUN's project, not the viewed one. The main
   * agent leaves it null and follows `currentProject`.
   */
  setProjectContext(ctx: { projectId: string; projectPath: string } | null): void {
    this.runProjectContext = ctx
  }

  getProjectContext(): { projectId: string; projectPath: string } | null {
    return this.runProjectContext
  }

  clearDelegateTelemetry(): void {
    this.lastDelegateInfo = null
  }

  consumeDelegateTelemetry(): ToolExecutor['lastDelegateInfo'] {
    const info = this.lastDelegateInfo
    this.lastDelegateInfo = null
    return info
  }

  /** Enable cwd-scoped execution: file ops write directly to disk, no project required. */
  enableCmdMode(cwd: string): void {
    this.cmdModeCwd = cwd
  }

  /** Raiz do projeto para encurtar caminhos em texto entregue ao modelo.
   *  `getProjectRoot()` é privado e resolve worktree/project-run; expor uma
   *  leitura só-de-texto evita duplicar essa lógica no caller. */
  getProjectRootForDiagnostics(): string {
    try { return this.getProjectRoot() } catch { return '' }
  }

  private buildContext(): ToolRegistrationContext {
    return {
      tools: this.tools,
      getProjectRoot: () => this.getProjectRoot(),
      validatePathWithinProject: (p: string) => { this.validatePathWithinProject(p); return p },
      readFileTimestamps: this.readFileTimestamps,
      readFileState: this.readFileState,
      largeResults: this.largeResults,
      readLargeResultFromDisk: (id) => this.readLargeResultFromDisk(id),
      getCmdModeCwd: () => this.cmdModeCwd,
      getTaskOrigin: () => this.permissionOrigin,
      getMemoryScopeAgentType: () => this.memoryScopeAgentType,
      getPlanMode: () => this.planMode,
      getPlanFileWritten: () => this.planFileWritten,
      getPlanReadyForTaskSeed: () => this.isPlanReadyForTaskSeed(),
      setPlanTasksSeeded: (v: boolean) => { this.planTasksSeeded = v },
      truncateResult: (r, maxChars) => this.truncateResult(r, maxChars),
      trackShownRange: (id, o, e) => this.trackShownRange(id, o, e),
      simpleHash: (s) => simpleHash(s),
      formatFileTreeCompact: (n, indent) => this.formatFileTreeCompact(n, indent),
      refreshFileTree: () => this.refreshFileTree(),
      closeEditorIfOpen: (p) => this.closeEditorIfOpen(p),
      suggestSimilarPath: async (p: string) => this.suggestSimilarPath(p),
    }
  }

  /** Disable cwd-scoped execution and return to project diff approval flow. */
  disableCmdMode(): void {
    this.cmdModeCwd = null
  }

  /** Clear any inherited enter_worktree redirect. A parallel project-run's
   *  isolated child copies the main run's worktreeState in createIsolatedChild;
   *  the task must NOT resolve into the main agent's worktree (worktreeState has
   *  the highest precedence in getProjectRoot), so it clears it and relies on
   *  enableCmdMode(projectPath) instead. */
  clearWorktreeState(): void {
    this.worktreeState = null
  }

  /**
   * Enable architect mode for /plan: implementation tools are blocked.
   * Resets plan-progress flags so each /plan run starts clean.
   * @param ownerId optional lease id — pair with `disablePlanMode(ownerId)`.
   *   Omit for legacy single-owner callers (`executePlan`); they clear all.
   */
  enablePlanMode(planFileName: string = 'PLAN.md', ownerId?: string): void {
    this.planMode = true
    this.planModePlanFileName = planFileName || 'PLAN.md'
    this.planFileWritten = false
    this.planTasksSeeded = false
    if (ownerId) {
      this.planModeOwners.add(ownerId)
    } else {
      // Legacy: anonymous owner so disablePlanMode() without id still clears.
      this.planModeOwners.add('__legacy__')
    }
  }

  /**
   * Restore the normal coding agent surface when no owners remain.
   * @param ownerId when set, only releases this lease; plan-mode stays on if
   *   other owners still hold it. When omitted, clears all owners (legacy).
   */
  disablePlanMode(ownerId?: string): void {
    if (ownerId) {
      this.planModeOwners.delete(ownerId)
    } else {
      this.planModeOwners.clear()
    }
    if (this.planModeOwners.size > 0) return
    this.planMode = false
    this.planModePlanFileName = 'PLAN.md'
    this.planFileWritten = false
    this.planTasksSeeded = false
  }

  isPlanMode(): boolean {
    return this.planMode
  }

  /** Test/diagnostics: active plan-mode lease count. */
  getPlanModeOwnerCount(): number {
    return this.planModeOwners.size
  }

  /** Clears session-scoped state. Call on new sessions. */
  resetSessionState(): void {
    clearMentionContextTracker()
    // A worktree session never survives a session reset — the next run must
    // resolve against the real project root, not a possibly-stale worktree.
    this.worktreeState = null
    this.readFileTimestamps.clear()
    this.readFileState.clear()
    // A isenção de "fui eu que o criei" é válida DENTRO da sessão: numa sessão
    // nova, um ficheiro criado antes já é património do projecto como outro
    // qualquer, e apagá-lo volta a merecer o diálogo.
    this.createdThisSession.clear()
    this.lastBackgroundPollSignature = ''
    this.backgroundPollRepeats = 0
    this.lastCollectResultsSignature = ''
    this.collectResultsRepeats = 0
    clearReadRangeTracker()
    this.largeResults.clear()
    this.largeResultsTotalBytes = 0
    this.largeResultRangesShown.clear()
    this.largeResultCounter = 0
    this.readOnlyContexts.clear()
    for (const id of this.agentShellSessions.keys()) {
      invoke('kill_pty_session', { sessionId: id }).catch(() => {})
    }
    this.agentShellSessions.clear()
    this.lastAgentShellSessionId = null
  }

  /**
   * Rebuild read state from conversation history (session resume).
   *
   * When a session is resumed, the ToolExecutor's in-memory state is empty.
   * This method walks the conversation history and reconstructs both
   * `readFileTimestamps` and `readFileState` so that:
   *   - Read-before-write enforcement works (the model "remembers" what
   *     it has read)
   *   - Dedup works (redundant reads return stubs instead of full content)
   *
   * Mirrors claude-vaz's `extractReadFilesFromMessages`.
   *
   * @param messages  Conversation history
   * @param invokeReadFile  Tauri IPC function to read files from disk
   */
  rebuildReadStateFromHistory(
    messages: Parameters<typeof extractReadFilesFromMessages>[0],
    invokeReadFile: (path: string) => Promise<string>,
  ): void {
    const cwd = this.getProjectRoot()
    extractReadFilesFromMessages(
      messages,
      this.readFileState,
      this.readFileTimestamps,
      cwd,
      invokeReadFile,
    )
  }

  /**
   * Evict the oldest large result and update the incremental byte counter.
   * Used by both the byte-cap and entry-count eviction loops in
   * `truncateResult` — single source of truth for the bookkeeping.
   */
  private evictOldestLargeResult(): void {
    const firstKey = this.largeResults.keys().next().value
    if (!firstKey) return
    const removed = this.largeResults.get(firstKey)
    this.largeResults.delete(firstKey)
    this.largeResultRangesShown.delete(firstKey)
    if (removed) this.largeResultsTotalBytes -= removed.length
  }

  /**
   * Merge a new `[offset, end)` range into the per-id ranges-shown list,
   * coalescing with any existing ranges it touches. Keeps the list flat
   * and small even after many sequential reads — three reads at 0-2k,
   * 2k-4k, 4k-6k collapse to a single `[0, 6000)` entry. Returns the
   * single range that the new read overlapped with (for the model's
   * overlap warning), or `null` if there was no overlap.
   */
  private trackShownRange(id: string, offset: number, end: number): [number, number] | null {
    const ranges = this.largeResultRangesShown.get(id) ?? []
    // Find every existing range that touches [offset, end) — they all merge.
    let mergedStart = offset
    let mergedEnd = end
    let firstOverlap: [number, number] | null = null
    const survivors: Array<[number, number]> = []
    for (const r of ranges) {
      if (r[0] <= mergedEnd && mergedStart <= r[1]) {
        if (!firstOverlap) firstOverlap = [r[0], r[1]]
        mergedStart = Math.min(mergedStart, r[0])
        mergedEnd = Math.max(mergedEnd, r[1])
      } else {
        survivors.push(r)
      }
    }
    survivors.push([mergedStart, mergedEnd])
    // Re-sort by start so future overlap checks see ascending ranges.
    survivors.sort((a, b) => a[0] - b[0])
    this.largeResultRangesShown.set(id, survivors)
    return firstOverlap
  }

  // ══════════════════════════════════════════════════════════════
  // @-mention surface — used exclusively by atMentions.ts
  // ══════════════════════════════════════════════════════════════
  //
  // Mirrors claude-vaz's at-mention pipeline (utils/attachments.ts
  // `processAtMentionedFiles` → `generateFileAttachment`), which executes
  // the REAL FileReadTool for mentioned files so the model-visible result,
  // the read-state bookkeeping, and the dedup behaviour are byte-identical
  // to a model-initiated call. The permission layer is skipped on purpose:
  // the user explicitly named the target in their prompt (claude-vaz only
  // checks deny rules — `isFileReadDenied` — for at-mentions). The hard
  // blocks survive: `.env` is refused here, and path-scope validation
  // throws inside the tool handlers themselves.

  /**
   * Resolve a mention token to the absolute path the read tools will use.
   * Exposed so atMentions.ts renders the synthetic "Called the read_file
   * tool with the following input" line with the SAME path the tool call
   * actually received — claude-vaz shows the expanded absolute path too.
   */
  resolveMentionPath(p: string): string {
    return this.resolveToAbsolute(p)
  }

  /** Whether a mentioned path is inside the agent's allowed scope.
   *  Out-of-scope mentions are dropped silently — same outcome as
   *  claude-vaz's deny-rule check returning null. */
  isMentionPathAllowed(p: string): boolean {
    try {
      this.validatePathWithinProject(p)
      return true
    } catch {
      return false
    }
  }

  /**
   * Whether the model already has a fresh FULL view of this file in context.
   * Used by @mentions to render NOTHING instead of re-sending content the
   * model already has. Fast path is fsVersion; when that changed because some
   * other file was written, a Rust SHA-256 signature proves this path is still
   * unchanged without fetching the full file body.
   */
  async isFileFreshInContext(filePath: string): Promise<boolean> {
    const abs = this.resolveToAbsolute(filePath)
    const entry = this.readFileState.get(abs)
    if (!entry || entry.offset !== undefined || entry.limit !== undefined) return false
    if (entry.source !== 'read' || entry.isPartialView) return false
    if (entry.fsVersion === getFsVersion()) return true
    if (!entry.signature) return false

    try {
      const current = await invoke<FileContentSignature>('file_signature', { path: abs })
      return current.size === entry.signature.size && current.sha256 === entry.signature.sha256
    } catch {
      return false
    }
  }

  /**
   * Execute a read-only tool handler directly for @-mention resolution,
   * bypassing the permission/abort/plan-mode layers of `execute()` (the
   * mention is user-initiated; there is no model tool_call to gate).
   * Path-scope validation still throws inside the handlers; `.env` stays
   * hard-blocked here exactly as in `execute()`.
   */
  async executeForMention(
    toolName: 'read_file' | 'list_directory',
    input: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.tools.get(toolName)
    if (!tool) throw new Error(`Unknown tool: ${toolName}`)
    const filePath = (input.file_path || '') as string
    if (this.isEnvFile(filePath)) {
      // Same hard block as execute() — thrown (not returned) so the mention
      // resolver drops the mention silently instead of inlining the refusal.
      throw new Error('.env files are blocked from mention resolution')
    }
    // Ficheiros sensíveis (credentials, chaves, etc.) PERGUNTAM mesmo em
    // menção (decisão do user 2026-06-11): @credentials.json sem prompt
    // relaxava a proteção que o read_file normal tem. Negado → throw → a
    // menção é descartada silenciosamente (o user acabou de decidir isso
    // no diálogo; nenhum conteúdo chega ao modelo).
    if (toolName === 'read_file' && this.isSensitiveFile(filePath)) {
      const decision = await getAgentHost().canUseTool(
        'read_file', input, 'sensitive_file',
      )
      if (!decision.approved) {
        throw new Error('sensitive-file mention denied by user')
      }
    }
    return tool.execute(input)
  }

  private recordReadBeforeWriteBlocked(
    toolName: typeof WRITE_FILE | typeof EDIT_FILE,
    reason: 'not_read' | 'partial_view' | 'modified_since_read',
  ): void {
    markReadBeforeWriteBlocked(toolName, reason)
    void import('../../services/analytics').then(({ trackEvent }) => {
      void trackEvent('read_before_write_blocked', {
        tool: toolName,
        reason,
      })
    }).catch(() => { /* analytics never blocks tool execution */ })
  }

  private async hasFileChangedSinceRead(
    path: string,
    currentContent: string,
    readState: { hash: number },
    cachedState: FileState | undefined,
  ): Promise<boolean> {
    const currentHash = this.simpleHash(currentContent)
    if (currentHash === readState.hash) return false

    const isRangedRead =
      cachedState?.source === 'read' &&
      (cachedState.offset !== undefined || cachedState.limit !== undefined)
    const readModifiedMs = cachedState?.signature?.modifiedMs
    if (!isRangedRead || readModifiedMs === undefined || readModifiedMs === null) {
      return true
    }

    try {
      const current = await invoke<{ modifiedMs: number | null }>('file_stat', { path })
      return current.modifiedMs === undefined ||
        current.modifiedMs === null ||
        current.modifiedMs !== readModifiedMs
    } catch {
      return true
    }
  }

  /**
   * Large @mentions intentionally show only a compact outline/preview to the
   * model. The underlying read_file call still refreshes signatures and hashes,
   * but the model did NOT see the full file, so write/edit tools must require
   * an explicit read_file before mutating it.
   */
  markMentionPathAsPartialView(filePath: string): void {
    const abs = this.resolveToAbsolute(filePath)
    const entry = this.readFileState.get(abs)
    if (!entry) return
    this.readFileState.set(abs, { ...entry, isPartialView: true })
  }

  /**
   * External-modification sweep — port of claude-vaz's `getChangedFiles`
   * (utils/attachments.ts:2063-2140). Walks every full-view entry in
   * `readFileState`, stats the file, and when the disk content diverged
   * from what the model last saw, returns a post-edit snippet (changed
   * hunks, line-numbered) for the "Note: X was modified..." reminder.
   *
   * State is updated in place on detection (claude-vaz re-runs
   * FileReadTool.call, which refreshes readFileState) so:
   *   - the next sweep doesn't re-fire for the same edit, and
   *   - read-before-write enforcement accepts an edit_file without a
   *     fresh read — the model HAS the current content via the snippet.
   *
   * Ranged reads (offset set) are skipped — claude-vaz has the same TODO
   * (offset/limit entries return null). Partial injected views are skipped
   * too: there is no full baseline to diff against.
   */
  async collectExternallyChangedFiles(): Promise<Array<{ path: string; snippet: string }>> {
    const changed: Array<{ path: string; snippet: string }> = []
    // Snapshot first — set() during LRU iteration would mutate recency order.
    const entries = Array.from(this.readFileState.entries())
    for (const [path, entry] of entries) {
      if (entry.offset !== undefined || entry.limit !== undefined) continue
      if (entry.isPartialView) continue

      // Cheap mtime gate before paying for a full read. stat failure means
      // deleted/unreadable — skip (claude-vaz returns null on read failure).
      let mtimeMs: number | null = null
      try {
        const { stat } = await import('@tauri-apps/plugin-fs')
        const info = await stat(path)
        mtimeMs = info.mtime ? new Date(info.mtime).getTime() : null
      } catch {
        continue
      }
      if (mtimeMs !== null && mtimeMs <= entry.timestamp) continue

      let current: string
      let signature: FileContentSignature | undefined
      try {
        const result = await invoke<ReadFileWithSignatureResult>('read_file_with_signature', { path })
        current = result.content
        signature = result.signature
      } catch {
        continue
      }
      const newHash = simpleHash(current)
      const previousContent = entry.content
      const touchedOnly = newHash === entry.hash

      // Refresh state even when content is identical — bumps the stored
      // timestamp past the new mtime so the sweep stops re-stat-reading
      // a file that was merely touched.
      const now = Date.now()
      this.readFileTimestamps.set(path, { timestamp: now, hash: newHash })
      this.readFileState.set(path, {
        content: current,
        timestamp: now,
        offset: entry.offset,
        limit: entry.limit,
        source: entry.source ?? 'read',
        signature,
        hash: newHash,
        fsVersion: getFsVersion(),
      })

      if (touchedOnly) continue
      const snippet = getSnippetForTwoFileDiff(previousContent, current)
      // Whitespace-only/no-hunk edits yield '' — claude-vaz skips those.
      if (snippet === '') continue
      changed.push({ path, snippet })
    }
    return changed
  }

  /**
   * Bloqueia enquanto houver uma intervenção obrigatória do utilizador
   * pendente DESTE run (F2: por projecto/origin — não é mais pausa global).
   * Polling de 120ms em vez de subscriptions: só corre enquanto um gate
   * está aberto (caso raro e human-paced), e evita gerir 4 subscrições
   * zustand com cleanup por chamada concorrente. O abort interrompe a
   * espera imediatamente no próximo tick.
   */
  private async waitForUserGates(signal?: AbortSignal, toolUseId?: string): Promise<void> {
    // P2 headless (2026-08-03): o corpo — gateIsMine + poll de 120ms sobre as
    // 4 stores, incluindo a excepção de lote do writeBatch — mudou-se
    // tal-e-qual para o hospedeiro-janela (windowHost, waitForUserGates); um
    // host de teste/headless resolve imediatamente, porque não existe UI que
    // possa estar aberta.
    await getAgentHost().waitForUserGates(
      {
        projectId: this.runProjectContext?.projectId ?? null,
        taskId: this.permissionOrigin?.taskId ?? null,
      },
      { signal, toolUseId },
    )
  }

  /** Tools de escrita sujeitas ao registry de claims (Fase 4b/6b). */
  private static readonly CLAIM_WRITE_TOOLS = new Set<string>([
    WRITE_FILE, EDIT_FILE, CREATE_FILE, DELETE_FILE, RENAME_FILE, CREATE_DIRECTORY,
  ])

  /** Alvos de escrita relativizados à raiz do agente (worktree/cmd-cwd ou
   *  projecto) — a MESMA chave para todos os agentes, para os claims baterem. */
  private relWriteTargets(input: Record<string, unknown>): string[] {
    const roots: string[] = []
    if (this.cmdModeCwd) roots.push(this.cmdModeCwd)
    const project = useProjectStore.getState().currentProject?.path
    if (project) roots.push(project)
    const out: string[] = []
    for (const key of ['file_path', 'path', 'old_path', 'new_path', 'source', 'destination']) {
      const v = input[key]
      if (typeof v !== 'string' || !v.trim()) continue
      let rel = v.trim()
      for (const root of roots) {
        if (rel.startsWith(root + '/')) {
          rel = rel.slice(root.length + 1)
          break
        }
      }
      rel = rel.replace(/^\.\//, '')
      if (rel) out.push(rel)
    }
    return out
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    toolCallId?: string,
    signal?: AbortSignal,
    memoryScope?: string | null,
  ): Promise<string> {
    const requestedToolName = toolName
    toolName = canonicalToolName(toolName)
    input = normalizeToolInputForCanonical(requestedToolName, input)
    // Encaminhamento por ARGUMENTOS (ex.: Bash com run_in_background) — ver a
    // nota em routeTrainedToolCall.
    toolName = routeTrainedToolCall(requestedToolName, toolName, input)

    const tool = this.tools.get(toolName)
    if (!tool) {
      // Dialecto de treino com contrato divergente: em vez de um beco sem
      // saída ("Unknown tool: TodoWrite"), nomeia o substituto E a forma dos
      // argumentos — recuperação num turno em vez de tentativa às cegas.
      const guidance = DIVERGENT_TRAINED_TOOLS[requestedToolName]
      if (guidance) {
        return `Error: "${requestedToolName}" is not a tool in this IDE (it is a Claude Code name). Use ${guidance}`
      }
      throw new Error(`Unknown tool: ${toolName}`)
    }

    // Per-invocation memory scope — passed by SafeToolPool via execute().
    // Memory tools read from execInput._memoryScope (via getMemoryScope(input)
    // helper in memoryOps.ts). Always reset to prevent leakage between
    // main-agent and sub-agent tool calls.
    this.memoryScopeAgentType = memoryScope ?? null

    // Phase B: pre-check abort signal at entry. If the loop already cancelled
    // before this tool got dispatched (e.g., user hit ESC during streaming),
    // skip permission prompts and execution entirely. Tools that have
    // expensive side effects (subprocess spawn, network) check the signal
    // again mid-execution via input._abortSignal — that's their job.
    if (signal?.aborted) {
      return `Tool ${toolName} aborted before execution (user cancelled).`
    }

    // ── Claims de propriedade (registry ÚNICO main+tarefas — fileClaims.ts).
    // Verificado AQUI para todos os agentes: main a tentar mexer no ficheiro
    // de uma tarefa viva, ou tarefa a mexer no do main/de outra tarefa. Antes
    // das permissões: não vale a pena pedir autorização para algo bloqueado.
    if (ToolExecutor.CLAIM_WRITE_TOOLS.has(toolName)) {
      const claimOwner = this.permissionOrigin?.taskId ?? MAIN_CLAIM_OWNER
      for (const rel of this.relWriteTargets(input)) {
        const blocking = findBlockingClaim(rel, claimOwner)
        if (blocking) {
          const guidance = claimOwner === MAIN_CLAIM_OWNER
            ? `Do NOT modify it now — steer that task if the change belongs to it, or wait for it to finish, and tell the developer why this part was skipped.`
            : `Do NOT modify it or work around the block. Skip this part of the task and explain it in your final report.`
          throw new Error(
            `BLOCKED (file ownership): "${rel}" is being modified by ${blocking.owner === MAIN_CLAIM_OWNER ? blocking.label : `another parallel task ("${blocking.label}")`}. ${guidance}`,
          )
        }
      }
    }

    // PAUSA GLOBAL (2026-06-11, pedido do user): enquanto houver QUALQUER
    // intervenção obrigatória do utilizador pendente — prompt de permissão,
    // ask_user_question, request_credentials, aprovação de diff — NENHUM
    // outro tool pode começar a executar. Sem isto, tool calls paralelas
    // (concurrencySafe) e safe-tools auto-aprovadas continuavam a correr
    // por trás do diálogo, nos dois modos. Não há deadlock: o tool que CRIA
    // o gate já passou esta entrada (o seu prompt abre depois), e todos os
    // gates são resolvidos pelo utilizador ou limpos no cancelLoop.
    await this.waitForUserGates(signal, toolCallId)
    if (signal?.aborted) {
      return `Tool ${toolName} aborted before execution (user cancelled).`
    }

    // Malformed args: streaming truncated the JSON and we couldn't fully
    // repair it. Rather than pass incomplete args to Tauri (which produces
    // cryptic serde errors like "missing required key query"), return a
    // clear error so the model can retry with correct arguments.
    if (input._parseError === true) {
      const raw = (input._raw as string) || ''
      // Try one last repair — our repairPartialJson is in agentService, but
      // a simple regex fallback works for the common truncation case.
      const repaired = raw
        .replace(/,\s*([}\]])/g, '$1')  // trailing commas
      // Count unescaped quotes to detect unclosed strings
      const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length
      let closed = repaired
      if (quoteCount % 2 !== 0) closed += '"'
      // Close unclosed braces
      const opens: string[] = []
      for (const ch of closed) {
        if (ch === '{' || ch === '[') opens.push(ch)
        if (ch === '}' && opens.length && opens[opens.length - 1] === '{') opens.pop()
        if (ch === ']' && opens.length && opens[opens.length - 1] === '[') opens.pop()
      }
      for (let i = opens.length - 1; i >= 0; i--) {
        closed += opens[i] === '{' ? '}' : ']'
      }
      try {
        const repairedArgs = JSON.parse(closed)
        // Success! Use the repaired args, flagging them as partial so
        // downstream code knows some values may be truncated.
        input = { ...repairedArgs, _parseError: 'partial' }
      } catch {
        // Even repair failed — give the model a useful error message.
        const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw
        return `Error: tool arguments could not be parsed (streaming truncated the JSON). Raw args preview: ${preview}\n\nPlease retry the tool call with properly formatted JSON arguments. Ensure all required parameters (e.g., "query" for search_in_files) are provided.`
      }
    }

    // Passive tools: handled server-side by the provider (DashScope/Qwen native tools).
    // The `passive` flag on the tool definition declares this — no hardcoded Set to maintain.
    // These are defined in the tool schema so the model can call them, but the
    // provider executes them internally — the frontend never runs an execute handler.
    // When the model calls a passive tool, the provider returns results directly
    // in the API response. If we reach here, it means the model called a passive
    // tool but the provider didn't handle it (e.g., wrong model). Return a skip notice.
    if (tool.definition.passive) {
      return `Tool ${toolName} is a server-side tool managed by the AI provider. It was not executed locally. Ensure the active model supports this tool natively (e.g., Qwen 3.6 on DashScope).`
    }

    // .env files are ALWAYS blocked — read, write, edit, delete, and SEARCH.
    //
    // `directory` is in the list because search_files/Grep accept "a directory
    // OR a single file to search within": pointing them straight at .env was a
    // clean bypass of this seal (auditoria 2026-07-28) — auto-approved, no
    // dialog, secrets returned as match lines. Broad searches that merely
    // *contain* a .env are handled at the source, in search.rs.
    const filePath = (input.file_path || input.oldPath || input.directory || '') as string
    if (this.isEnvFile(filePath) && ['read_file', READ_AROUND, 'write_file', 'edit_file', 'create_file', 'delete_file', 'rename_file', 'search_files', 'glob'].includes(toolName)) {
      return 'Blocked: .env is sealed (it holds secrets) — the agent cannot read or write it. This block is by design and is NOT a sign that a key is missing. To supply a credential, call request_credentials (it writes straight to .env); once it returns "Credentials saved to .env", that key IS present — trust that result, do not re-read .env to verify, and never ask the developer to edit .env by hand. A .env.example with placeholder values is fine for documentation only.'
    }

    // Same seal, shell surfaces. A path-based check cannot see `cat .env`, so
    // the command TEXT is screened (see commandReferencesSealedEnv).
    const commandText = (
      toolName === 'agent_shell_write' ? input.input : input.command
    ) as string | undefined
    if (
      commandText &&
      SHELL_COMMAND_TOOLS.has(toolName) &&
      commandReferencesSealedEnv(String(commandText))
    ) {
      return 'Blocked: .env is sealed (it holds secrets) — shell commands may not read it either, and this block holds in every permission mode. It is NOT a sign that a key is missing. To supply a credential, call request_credentials (it writes straight to .env); once it returns "Credentials saved to .env", that key IS present — trust that result instead of verifying by hand. To check which keys a project EXPECTS, read .env.example. If the file only needs to be handed to another program, pass it via --env-file (allowed) or ask the developer to run that command themselves.'
    }

    // Path scope check — file tools targeting paths outside all allowed
    // roots (project + additionalDirectories) prompt the user for access.
    const FILE_SCOPE_TOOLS = new Set([
      'read_file', READ_AROUND, 'write_file', 'edit_file', 'create_file',
      'create_directory', 'delete_file', 'rename_file',
      'list_directory', 'search_files', 'glob',
      'execute_command', 'execute_command_background', 'agent_shell_start'
      // NOTA: copy_file / path_exists / append_file estavam aqui e NÃO existem
      // — nunca foram registadas (auditoria 2026-07-28). Uma lista de scope com
      // tools inventadas dá falsa sensação de cobertura: parece que o clamp de
      // caminhos protege mais superfícies do que as que existem. Ao acrescentar
      // uma tool que recebe caminhos, acrescenta-a AQUI e regista-a de facto.
    ])
    const pathForScope = (input.file_path || input.oldPath || input.directory || input.cwd || '') as string
    if (pathForScope && FILE_SCOPE_TOOLS.has(toolName)) {
      const scopeCheck = this.checkPathScope(pathForScope)
      if (!scopeCheck.allowed) {
        const decision = await getAgentHost()
          .requestPathAccess(pathForScope, scopeCheck.directoryToAdd, this.runProjectContext?.projectId)
        this.recordPermission(toolCallId, decision)
        if (!decision.approved) {
          // Uma negação chega SEMPRE do diálogo humano (source:'user'): YOLO
          // aprova sempre, nunca nega — por isso só há o ramo humano aqui.
          const reason = decision.denyReason
            ? ` User says: ${decision.denyReason}`
            : ' Ask the user how to proceed.'
          return `Blocked: "${pathForScope}" is outside the ${scopeCheck.scopeName}.${reason}`
        }
      }
    }

    // /plan architect mode — block implementation tools so the architect role
    // cannot drift into building the project. The model's *system prompt*
    // already forbids these (see planCommand.ts:buildArchitectSystemPrompt),
    // but strong-prior models (instruction-tuned for "build the thing") have
    // been observed to reach for implementation tools on turn 1 anyway. The
    // mechanical block returns an instructive error the model has to read in
    // its next tool result, redirecting it back onto PLAN.md.
    if (this.planMode) {
      const planBlock = this.checkPlanModeAccess(toolName, filePath)
      if (planBlock) return planBlock

      // M4b — update_tasks must follow write_file('<plan artefact>').
      // The task list mirrors the plan's Implementation Phases; without a
      // written plan the tasks have no source-of-truth to derive from.
      if (toolName === 'update_tasks' && !this.planFileWritten) {
        return `Blocked in /plan architect mode: ${toolName} must follow ${WRITE_ALIAS}('${this.planModePlanFileName}'). The task list mirrors ${this.planModePlanFileName}'s Implementation Phases — write the plan first, then derive tasks from its phase structure (one task per coherent unit of work, IDs like "1.1", "1.2", "2.1" matching the phase numbering). Calling update_tasks before ${WRITE_ALIAS} is a contract violation.`
      }
      if (toolName === 'update_tasks' && !(await this.isPlanReadyForTaskSeed())) {
        return `Blocked in /plan architect mode: ${toolName} must follow the final edit that flips ${this.planModePlanFileName} to "Status: PENDING APPROVAL". The task list must derive from the completed plan, not from a draft scaffold. Finish every plan section, flip the status, then call update_tasks.`
      }

      // M5 — Strict STOP after both PLAN.md and update_tasks have completed.
      // The architect's role is finished; any further tool call drifts into
      // implementation. The next phase (TODO generation, then execution) runs
      // in a fresh turn after the developer approves the plan card.
      if (this.planFileWritten && this.planTasksSeeded) {
        return `Blocked in /plan architect mode: ${this.planModePlanFileName} is written and the task tracker is seeded. Your role for this turn is complete. Stop calling tools and end the turn with a 3-sentence chat summary — TODO generation runs after the developer approves the plan card.`
      }
    }

    // Sensitive files require explicit developer authorization.
    //
    // MESMO fallback que o handler do read_around usa (`file_path ?? path`).
    // Ler só `file_path` não era apenas a causa do crash: uma chamada em
    // estilo `path` passava a saltar a verificação de sensibilidade por
    // inteiro — `read_around({ path: '~/.ssh/id_rsa' })` deixaria de pedir
    // autorização. O gate tem de ver o mesmo caminho que a tool vai abrir.
    const sensitivePath = (input.file_path ?? input.path) as string | undefined
    const isSensitive = (toolName === 'read_file' || toolName === READ_AROUND) && this.isSensitiveFile(sensitivePath)

    // Apagar o que o git não restaura força SEMPRE o diálogo, mesmo com
    // delete_file já concedido para a sessão (sessão momenu-fact 2026-07-28:
    // 14 delete_file seguidos sobre `functions/lib/*.js`).
    //
    // Não é bloqueio: limpar um build partido é legítimo e o humano decide. É
    // a assimetria que justifica o prompt — um ficheiro RASTREADO apagado por
    // engano volta com `git checkout --`; um ignorado não volta de lado
    // nenhum. O grant de scope não pode cobrir o caso irreversível.
    //
    // Deliberadamente SEM flag de override na mensagem de recusa: a lição do
    // mesmo incidente é que uma guarda que documenta o seu próprio contorno
    // vira lomba (a nota do glob ensinava `includeIgnored: true` e o modelo
    // usou-a três vezes). Quem levanta isto é o humano no diálogo, não o
    // modelo num parâmetro.
    const deletionRisk = await this.classifyDeletionRisk(toolName, input)

    // Dangerous commands: all commands in the DANGEROUS_COMMANDS list.
    // - YOLO ON → Settings hard-block + forcePrompt ignored (user accepted risk).
    // - YOLO OFF + BLOCKED in Settings → rejected immediately (never runs)
    // - YOLO OFF + not blocked → always prompts Yes/No (forcePrompt)
    // - Commands NOT in the list → normal permission flow
    //
    // As TRÊS superfícies de shell passam por aqui (auditoria 2026-07-28): o
    // gate só olhava para execute_command, portanto o gémeo em background
    // — `execute_command_background("rm -rf …")` — auto-aprovava por scope
    // exatamente onde a versão em primeiro plano forçava um Yes/No, e o
    // agent_shell_write escapava por completo.
    let dangerousAlreadyApproved = false
    if (SHELL_COMMAND_TOOLS.has(toolName)) {
      const commandStr = (
        toolName === 'agent_shell_write' ? input.input : input.command
      ) as string || ''
      const dangerousMatch = this.matchDangerousCommand(commandStr)
      if (dangerousMatch) {
        const { isYoloModeEnabled } = await import('../../stores/permissionStore')
        const yolo = isYoloModeEnabled(this.runProjectContext?.projectId)
        if (!yolo) {
          const { flaggedCommands } = useSettingsStore.getState()
          if (flaggedCommands.includes(dangerousMatch)) {
            return `Blocked: "${dangerousMatch}" is blocked in your Settings. The developer disabled this command. Ask the developer to unblock it in Settings > Sandbox if needed.`
          }
        }
        // YOLO: still record an auto-approval; OFF: forcePrompt dialog.
        const decision = await getAgentHost().canUseTool(
          toolName, input, 'dangerous_command', this.resolvePermissionOrigin(),
        )
        this.recordPermission(toolCallId, decision)
        if (!decision.approved) {
          const reason = decision.denyReason
            ? ` User says: ${decision.denyReason}`
            : ' Ask the user what they want instead.'
          return `Permission denied by user for ${dangerousMatch}.${reason}`
        }
        // RACE FIX: o utilizador pode ter feito stop ENQUANTO o diálogo
        // estava aberto e o clique de aprovação correr contra o abort. A
        // aprovação não pode ressuscitar um run cancelado — re-verificar o
        // signal DEPOIS do await, não só à entrada do execute().
        if (signal?.aborted) {
          return `Tool ${toolName} aborted before execution (user cancelled).`
        }
        dangerousAlreadyApproved = true
      }
    }

    // Agent-internal tools + tools that surface their own confirmation UI:
    // bypass the generic permission dialog. update_tasks/check_team/task
    // are autonomous; request_credentials renders a secure form in the chat
    // (Save/Skip is the gate, not the permission dialog); ask_user_question
    // renders an interactive question card (Submit/Cancel is the gate).
    const PERMISSION_EXEMPT_TOOLS = new Set([
      'update_tasks',
      'collect_results',
      'delegate',
      'check_background_commands',
      'agent_shell_read',
      'agent_shell_stop',
      'request_credentials',
      'ask_user_question',
    ])

    if (!dangerousAlreadyApproved && !PERMISSION_EXEMPT_TOOLS.has(toolName)) {
      const promptReason = deletionRisk.kind !== 'none'
        ? (deletionRisk.kind === 'generated' ? 'generated_file' : 'untracked_file')
        : isSensitive ? 'sensitive_file' : false
      const decision = await getAgentHost().canUseTool(toolName, input, promptReason, this.resolvePermissionOrigin())
      this.recordPermission(toolCallId, decision)
      if (!decision.approved) {
        const target = (input.file_path || input.command || input.name || '') as string
        // Negação sempre humana (ver nota no gate de path-scope acima).
        // Cada ramo diz apenas o que é VERDADE para o seu caso: só o primeiro
        // sabe que aquilo é output de build, e só ele pode aconselhar
        // "muda a fonte". Ver classifyDeletionRisk.
        const reason = decision.denyReason
          ? ` User says: ${decision.denyReason}`
          : deletionRisk.kind === 'generated'
            // A recusa de um artefacto gerado é a ocasião para corrigir o
            // raciocínio, não só para dizer não: sem isto o modelo tenta o
            // ficheiro seguinte da mesma lista, que foi o que aconteceu.
            ? ` ${target} is build output — the project declares it generated (${deletionRisk.declaredBy}), and it is untracked, so git cannot restore it. Deleting artifacts by hand is also futile: the next build regenerates them. If the goal is to remove this code, remove its SOURCE and let the build follow; if the sources are already gone, say so and leave the stale artifacts alone.`
            : deletionRisk.kind === 'ignored'
              ? ` ${target} is untracked (gitignored), so git cannot restore it — there is no history to revert to. Do not retry other paths in the same batch on the assumption that untracked means disposable; ask the developer what should happen to it.`
              : ' Ask the user what they want instead or suggest an alternative approach.'
        return `Permission denied by user for ${toolName}${target ? ` (${target})` : ''}.${reason}`
      }
      // RACE FIX: aprovação que chega depois de um stop não pode executar a
      // tool num run morto — re-verificar o signal DEPOIS do await (a
      // verificação à entrada do execute() aconteceu antes do diálogo).
      if (signal?.aborted) {
        return `Tool ${toolName} aborted before execution (user cancelled).`
      }
    }

    // Inject per-call context. Tools read these out of `input` when they
    // need them — no singleton state on ToolExecutor, so concurrent
    // invocations don't race.
    //   _toolCallId  → for checkpoint/progress reporting
    //   _abortSignal → for tools that can honor mid-flight cancellation
    //                  (execute_command, web_fetch, install commands).
    //                  Fast read-only tools just check it once at entry.
    const execInput: Record<string, unknown> = { ...input }
    if (toolCallId) execInput._toolCallId = toolCallId
    if (signal) execInput._abortSignal = signal
    // Per-call memory scope — sub-agent runner passes this so memory tools
    // scope writes correctly without shared mutable state.
    if (memoryScope) execInput._memoryScope = memoryScope

    const result = await tool.execute(execInput)

    // Claim de propriedade após aplicação sem throw — main e tarefas entram
    // no MESMO registry (fileClaims); tarefas são espelhadas em
    // run.modifiedFiles para UI/persistência.
    if (ToolExecutor.CLAIM_WRITE_TOOLS.has(toolName)) {
      const claimOwner = this.permissionOrigin?.taskId ?? MAIN_CLAIM_OWNER
      for (const rel of this.relWriteTargets(input)) registerFileClaim(claimOwner, rel)
    }

    // Reactive git refresh — see GIT_MUTATING_TOOLS. Fire-and-forget; blocked
    // and permission-denied calls returned earlier, so this only fires for
    // tools that actually ran.
    if (GIT_MUTATING_TOOLS.has(toolName) && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('git:refreshGutter', { detail: '' }))
    }

    // Diff results must never be truncated — the UI needs full JSON for InlineDiff,
    // and agentService needs it for approval and readFileTimestamps updates.
    try {
      const parsed = JSON.parse(result)
      if (parsed?.type === 'diff') return result
    } catch { /* not JSON — proceed to truncation */ }
    // read_large_result already produced a model-bounded slice (limit ≤ 25000) +
    // a continuation suffix. Passing it through truncateResult would nest a new
    // large_result every time the slice + suffix exceeds the threshold —
    // the model then chases pagination of pagination, doubling content in
    // context and starving the output budget before write_file lands.
    if (toolName === 'read_large_result') return result
    // Token-reduction phase (2026-06-26): per-tool limits so heavy outputs
    // (command logs, search dumps) enter the cumulative history at a fraction
    // of their raw size. The full body is preserved in the large_result store
    // and the model can page it via read_large_result when it actually needs
    // the rest. read_file gets a larger head preview (8K) because file
    // content is the most likely to be needed verbatim; execute_command gets
    // a TAIL preview because errors and exit code live at the bottom.
    const toolMaxChars = ToolExecutor.getToolResultMaxChars(toolName)
    const toolPreviewBudget = toolName === 'read_file' || toolName === READ_AROUND ? 8_000 : 2_000
    const toolPreviewFromEnd = toolName === 'execute_command' || toolName === 'execute_command_background' || toolName === 'check_background_commands'
    return this.truncateResult(result, toolMaxChars, toolPreviewBudget, toolPreviewFromEnd)
  }

  /** Number of core (non-MCP) tools registered. */
  getCoreToolCount(): number {
    return Array.from(this.tools.keys()).filter(k => !k.startsWith('mcp__')).length
  }

  /**
   * Returns true iff the tool is safe to execute in parallel with other
   * concurrency-safe tools. Gates the loop's parallel dispatch (query.ts).
   * Unknown tools default to false (serial) — defensive.
   */
  isConcurrencySafe(toolName: string): boolean {
    // Canonicaliza porque o modelo emite o nome de TREINO (`Read`) e o registo
    // é indexado pelo canónico. Sem isto, o despacho paralelo do loop deixava
    // de reconhecer como seguras exactamente as tools que ele mais chama — os
    // callers tinham de fazer a dupla chamada à mão, o que só funciona quando
    // alguém se lembra dela.
    const key = this.tools.has(toolName) ? toolName : canonicalToolName(toolName)
    return this.tools.get(key)?.definition.concurrencySafe === true
  }

  /**
   * Schema enviado ao modelo. É AQUI que a renomeação para o dialecto de
   * treino acontece — ver ADVERTISED_TOOL_NAMES. Internamente tudo continua a
   * chamar-se como sempre se chamou (chaves do registo, gates, grants); o
   * modelo passa a ver `Read`/`Grep`/`Bash`/`Edit`, que é o que ele já emitia
   * por treino. O caminho de volta é o `canonicalToolName` do execute().
   */
  getToolDefinitions(): OpenAIToolDefinition[] {
    // Defs diferidos (MCP) ficam de fora — são carregados pelo modelo via
    // `load_tools` (ver getDeferredToolIndex/getDeferredToolDefinitions).
    return Array.from(this.tools.values())
      .filter(t => !t.deferred)
      .map(t => ({
        type: 'function' as const,
        function: {
          name: advertisedToolName(t.definition.name),
          description: t.definition.description,
          parameters: t.definition.input_schema
        }
      }))
  }

  /**
   * Nomes + descrição dos defs diferidos. A descrição serve o SCORING da
   * keyword search do ToolSearch (searchDeferredTools em toolPolicy.ts) —
   * nunca é enviada em índices ao modelo: as tools diferidas anunciam-se só
   * pelo nome (contrato cli-vaz; o A/B de hints não mostrou benefício).
   */
  getDeferredToolIndex(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values())
      .filter(t => t.deferred)
      .map(t => ({
        name: advertisedToolName(t.definition.name),
        description: t.definition.description,
      }))
  }

  /**
   * Defs completos de tools diferidas, por nome anunciado. Chamado pelo
   * bridge quando o modelo pede `ToolSearch` — os defs devolvidos são
   * devolvidos no bloco <functions> E empurrados para o array vivo do run.
   * Nomes desconhecidos (ou não diferidos) voltam em `missing`.
   */
  getDeferredToolDefinitions(names: string[]): { defs: OpenAIToolDefinition[]; missing: string[] } {
    const defs: OpenAIToolDefinition[] = []
    const missing: string[] = []
    for (const name of names) {
      const entry = this.tools.get(name) ?? this.tools.get(canonicalToolName(name))
      if (entry?.deferred) {
        defs.push({
          type: 'function' as const,
          function: {
            name: advertisedToolName(entry.definition.name),
            description: entry.definition.description,
            parameters: entry.definition.input_schema,
          },
        })
      } else {
        missing.push(name)
      }
    }
    return { defs, missing }
  }

  /**
   * Registers MCP tools, replacing any previously registered MCP tools.
   * Tool names use double-underscore separator: mcp__serverName__toolName
   */
  registerMCPTools(mcpTools: MCPTool[], callToolFn: (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<string>): void {
    // Remove old MCP tools
    for (const [name] of this.tools) {
      if (name.startsWith('mcp__')) {
        this.tools.delete(name)
      }
    }

    // Orçamento das descrições ANTES de registar: são texto de terceiros que
    // segue em TODOS os pedidos dentro das tool definitions. Sem teto, ligar
    // um MCP gerado por OpenAPI degradava todos os turnos da sessão sem que
    // nada na UI o mostrasse. Só a descrição é cortada — o input_schema segue
    // intacto (ver mcpDescriptionBudget.ts, "ÂMBITO").
    const { tools: budgetedMcpTools, stats: mcpBudgetStats } = budgetMcpDescriptions(mcpTools)
    if (mcpBudgetStats.truncated > 0 || mcpBudgetStats.omitted > 0) {
      logger.warn(
        'MCP',
        `descrições orçamentadas: ${mcpBudgetStats.truncated} truncada(s), ` +
        `${mcpBudgetStats.omitted} omitida(s), ${mcpBudgetStats.totalChars} chars totais`,
      )
    }

    // Register new MCP tools
    for (const tool of budgetedMcpTools) {
      const fullName = `mcp__${tool.serverName}__${tool.name}`
      // Browser tools share a single trust gate: the user already opted into
      // the /te2e command, which is itself a slash command they explicitly
      // typed. Per-action permission prompts (Antigravity-style) were tried
      // and removed — they fragmented sessions into hundreds of Y/N clicks
      // for no observable safety gain (the browser is sandboxed in its own
      // profile dir, isolated from the user's real Chrome). beginSession is
      // still called to hide the preview pane so the two webviews don't
      // compete for attention.
      const isBrowserTool = tool.serverName === 'browser'

      this.tools.set(fullName, {
        // Diferido: o schema só viaja depois de o modelo o carregar via
        // `load_tools`. Ver a nota no ToolEntry — a execução não é afectada.
        deferred: true,
        definition: {
          name: fullName,
          description: `[MCP: ${tool.serverName}] ${tool.description}`,
          input_schema: tool.inputSchema as ToolDefinition['input_schema'],
          // MCP spec annotations.readOnlyHint → safe to run in parallel with
          // other read-only tools. Defensive default: serial when unset, so
          // mutating MCP tools never accidentally race. Browser tools stay
          // serial because the model usually drives them in tight observe-
          // then-act pairs where parallelism wouldn't help anyway.
          concurrencySafe: !isBrowserTool && tool.readOnlyHint === true,
        },
        execute: async (input: Record<string, unknown>) => {
          if (isBrowserTool) {
            // Hide the user's preview before the very first browser action
            // of this turn so the two webviews don't compete for attention.
            const { browserSession } = await import('../browserSessionManager')
            await browserSession.beginSession()
          }
          // BACKSTOP anti-pendura (auditoria 2026-07-28): um servidor MCP
          // encravado nunca devolve nada e o turno ficava preso para SEMPRE —
          // as tools locais têm todas os seus próprios tetos; o caminho MCP
          // era o único sem nenhum. 10 min é rede de segurança contra o
          // infinito, não um timeout afinado — e o relógio PÁRA enquanto um
          // diálogo de permissão/diff/credenciais está aberto (política do
          // projecto: espera por humano é ilimitada).
          const timeout = createPermissionAwareTimeout(fullName, MCP_TOOL_TIMEOUT_MS)
          try {
            return await Promise.race([
              callToolFn(tool.serverName, tool.name, input),
              timeout.promise,
            ])
          } finally {
            timeout.cleanup()
          }
        },
      })
    }
  }

  /** Large result storage — maps reference IDs to full content for later retrieval. */
  private largeResults: Map<string, string> = new Map()
  private largeResultCounter = 0
  /** Disk directory for persisting large results across session reloads.
   *  Set by setLargeResultsDir() when a session is loaded. When null,
   *  disk persistence is disabled (in-memory only). */
  private largeResultsDir: string | null = null
  /** Incremental byte counter kept in sync with `largeResults` set/delete
   *  ops. Avoids the O(N) `for ... values()` total-scan that the byte-cap
   *  eviction loop used to do on every `truncateResult` call. */
  private largeResultsTotalBytes = 0
  /** Per-id ranges already shown to the model (S1: overlap warnings on
   *  re-read). Stored as `[offset, end)` pairs MERGED on insert — so
   *  three sequential reads (0-2k, 2k-4k, 4k-6k) collapse to a single
   *  [0, 6000) instead of fragmenting. The whole entry is dropped when
   *  the large result itself is evicted. */
  private largeResultRangesShown: Map<string, Array<[number, number]>> = new Map()
  /** Approximate cap on total bytes held across all cached large results
   *  (S2). When a new result would push past the cap, the oldest entries
   *  are evicted until we fit. Independent from the entry-count cap below. */
  private static readonly LARGE_RESULT_MAX_BYTES = 8 * 1024 * 1024 // 8MB
  private static readonly LARGE_RESULT_MAX_ENTRIES = 20
  private static readonly READ_FILE_MAX_BYTES = 256 * 1024

  /**
   * Per-tool max-chars limit for the result that enters the model's context
   * (token-reduction phase, 2026-06-26). Results exceeding this go to the
   * large_result store; the model gets a bounded preview + a read_large_result
   * ref to page the rest on demand. Heavy-output tools (command logs, search
   * dumps) get tighter limits than file reads, because their content is less
   * likely to be needed verbatim on subsequent turns.
   */
  static getToolResultMaxChars(toolName: string): number {
    toolName = canonicalToolName(toolName)
    switch (toolName) {
      case 'execute_command':
      case 'execute_command_background':
      case 'check_background_commands':
        return 8_000
      case 'search_files':
        return 8_000
      case READ_AROUND:
      case 'read_file':
        // claude-vaz parity (FileReadTool limits.ts): ~25k TOKENS per read
        // (~100k chars), not 12k chars. The old cap forced every real file
        // through preview+paging round-trips — the model kept "re-reading"
        // because no single read ever satisfied it. Anthropic A/B-tested
        // capping reads harder and REVERTED: mean tokens went UP, because
        // paginated re-reads cost more than one complete read.
        return 100_000
      case 'edit_file':
      case 'write_file':
      case 'create_file':
        return 12_000
      case CAPTURE_URL_DESIGN:
        // Design handoffs are long on purpose (layout + palette + verbatim text).
        return 24_000
      case 'web_fetch':
        // O schema anuncia `maxLength` com default 50000; sem este ramo a tool
        // caía no default de 12k e a página chegava como um preview de 2k
        // (auditoria 2026-07-28), obrigando a paginar documentação que o modelo
        // tinha pedido inteira. O limite do schema é que manda.
        return 50_000
      default:
        return 12_000
    }
  }

  private static sliceReadFileRange(
    fullRead: ReadFileWithSignatureResult,
    offset: number,
    limit: number | undefined,
  ): ReadFileRangeWithSignatureResult {
    const lines = fullRead.content.length > 0 ? fullRead.content.split('\n') : []
    const startLine = Math.max(1, offset)
    const start = startLine - 1
    const end = limit !== undefined ? Math.min(start + Math.max(1, limit), lines.length) : lines.length
    const selected = start < lines.length ? lines.slice(start, end) : []

    return {
      content: selected.join('\n'),
      signature: fullRead.signature,
      startLine,
      lineCount: selected.length,
      totalLines: lines.length,
      hasMore: end < lines.length,
    }
  }

  private async readFileRange(input: {
    filePath: string
    offset: number
    limit: number
    limitProvided: boolean
    preStat?: { size: number; modifiedMs: number | null }
  }): Promise<ReadFileRangeWithSignatureResult> {
    // claude-vaz parity: small regular files take the fast path
    // (read whole file, slice lines in memory). The native range scanner is
    // reserved for larger files where reading the whole body would be wasteful.
    if (input.preStat && input.preStat.size <= ToolExecutor.READ_FILE_MAX_BYTES) {
      try {
        const fullRead = await invoke<ReadFileWithSignatureResult>('read_file_with_signature', { path: input.filePath })
        return ToolExecutor.sliceReadFileRange(
          fullRead,
          input.offset,
          input.limitProvided ? input.limit : undefined,
        )
      } catch {
        // Fall through to the native range reader so the original filesystem
        // error path still gets a chance to produce a precise failure.
      }
    }

    const rangeArgs = {
      path: input.filePath,
      offset: input.offset,
      ...(input.limitProvided ? { limit: input.limit } : {}),
    }

    try {
      return await invoke<ReadFileRangeWithSignatureResult>('read_file_range_with_signature', rangeArgs)
    } catch (error) {
      const msg = formatError(error)
      const looksLikeRangePathOrCommandFailure =
        /not found|pathnotfound|no such file|does not exist|unknown command|command .*not.*found/i.test(msg)

      if (
        !looksLikeRangePathOrCommandFailure ||
        !input.preStat ||
        input.preStat.size > ToolExecutor.READ_FILE_MAX_BYTES
      ) {
        throw error
      }

      // Recovery path for the failure mode seen in exported sessions:
      // search/list can prove the file exists, but the native range reader
      // reports "not found". For small files, recover by reading the full
      // signature-aware body once and slicing in JS. Large files keep the
      // native-range error so we never silently dump huge files into memory.
      try {
        const fullRead = await invoke<ReadFileWithSignatureResult>('read_file_with_signature', { path: input.filePath })
        return ToolExecutor.sliceReadFileRange(
          fullRead,
          input.offset,
          input.limitProvided ? input.limit : undefined,
        )
      } catch {
        throw error
      }
    }
  }

  /**
   * Compute the line range that actually enters the model context for Read.
   * read_file results above the generic result cap are reduced later by
   * truncateResult() to an 8K head preview. The read-range tracker must only
   * record complete file lines in that preview, not the full internal disk
   * read; otherwise a later Read can be falsely blocked for lines the model
   * never saw.
   */
  private static getModelVisibleReadRange(input: {
    result: string
    fileBodyStart: number
    fileBodyLength: number
    startLine: number
    requestedOffset: number | undefined
    requestedLimit: number | undefined
  }): ReadVisibility {
    const maxChars = ToolExecutor.getToolResultMaxChars('read_file')
    if (input.result.length <= maxChars) {
      return {
        range: { offset: input.requestedOffset, limit: input.requestedLimit },
        partialView: false,
      }
    }

    const previewBudget = 8_000
    const lastNewline = input.result.lastIndexOf('\n', previewBudget)
    const previewEnd = lastNewline >= previewBudget * 0.5
      ? lastNewline + 1
      : Math.min(previewBudget, input.result.length)

    const fileStart = input.fileBodyStart
    const fileEnd = fileStart + input.fileBodyLength
    if (previewEnd <= fileStart || input.fileBodyLength <= 0) {
      return { range: null, partialView: true }
    }

    const visibleFileEnd = Math.min(previewEnd, fileEnd)
    const visibleFileText = input.result.slice(fileStart, visibleFileEnd)

    // A hard char cut inside a line does not make that source line safe to
    // mark as covered. The model saw only a prefix of the line.
    if (visibleFileEnd < fileEnd && !visibleFileText.endsWith('\n')) {
      return { range: null, partialView: true }
    }

    const visibleLineCount = visibleFileEnd >= fileEnd
      ? input.fileBodyLength === 0 ? 0 : input.result.slice(fileStart, fileEnd).split(/\r?\n/).length
      : (visibleFileText.match(/\n/g) ?? []).length

    if (visibleLineCount <= 0) {
      return { range: null, partialView: true }
    }

    return {
      range: { offset: input.startLine, limit: visibleLineCount },
      partialView: true,
    }
  }

  /**
   * Compact search-result formatter (token-reduction phase, 2026-06-26).
   * Replaces the old `JSON.stringify(result, null, 2)` which was ~3-4× larger
   * than necessary (every match carried context_before/context_after arrays,
   * full file_path repetition, JSON braces/indentation). Output is now:
   *
   *   Found N matches in M files (showing up to 50)
   *   path/to/file.ts:42:1: match_text
   *     context line (the text field)
   *   path/other.ts:100:5: another_match
   *     context line
   *
   * Format choice (2026-07-24 bench): domain grep stays the default even when
   * large-with-context dumps can be slightly fewer tokens as JSON mini — grep
   * lines are more model-native and avoid reintroducing JSON structure into
   * the transcript. Unexpected shapes fall back to jsonMini (never pretty).
   *
   * Handles both the { files: [...] } and bare-array shapes the Rust side can
   * return. Never throws — falls back to JSON on an unexpected shape.
   */
  private formatSearchResultsCompact(result: unknown): string {
    try {
      // Normalise: extract the files array from either a wrapper or bare array.
      let files: unknown[]
      let totalMatches: number | undefined
      let totalFiles: number | undefined

      if (Array.isArray(result)) {
        files = result
      } else if (result && typeof result === 'object') {
        const obj = result as Record<string, unknown>
        files = Array.isArray(obj.files) ? obj.files as unknown[] : []
        totalMatches = typeof obj.total_matches === 'number' ? obj.total_matches
          : typeof obj.totalMatches === 'number' ? obj.totalMatches : undefined
        totalFiles = typeof obj.total_files === 'number' ? obj.total_files
          : typeof obj.totalFiles === 'number' ? obj.totalFiles : undefined
      } else {
        // Unexpected shape — minified JSON (never pretty on the model path).
        return jsonMini(result)
      }

      if (files.length === 0) {
        return 'No matches found.'
      }

      const lines: string[] = []
      const matchCount = totalMatches ?? files.reduce<number>((sum, f) => {
        const m = (f as Record<string, unknown>)?.matches
        return sum + (Array.isArray(m) ? m.length : 0)
      }, 0)
      // `matchCount` é o que foi DEVOLVIDO, não o que existe: o Rust corta em
      // MAX_MATCHES_PER_FILE (10) por ficheiro. Dizer "Found 10 matches" sobre
      // um ficheiro com 60 fazia o modelo concluir que havia 10 usos e decidir
      // com base nisso (auditoria 2026-07-29). O `capped_at_file_limit` diz
      // quais ficheiros ficaram a meio.
      const cappedFiles = files.filter((f) => {
        const o = f as Record<string, unknown>
        return o.capped_at_file_limit === true || o.cappedAtFileLimit === true
      }).length
      const globalTruncated = !Array.isArray(result)
        && (result as Record<string, unknown>)?.truncated === true
      const header = `Found ${matchCount} match${matchCount === 1 ? '' : 's'} in ${totalFiles ?? files.length} file${files.length === 1 ? '' : 's'}`
      lines.push(cappedFiles > 0 || globalTruncated ? `${header} (PARTIAL)` : header)
      if (cappedFiles > 0) {
        lines.push(
          `⚠ ${cappedFiles} file${cappedFiles === 1 ? '' : 's'} hit the 10-matches-per-file cap — `
          + `the counts above are what was returned, NOT how many matches exist. `
          + `Use outputMode:"count" for true per-file totals, or narrow the query.`,
        )
      }
      if (globalTruncated) {
        lines.push(
          `⚠ The global result limit was reached — files after the last one listed were not searched. `
          + `Narrow with includePatterns or raise maxResults.`,
        )
      }
      // Ficheiros >1MB nunca foram procurados. O corte existia; o silêncio era
      // o defeito (auditoria 2026-07-29): um símbolo que só vive num bundle ou
      // num schema gerado dava "No matches found" e o modelo concluía que não
      // existe. Com o número à frente, ele sabe que há onde procurar.
      const skippedTooLarge = !Array.isArray(result)
        && typeof (result as Record<string, unknown>)?.skipped_too_large === 'number'
        ? (result as Record<string, unknown>).skipped_too_large as number
        : 0
      if (skippedTooLarge > 0) {
        lines.push(
          `⚠ ${skippedTooLarge} file${skippedTooLarge === 1 ? '' : 's'} over 1 MB `
          + `${skippedTooLarge === 1 ? 'was' : 'were'} NOT searched (size cap). If what you are looking for could live in a bundle, `
          + `minified output, a generated schema or a data dump, read that file directly with offset/limit instead of concluding it is absent.`,
        )
      }

      for (const file of files) {
        const f = file as Record<string, unknown>
        const filePath = (f.file_path ?? f.path ?? '?') as string
        const matches = Array.isArray(f.matches) ? f.matches as Record<string, unknown>[] : []
        for (const m of matches) {
          const lineNum = m.line_number ?? m.lineNumber ?? '?'
          const col = m.column ?? '?'
          const text = (m.text as string | undefined) ?? ''
          const matchText = (m.match_text as string | undefined) ?? ''
          const before = Array.isArray(m.context_before) ? m.context_before as string[] : []
          const after = Array.isArray(m.context_after) ? m.context_after as string[] : []
          // Format: path:line:col: match_text (one line, grep-like)
          const matchPart = matchText ? matchText.replace(/\n/g, ' ').slice(0, 120) : ''
          lines.push(`${filePath}:${lineNum}:${col}:${matchPart}`)
          const numericLine = typeof lineNum === 'number'
            ? lineNum
            : typeof lineNum === 'string'
              ? Number.parseInt(lineNum, 10)
              : Number.NaN
          if (Number.isFinite(numericLine) && before.length > 0) {
            before.forEach((ctxLine, i) => {
              const n = numericLine - before.length + i
              lines.push(`  ${n}: ${ctxLine.replace(/\n/g, '↵').slice(0, 200)}`)
            })
          }
          // Include the matching line as context (indented), trimmed.
          if (text) {
            const ctx = text.replace(/\n/g, '↵').slice(0, 200)
            lines.push(Number.isFinite(numericLine) ? `> ${numericLine}: ${ctx}` : `> ${ctx}`)
          }
          if (Number.isFinite(numericLine) && after.length > 0) {
            after.forEach((ctxLine, i) => {
              const n = numericLine + i + 1
              lines.push(`  ${n}: ${ctxLine.replace(/\n/g, '↵').slice(0, 200)}`)
            })
          }
        }
      }

      return lines.join('\n')
    } catch {
      // Fallback: never break the tool on a formatting error (minified, never pretty).
      return jsonMini(result)
    }
  }

  /**
   * Set the disk directory for large result persistence. Called when a
   * session is loaded so that large results survive session reloads.
   * Pass null to disable disk persistence (in-memory only).
   */
  setLargeResultsDir(dir: string | null): void {
    this.largeResultsDir = dir
  }

  /**
   * Persist a large result to disk (fire-and-forget). Writes to
   * `<largeResultsDir>/<refId>.txt`. Errors are silently ignored —
   * the in-memory Map is the primary store, disk is a fallback.
   */
  private persistLargeResultToDisk(refId: string, content: string): void {
    if (!this.largeResultsDir) return
    const path = `${this.largeResultsDir}/${refId}.txt`
    import('@/utils/invokeMetrics')
      .then(({ invoke }) => invoke('write_file', { path, content }))
      .catch(() => { /* disk persistence is best-effort */ })
  }

  /**
   * Read a large result from disk (async). Returns null if not found
   * or if disk persistence is disabled.
   */
  async readLargeResultFromDisk(refId: string): Promise<string | null> {
    if (!this.largeResultsDir) return null
    try {
      const { invoke } = await import('@/utils/invokeMetrics')
      const path = `${this.largeResultsDir}/${refId}.txt`
      return await invoke<string>('read_file', { path })
    } catch {
      return null
    }
  }

  /**
   * Handles large tool results: if the result exceeds the threshold,
   * stores the full output in memory and returns a reference with a preview.
   * The model can retrieve the full output via read_large_result tool.
   * This prevents information loss from truncation (like Claude Code's disk persistence).
   *
   * Token-reduction phase (2026-06-26): default maxChars lowered 30K→12K so
   * fewer chars enter the cumulative history. Per-tool limits are passed by
   * the caller via getToolResultMaxChars(). `previewFromEnd` serves command
   * output where the useful part (errors, exit code) is at the TAIL.
   */
  private truncateResult(
    result: string,
    maxChars: number = 12_000,
    previewBudget: number = 2_000,
    previewFromEnd: boolean = false,
  ): string {
    if (result.length <= maxChars) return result

    // Store full result in memory for later retrieval. Update the
    // incremental byte counter so eviction doesn't have to total-scan.
    const refId = `large_result_${++this.largeResultCounter}`
    this.largeResults.set(refId, result)
    this.largeResultsTotalBytes += result.length

    // Persist to disk (fire-and-forget) so large results survive session reloads.
    this.persistLargeResultToDisk(refId, result)

    // S2: byte-budget eviction. Pop oldest until we fit under the cap.
    // O(K) where K is the number of entries evicted, not O(N) like before.
    while (
      this.largeResultsTotalBytes > ToolExecutor.LARGE_RESULT_MAX_BYTES
      && this.largeResults.size > 1
    ) {
      this.evictOldestLargeResult()
    }

    // B4: count-cap eviction. Keep the most recent N entries.
    while (this.largeResults.size > ToolExecutor.LARGE_RESULT_MAX_ENTRIES) {
      this.evictOldestLargeResult()
    }
    const nearCap = this.largeResults.size >= ToolExecutor.LARGE_RESULT_MAX_ENTRIES - 2

    const totalSize = result.length > 1024
      ? `${(result.length / 1024).toFixed(1)}KB`
      : `${result.length} chars`

    // ── Build preview ──
    // Head preview (default): first N chars, cut at a line boundary at the END
    //   so the preview never ends mid-token. `previewFromEnd` flips to a TAIL
    //   preview (last N chars, cut at a line boundary at the START) — used for
    //   command output where errors and exit code live at the bottom.
    let preview: string
    let shownChars: number
    let omitted: number
    let continueOffset: number
    let isTail: boolean

    if (previewFromEnd) {
      const start = Math.max(0, result.length - previewBudget)
      // Cut at the START on a line boundary so the tail preview begins on a
      // whole line (same reasoning as the head case, mirrored).
      const nextNewline = result.indexOf('\n', start)
      const previewStart = nextNewline >= 0 && nextNewline < start + previewBudget * 0.5
        ? nextNewline + 1
        : start
      preview = result.slice(previewStart)
      shownChars = preview.length
      omitted = previewStart
      continueOffset = 0
      isTail = true
    } else {
      // Head: cut on a line boundary so the preview never ends mid-token.
      const lastNewline = result.lastIndexOf('\n', previewBudget)
      // Include the newline in the preview (cut AFTER it) so the preview is
      // whole lines and the continuation offset lands on the next line's first
      // char.
      const previewEnd = lastNewline >= previewBudget * 0.5
        ? lastNewline + 1
        : Math.min(previewBudget, result.length)
      preview = result.slice(0, previewEnd)
      shownChars = previewEnd
      omitted = result.length - previewEnd
      continueOffset = previewEnd
      isTail = false
    }

    // B4: cap-approaching nudge.
    const capNote = nearCap
      ? ` [warning: ${this.largeResults.size}/${ToolExecutor.LARGE_RESULT_MAX_ENTRIES} cached large results — oldest will be evicted as new ones arrive; save what you need now.]`
      : ''

    const positionLabel = isTail ? `last ${shownChars}` : `first ${shownChars}`
    const continueHint = isTail
      ? `Read from offset 0 for earlier output — call read_large_result("${refId}", offset: 0, limit: ${Math.min(omitted, 25000)}).`
      : `Continue from offset ${continueOffset} — call read_large_result("${refId}", offset: ${continueOffset}).`

    return `<system-reminder>Partial view: this tool produced ${totalSize} of output but only the ${positionLabel} characters are shown below, cut at a line boundary. ${continueHint} Do not reason about content outside this preview alone — it ends mid-output and the remainder may change the meaning.${capNote}</system-reminder>

${isTail ? 'Preview (last characters):' : `Preview (first ${shownChars} characters):`}
${preview}
<system-reminder>[end of partial view — ${omitted} more character${omitted === 1 ? '' : 's'} omitted; read_large_result("${refId}", offset: ${continueOffset}) for the rest]</system-reminder>
`
  }

  /**
   * Runs install commands via streaming (run_streaming_command) so the user
   * sees real-time logs in the chat via progressText.
   * Timeout vem do `timeout_secs` da chamada (default 300s) — instalar é lento
   * por natureza e um monorepo grande precisa de pedir mais.
   */
  private async executeInstallStreaming(
    command: string,
    cwd: string,
    toolCallId?: string,
    abortSignal?: AbortSignal,
    timeoutSecs: number = 300,
  ): Promise<string> {
    const tcId = toolCallId
    const allOutput: string[] = []

    // Register listeners BEFORE spawning
    let targetPid = 0
    let finished = false
    let resolveExit: (code: number) => void
    const exitPromise = new Promise<number>(res => { resolveExit = res })

    const bufferedOutput: { pid: number; data: string }[] = []
    const bufferedExit: { pid: number; code: number }[] = []

    const unOutput = await listen<{ pid: number; stream: string; data: string }>(
      'cmd-output',
      (event) => {
        if (targetPid === 0) {
          bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
        } else if (event.payload.pid === targetPid) {
          this.handleInstallOutput(event.payload.data, allOutput, tcId)
        }
      }
    )

    const unExit = await listen<{ pid: number; code: number }>(
      'cmd-exit',
      (event) => {
        if (targetPid === 0) {
          bufferedExit.push({ pid: event.payload.pid, code: event.payload.code })
        } else if (event.payload.pid === targetPid && !finished) {
          finished = true
          cleanup()
          resolveExit(event.payload.code)
        }
      }
    )

    const cleanup = () => { unOutput(); unExit() }

    try {
      if (tcId) {
        emitToolProgress({ kind: 'progress', toolCallId: tcId, text: 'Installing dependencies...' })
      }

      const pid = await invoke<number>('run_streaming_command', { command, cwd })
      targetPid = pid

      // Flush buffered events
      for (const ev of bufferedOutput) {
        if (ev.pid === pid) {
          this.handleInstallOutput(ev.data, allOutput, tcId)
        }
      }
      for (const ev of bufferedExit) {
        if (ev.pid === pid && !finished) {
          finished = true
          cleanup()
          resolveExit!(ev.code)
        }
      }

      // Race: exit vs timeout vs abort (user stops agent)
      const INSTALL_TIMEOUT = timeoutSecs * 1000
      let timeoutTimer: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<number>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error(`Install timed out after ${INSTALL_TIMEOUT / 1000}s`)), INSTALL_TIMEOUT)
      })

      // Phase B: honor the per-call abort signal threaded through `execute()`.
      // Replaces the brittle global `AgentService.getInstance().getAbortController()`
      // lookup, which couldn't distinguish parent vs sub-agent loops and
      // would race on instance reassignment. The signal is now per-call so
      // sub-agents and background agents get their own correct controller.
      const abortPromise = abortSignal
        ? new Promise<number>((_, reject) => {
            if (abortSignal.aborted) reject(new Error('aborted'))
            else abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        : new Promise<number>(() => {}) // never resolves

      let exitCode: number
      try {
        exitCode = await Promise.race([exitPromise, timeoutPromise, abortPromise]) as number
        clearTimeout(timeoutTimer!)
      } catch (raceErr) {
        clearTimeout(timeoutTimer!)
        cleanup()
        try { await invoke('kill_process', { pid: targetPid }) } catch { /* best effort */ }
        const msg = raceErr instanceof Error ? raceErr.message : String(raceErr)
        if (msg === 'aborted') {
          return `Install cancelled by user.\nExit code: 1\n\nThe install process was killed mid-execution. Dependencies in node_modules/ (or equivalent) may be partially installed or in an inconsistent state. Run the install command again to ensure all packages are correctly resolved before proceeding.`
        }
        return `TIMEOUT: ${msg}\n${allOutput.join('')}\nThe install process was killed.\n\nIMPORTANT: The install timed out. Tell the user to install dependencies manually by running the install command in the integrated terminal. Do NOT retry the install automatically.`
      }

      const fullOutput = allOutput.join('')

      if (exitCode === 0) {
        if (tcId) {
          emitToolProgress({ kind: 'progress', toolCallId: tcId, text: '' })
        }
        // Return summary for the model
        const lines = fullOutput.split('\n')
        const tail = lines.slice(-15).join('\n')
        return `${tail}\nExit code: 0\n\nDependencies installed successfully.`
      }

      // Failure: return full output for model to diagnose
      return `${fullOutput}\nExit code: ${exitCode}`
    } catch (error) {
      cleanup()
      const msg = error instanceof Error ? error.message : String(error)
      return `Failed to install dependencies: ${msg}`
    }
  }

  private handleInstallOutput(
    data: string,
    allOutput: string[],
    toolCallId: string | null | undefined,
  ): void {
    allOutput.push(data)
    if (!toolCallId) return

    // Accumulate full output into commandLogs for the shell log viewer.
    // Each chunk may contain multiple lines. Append in one store update to
    // avoid React/Zustand nested update explosions on verbose commands.
    const chunks = data.split('\n')
    emitToolProgress({ kind: 'command_logs', toolCallId, chunks })

    // Show the last meaningful line as progress (single-line summary).
    // Strip ANSI so the chip never shows raw [38;5;Nm color codes.
    const lines = data.trim().split('\n')
    const lastLine = stripAnsi(lines[lines.length - 1] || '')
    if (lastLine.length > 0) {
      const display = lastLine.length > 80 ? lastLine.slice(0, 80) + '...' : lastLine
      emitToolProgress({ kind: 'progress', toolCallId, text: display })
    }
  }

  /**
   * Runs build/test/lint/script commands via streaming (run_streaming_command)
   * so the user sees real-time log output in the chat via both `progressText`
   * (last-line summary) and `commandLogs` (full scrollable log).
   *
   * Similar to `executeInstallStreaming` but generalized for non-install commands
   * and with a shorter default timeout (120s vs 300s).
   */
  private async executeStreamingCommand(
    command: string,
    cwd: string,
    toolCallId?: string,
    abortSignal?: AbortSignal,
    timeoutSecs: number = 120,
  ): Promise<string> {
    const tcId = toolCallId
    const allOutput: string[] = []

    let targetPid = 0
    let finished = false
    let resolveExit: (code: number) => void
    const exitPromise = new Promise<number>(res => { resolveExit = res })

    const bufferedOutput: { pid: number; data: string }[] = []
    const bufferedExit: { pid: number; code: number }[] = []

    const unOutput = await listen<{ pid: number; stream: string; data: string }>(
      'cmd-output',
      (event) => {
        if (targetPid === 0) {
          bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
        } else if (event.payload.pid === targetPid) {
          this.handleInstallOutput(event.payload.data, allOutput, tcId)
        }
      }
    )

    const unExit = await listen<{ pid: number; code: number }>(
      'cmd-exit',
      (event) => {
        if (targetPid === 0) {
          bufferedExit.push({ pid: event.payload.pid, code: event.payload.code })
        } else if (event.payload.pid === targetPid && !finished) {
          finished = true
          cleanup()
          resolveExit(event.payload.code)
        }
      }
    )

    const cleanup = () => { unOutput(); unExit() }

    try {
      if (tcId) {
        emitToolProgress({ kind: 'progress', toolCallId: tcId, text: 'Running...' })
      }

      const pidOrResult = await invoke<number | { stdout: string; stderr: string; exitCode: number; success: boolean; timedOut: boolean }>('run_streaming_command', { command, cwd })
      if (typeof pidOrResult !== 'number') {
        cleanup()
        const result = pidOrResult
        if (result.timedOut) {
          return `TIMEOUT: Command exceeded ${timeoutSecs}s limit and was terminated.\nFor long-running processes, use start_dev_server instead.\nSTDERR:\n${result.stderr}`
        }
        let output = ''
        if (result.stdout) output += result.stdout
        if (result.stderr) output += `${output ? '\n' : ''}STDERR:\n${result.stderr}`
        output += `${output ? '\n' : ''}Exit code: ${result.exitCode}`
        this.detectServerUrl(output)
        return output
      }
      const pid = pidOrResult
      targetPid = pid

      // Flush buffered events
      for (const ev of bufferedOutput) {
        if (ev.pid === pid) {
          this.handleInstallOutput(ev.data, allOutput, tcId)
        }
      }
      for (const ev of bufferedExit) {
        if (ev.pid === pid && !finished) {
          finished = true
          cleanup()
          resolveExit!(ev.code)
        }
      }

      const COMMAND_TIMEOUT = timeoutSecs * 1000
      let timeoutTimer: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<number>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error(`Command timed out after ${timeoutSecs}s`)), COMMAND_TIMEOUT)
      })

      const abortPromise = abortSignal
        ? new Promise<number>((_, reject) => {
            if (abortSignal.aborted) reject(new Error('aborted'))
            else abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        : new Promise<number>(() => {}) // never resolves

      let exitCode: number
      try {
        exitCode = await Promise.race([exitPromise, timeoutPromise, abortPromise]) as number
        clearTimeout(timeoutTimer!)
      } catch (raceErr) {
        clearTimeout(timeoutTimer!)
        cleanup()
        try { await invoke('kill_process', { pid: targetPid }) } catch { /* best effort */ }
        const msg = raceErr instanceof Error ? raceErr.message : String(raceErr)
        if (msg === 'aborted') {
          const isMutating = this.matchStateMutatingCommand(command) !== null
          const hasWritePattern = ToolExecutor.WRITE_COMMAND_PATTERNS.some(p => p.test(command))
          const couldMutate = isMutating || hasWritePattern
          const truncated = command.length > 80 ? command.slice(0, 80) + '...' : command
          if (couldMutate) {
            return `Command CANCELLED by user mid-execution: ${truncated}\nExit code: 1\n\nWARNING: this command can mutate state (matches a state-mutating pattern or write operation). The process was killed, but partial side effects (file writes, mv/rm, package mutations) MAY have already occurred.\n\nDO NOT auto-retry. Ask the user what they observed before deciding the next step.`
          }
          return `Command cancelled by user: ${truncated}\nExit code: 1\n\nThe command was non-mutating (read-only / diagnostic). Safe to retry if needed, or move on.`
        }
        return `TIMEOUT: ${msg}\n${allOutput.join('')}\nThe command was killed due to timeout.`
      }

      const fullOutput = allOutput.join('')

      if (tcId) {
        emitToolProgress({ kind: 'progress', toolCallId: tcId, text: '' })
      }

      // Detect dev server URL in output
      this.detectServerUrl(fullOutput)

      // Devolve o output COMPLETO e deixa o truncateResult() do execute()
      // fazer o corte: ele já está configurado para dar a esta tool um preview
      // de CAUDA (é onde vivem os erros e o exit code) e guarda o corpo inteiro
      // no large_result store com um refId REAL.
      //
      // BUG (auditoria 2026-07-28): este caminho cortava as linhas ANTES,
      // e depois dizia ao modelo "earlier output available via read_large_result"
      // — mentira: o corpo completo nunca chegava ao store, não existia refId
      // nenhum, e a cabeça do output ficava irrecuperável. Num tsc/webpack longo
      // o PRIMEIRO erro é o que interessa, e era exatamente esse que se perdia.
      // O caminho de sucesso era pior: cortava 30 linhas sem marca nenhuma.
      return `${fullOutput}\nExit code: ${exitCode}`
    } catch (error) {
      cleanup()
      const msg = error instanceof Error ? error.message : String(error)
      return `Failed to run command: ${msg}`
    }
  }

  private detectServerUrl(output: string) {
    // Fallback path: when the agent ran a raw `execute_command` that happens
    // to start a server, pick up the URL and register it as a frontend-like
    // dev server so the preview opens. Prefer `start_dev_server` which gives
    // proper lifecycle management; this is best-effort.
    //
    // CRITICAL: skip entirely when a dev server is already active. Otherwise
    // any stray URL in command output (e.g. `curl http://localhost:7777/api`,
    // log lines with API references, build reports) would overwrite the
    // live dev server URL. This had broken fullstack preview: the agent
    // would print a backend URL mid-stream and the preview would hop to it.
    const layoutStore = useLayoutStore.getState()
    if (layoutStore.devServer) return

    // Positive-readiness patterns ONLY — never match a bare URL in output,
    // since that catches curl calls, log lines, and docs/comments.
    const serverPatterns = [
      /Local:\s+(https?:\/\/localhost:\d+)/,
      /ready on (https?:\/\/localhost:\d+)/,
      /Server running at (https?:\/\/localhost:\d+)/,
      /listening on (https?:\/\/localhost:\d+)/,
    ]

    for (const pattern of serverPatterns) {
      const match = output.match(pattern)
      if (match) {
        const url = match[1]
        // Read again just before mutating — another tool call may have started
        // a real devServer between the early-return above and this point.
        if (useLayoutStore.getState().devServer) return
        useLayoutStore.getState().initDevServer({ pid: 0, projectKind: 'frontend' })
        useLayoutStore.getState().setDevServerFrontendUrl(url)
        // The dev-server URL is registered (so the Preview button works) but the
        // view is NOT auto-switched to preview (user request 2026-06-24). Opening
        // the preview is the developer's action now; the agent points them at the
        // Preview button when it finishes. Mirrors devServerManager.handleReady,
        // which also dropped its auto-switch — both server-start paths stay quiet.
        break
      }
    }
  }

  /** Run a git (or small shell) command for the worktree tools. Never throws. */
  private async runGit(command: string, cwd: string): Promise<{ ok: boolean; out: string }> {
    try {
      const r = await invoke<{ stdout: string; stderr: string; exitCode: number; success: boolean }>(
        'execute_command',
        { command, cwd, timeoutSecs: 60 },
      )
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
      return { ok: r.success && r.exitCode === 0, out }
    } catch (e) {
      return { ok: false, out: formatError(e) }
    }
  }

  private getProjectRoot(): string {
    // Active worktree session (enter_worktree) redirects the WHOLE session —
    // file resolution and shell cwd — into the isolated checkout until
    // exit_worktree. The app/editor keeps pointing at the main checkout.
    if (this.worktreeState) return this.worktreeState.path
    // In-window multi-project: a background project-run resolves to ITS OWN
    // project, not the one the developer is currently viewing (currentProject).
    if (this.runProjectContext?.projectPath) return this.runProjectContext.projectPath
    const project = useProjectStore.getState().currentProject
    if (project?.path) return project.path
    // Cwd-scoped fallback (enableCmdMode, used by /plan): the run may be
    // executing without a populated currentProject.
    if (this.cmdModeCwd) return this.cmdModeCwd
    throw new Error('No project is open. Cannot perform file operations without an active project.')
  }

  /** All directories the agent is allowed to access: project root + user-approved extras
   *  for THIS run's project (never the focused project's extras when this is a
   *  background project-run — that would either under-allow or over-allow). */
  private getAllowedRoots(): string[] {
    const roots: string[] = []
    const projectRoot = this.cmdModeCwd || this.getProjectRoot()
    if (projectRoot) roots.push(projectRoot)
    const grants = getProjectGrants(this.runProjectContext?.projectId ?? null)
    for (const dir of grants.additionalDirectories) roots.push(dir)
    return roots
  }

  private isPathWithinRoots(normalizedTarget: string, roots: string[]): boolean {
    const isWindowsPath = /^[A-Z]:\//.test(normalizedTarget)
    const targetCmp = isWindowsPath ? normalizedTarget.toLowerCase() : normalizedTarget
    for (const root of roots) {
      const rootNorm = normalizePath(root)
      const rootCmp = isWindowsPath ? rootNorm.toLowerCase() : rootNorm
      if (targetCmp === rootCmp || targetCmp.startsWith(`${rootCmp}/`)) return true
    }
    return false
  }

  private validatePathWithinProject(filePath: string): void {
    const resolvedPath = this.resolveToAbsolute(filePath)
    const target = normalizePath(resolvedPath)
    if (this.isPathWithinRoots(target, this.getAllowedRoots())) return

    const scopeName = this.cmdModeCwd ? 'working directory' : 'project directory'
    throw new Error(`Access denied: path "${filePath}" is outside the ${scopeName}`)
  }

  /** Check if a file path is within any allowed root. Returns the top-level
   *  directory that would need to be approved if the path is outside scope. */
  private checkPathScope(filePath: string): { allowed: boolean; directoryToAdd: string; scopeName: string } {
    const resolvedPath = this.resolveToAbsolute(filePath)
    const target = normalizePath(resolvedPath)
    const roots = this.getAllowedRoots()

    if (this.isPathWithinRoots(target, roots)) {
      return { allowed: true, directoryToAdd: '', scopeName: '' }
    }

    // Find the top-level directory to suggest adding.
    // Walk up from the file until we find a directory that shares a common
    // parent with the project root — that sibling directory is the natural
    // "grant access to X" scope.
    const projectRoot = normalizePath(this.cmdModeCwd || this.getProjectRoot())
    const parts = target.split('/')
    const rootParts = projectRoot.split('/')

    // Find common prefix length
    let commonLen = 0
    for (let i = 0; i < Math.min(parts.length, rootParts.length); i++) {
      if (parts[i] === rootParts[i]) commonLen = i + 1
      else break
    }

    // The directory to add is the first divergent segment from the target side
    // e.g. root=/Users/me/project, target=/Users/me/other/src/file.ts
    //   commonLen=3 (/Users/me), directoryToAdd=/Users/me/other
    const directoryToAdd = parts.slice(0, commonLen + 1).join('/') || target

    const scopeName = this.cmdModeCwd ? 'working directory' : 'project directory'
    return { allowed: false, directoryToAdd, scopeName }
  }

  /**
   * Prompt-then-allow scope enforcement (claude-vaz parity). In-scope paths
   * pass silently; an out-of-scope path raises the `path_access` permission
   * prompt and only throws when the user DENIES — approving adds the directory
   * to `additionalDirectories` so every later tool (and the Rust cwd clamp via
   * set_agent_allowed_directories) can reach it. `requestPathAccess`
   * short-circuits already-granted dirs, so this never double-prompts with the
   * execute() gate; it is the universal fallback for paths that reach a handler
   * WITHOUT having passed the gate (e.g. an isolated sub-agent executor) — the
   * old behaviour hard-threw "Access denied" there, with no chance to approve.
   */
  private async requirePathAccess(filePath: string): Promise<void> {
    const scope = this.checkPathScope(filePath)
    if (scope.allowed) return
    const decision = await getAgentHost().requestPathAccess(filePath, scope.directoryToAdd)
    if (!decision.approved) {
      const reason = decision.denyReason ? ` ${decision.denyReason}` : ''
      throw new Error(`Access denied: path "${filePath}" is outside the ${scope.scopeName}.${reason}`)
    }
  }

  /**
   * Resolve a potentially relative path to an absolute path.
   * If the path is relative (doesn't start with '/' on Unix or 'C:\\' / 'C:/' on Windows),
   * resolve it against the project root (or cmdModeCwd).
   */
  private resolveToAbsolute(p: string): string {
    if (!p) return p
    // `~` / `~/x` — expand to the user's home dir (mirrors claude-vaz). Sem
    // isto, `~/Documents` era tratado como relativo e virava
    // `<project>/~/Documents` — um not-found confuso em vez de um prompt
    // de acesso ao diretório real.
    if (this.homeDir && (p === '~' || p.startsWith('~/'))) {
      return p === '~' ? this.homeDir : `${this.homeDir.replace(/\/+$/, '')}/${p.slice(2)}`
    }
    // Already absolute
    if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) {
      return p
    }
    // Relative path — resolve against project root or cmdModeCwd
    const base = this.cmdModeCwd || this.getProjectRoot()
    if (!base) return p // Can't resolve, return as-is
    // Normalize: join base + relative, handle leading slashes in relative
    const normalized = p.startsWith('./') ? p.slice(2) : p
    return `${base.replace(/\/+$/, '')}/${normalized}`
  }

  /**
   * Suggests a similar file path when the requested path doesn't exist.
   * Checks: same basename in project (different directory), same name with
   * different extension, and basename as glob pattern.
   */
  private async suggestSimilarPath(requestedPath: string): Promise<string | null> {
    try {
      const projectRoot = this.getProjectRoot()
      const basename = requestedPath.replace(/\\/g, '/').split('/').pop() || ''
      if (!basename) return null

      // Timeout: abort suggestion if glob takes too long (large projects)
      const SUGGESTION_TIMEOUT = 2000
      const withTimeout = <T>(promise: Promise<T>): Promise<T | null> =>
        Promise.race([
          promise,
          new Promise<null>(resolve => setTimeout(() => resolve(null), SUGGESTION_TIMEOUT)),
        ])

      // Strategy 1: Glob for same filename anywhere in project
      const exactMatches = await withTimeout(invoke<string[]>('glob_files', {
        pattern: `**/${basename}`,
        directory: projectRoot,
      }))
      if (exactMatches && exactMatches.length > 0 && exactMatches[0] !== requestedPath) {
        return exactMatches[0]
      }

      // Strategy 2: Same name, different extension (e.g., .ts vs .tsx, .js vs .jsx)
      const nameWithoutExt = basename.replace(/\.[^.]+$/, '')
      const extVariants = await withTimeout(invoke<string[]>('glob_files', {
        pattern: `**/${nameWithoutExt}.*`,
        directory: projectRoot,
      }))
      if (extVariants) {
        const filtered = extVariants.filter(p => p !== requestedPath)
        if (filtered.length > 0) {
          return filtered[0]
        }
      }

      return null
    } catch {
      return null
    }
  }

  // All managed-platform pattern gates (Dockerfile/Cloud Run shapes,
  // firebase-auth imports, ITK v2, service-account keys, data-layer deps)
  // were removed in the dev-only-IDE pivot (2026-07): the developer's own
  // stack and infrastructure choices are theirs to make. What remains is
  // genuine safety (.env / sensitive-file detection, below).
  private isEnvFile(filePath: string): boolean {
    return isEnvFile(filePath)
  }

  /**
   * Checkpoint de uma escrita aplicada DIRETAMENTE ao disco (modo cwd).
   *
   * O caminho normal captura o checkpoint na aprovação do diff
   * (diffService.acceptDiff), mas o modo cwd escreve sem passar por lá — e
   * TODAS as tarefas paralelas correm em modo cwd. Resultado (auditoria
   * 2026-07-28): as escritas das tarefas não geravam checkpoint nenhum e o
   * "Reverter tudo" saltava-as em silêncio, enquanto delete/rename capturavam
   * sempre — a cobertura era assimétrica.
   *
   * Best-effort por desenho: falhar o checkpoint nunca pode bloquear a escrita.
   */
  private async captureCmdModeCheckpoint(
    path: string,
    originalContent: string,
    isNewFile: boolean,
    toolCallId: string | undefined,
    toolName: string,
  ): Promise<void> {
    try {
      const { default: CheckpointService } = await import('./checkpointService')
      await CheckpointService.getInstance().captureBeforeWrite(
        path,
        originalContent,
        isNewFile,
        toolCallId || `cmdmode_${Date.now()}`,
        toolName,
      )
      const { useCheckpointStore } = await import('../../stores/checkpointStore')
      useCheckpointStore.getState().syncFromService()
    } catch {
      // Checkpoint failure must never block the write.
    }
  }

  /**
   * Returns a block message if the call should be denied under planMode, or
   * null if the call may proceed. Wraps the pure helper with the executor's
   * current project root.
   */
  private checkPlanModeAccess(toolName: string, filePath: string): string | null {
    return checkPlanModeAccess(toolName, filePath, this.getProjectRoot(), this.planModePlanFileName)
  }

  /**
   * /plan may seed the task tracker only after the plan artifact is complete
   * and has flipped from DRAFT to PENDING APPROVAL. `planFileWritten` alone is
   * not enough: the scaffold write happens before the final status edit.
   */
  private async isPlanReadyForTaskSeed(): Promise<boolean> {
    if (!this.planMode || !this.planFileWritten) return false
    const root = this.getProjectRoot()
    if (!root) return false
    const planPath = `${root.replace(/[\\/]+$/, '')}/${this.planModePlanFileName}`
    try {
      const content = await invoke<string>('read_file', { path: planPath })
      return /^\s*>?\s*Status:\s*PENDING APPROVAL\s*$/im.test(content)
    } catch {
      return false
    }
  }

  /**
   * Persist the permission decision onto the tool call so it surfaces in the
   * session export. Without this, forensic review can't tell whether a
   * destructive command (e.g. `kill -9`) was approved by the user or slipped
   * through unchecked — both look identical in the post-hoc markdown.
   *
   * Silent for safe tools (`source: 'safe_tool'`) — no decision was made,
   * recording it would just clutter every read_file with a permission stamp.
   */
  private recordPermission(toolCallId: string | undefined, decision: { approved: boolean; prompted: boolean; source: string; promptKind?: import('../../stores/permissionStore').PromptReason; denyReason?: string }): void {
    if (!toolCallId) return
    if (decision.source === 'safe_tool') return
    // Dynamic import keeps toolExecutor free of a hard chatStore dep at module load.
    import('../../stores/chatStore').then(m => {
      m.useChatStore.getState().recordToolPermission(toolCallId, decision as NonNullable<import('../../types/chat').ToolCallDisplay['permission']>)
    }).catch(() => { /* non-critical — don't block the tool flow */ })
  }

  // Dangerous command lists + sensitive-file detection moved to
  // ./toolExecutor/checks — wrappers preserve the existing private call
  // sites. Static lists are re-exported for the Settings UI; the wrappers
  // below cover the instance-method usages inside this class.
  private isSensitiveFile(filePath: string | undefined): boolean { return isSensitiveFile(filePath) }
  static readonly DANGEROUS_COMMANDS = DANGEROUS_COMMANDS
  static readonly STATE_MUTATING_COMMANDS = STATE_MUTATING_COMMANDS
  private matchDangerousCommand(command: string): string | null { return matchDangerousCommand(command) }
  private matchStateMutatingCommand(command: string): string | null { return matchStateMutatingCommand(command) }

  /**
   * Sub-chamada ao DATA-plane que delega a query de web_search ao sidecar
   * publicado no KV (`sidecar:web_search` — Qwen Plus com enable_search).
   *
   * Invocada APENAS quando o modelo ativo não tem pesquisa nativa. Modelos
   * DashScope com enable_search resolvem a tool server-side e nunca chegam
   * aqui.
   *
   * Histórico (2026-06-12): esta função apontava para `/v1/messages` no
   * CONTROL-plane em formato Anthropic — rota extinta com o proxy antigo,
   * pelo que TODA a chamada devolvia 404 e a tool estava morta para os
   * modelos sem pesquisa nativa. Agora: POST OpenAI-compatible no data-plane
   * com X-Request-Type: 'web_search'; o worker roteia para o sidecar e a
   * resposta diz quem serviu via X-TM-Config-Key. Sem sidecar publicado, o
   * pedido cai no modelo ativo — que pode não ter pesquisa real; nesse caso
   * devolvemos erro honesto em vez de resultados alucinados.
   */
  private async runWebSearchSubCall(query: string, maxResults: number, abortSignal?: AbortSignal): Promise<string> {
    if (abortSignal?.aborted) return `${WEB_SEARCH_ALIAS} aborted by user.`
    const token = await FirebaseAuthService.getInstance().getIdToken()
    if (!token) return `${WEB_SEARCH_ALIAS} error: authentication required.`

    const body = {
      model: 'tm-active-model', // substituído pelo worker (sidecar ou ativo)
      stream: false,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content: 'You are a web search assistant. Use your native web search capability to answer the user\'s query with up-to-date information. Return a concise summary with sources (title + URL). Do not add commentary.',
        },
        { role: 'user', content: `Search the web for: ${query}\n\nReturn up to ${maxResults} results.` },
      ],
    }

    const url = `${resolveAIWorkerUrl()}/v1/chat/completions`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Request-Type': 'web_search',
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return `${WEB_SEARCH_ALIAS} aborted by user.`
      return `${WEB_SEARCH_ALIAS} error: network failure (${err instanceof Error ? err.message : String(err)}).`
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return `${WEB_SEARCH_ALIAS} error: HTTP ${response.status}. ${detail.slice(0, 200)}`
    }

    // Sem sidecar publicado, o worker serviu com o modelo ATIVO — que não
    // tem pesquisa real. Devolver os tokens dele seria entregar resultados
    // alucinados como se fossem da web; erro honesto é estritamente melhor.
    if (response.headers.get('x-tm-config-key') !== 'sidecar:web_search') {
      return `${WEB_SEARCH_ALIAS} error: web search is currently unavailable for the active model.`
    }
    console.info(`[web-search] query served by auxiliary model=${response.headers.get('x-tm-model') ?? '?'} (config=web_search)`)

    const data = await response.json().catch(() => null) as
      { choices?: Array<{ message?: { content?: string } }> } | null
    const answer = data?.choices?.[0]?.message?.content ?? ''
    return answer.trim() || `${WEB_SEARCH_ALIAS} returned no results.`
  }


  // WRITE_COMMAND_PATTERNS moved to ./toolExecutor/checks — referenced
  // below via a static getter so existing `ToolExecutor.WRITE_COMMAND_PATTERNS`
  // call sites keep working.
  private static readonly WRITE_COMMAND_PATTERNS = WRITE_COMMAND_PATTERNS

  /**
   * Set of active read-only execution contexts (by ID).
   * When non-empty, execute_command blocks file-writing shell operations.
   * Uses a Set instead of a boolean to support concurrent verification agents
   * without one agent's cleanup disabling another's protection.
   */
  private readOnlyContexts: Set<string> = new Set()

  /** Enter read-only mode for a specific execution context. Returns the context ID. */
  enterReadOnlyMode(): string {
    const id = `ro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.readOnlyContexts.add(id)
    return id
  }

  /** Exit read-only mode for a specific execution context. */
  exitReadOnlyMode(id: string): void {
    this.readOnlyContexts.delete(id)
  }

  /** Whether any read-only context is active. */
  private get readOnlyMode(): boolean {
    return this.readOnlyContexts.size > 0
  }

  /**
   * Update the read state for a file after it has been written (diff approved).
   * Prevents false "file modified since read" errors when the model edits
   * a file it just wrote. Called by agentService after diff approval.
   */
  updateReadStateAfterWrite(path: string, newContent: string): void {
    const now = Date.now()
    const hash = this.simpleHash(newContent)
    this.readFileTimestamps.set(path, {
      timestamp: now,
      hash,
    })
    // Capture the current fsVersion BEFORE the bump — write entries have
    // offset=undefined so they're excluded from dedup anyway; the fsVersion
    // here is for completeness and for the edit_file cache optimization.
    const versionBeforeBump = getFsVersion()
    // Update the content cache too — offset=undefined marks this as a
    // write source, which is excluded from dedup (the model hasn't
    // re-read the file yet, so deduping would point it at stale content).
    this.readFileState.set(path, {
      content: newContent,
      timestamp: now,
      offset: undefined,
      limit: undefined,
      source: 'write',
      hash,
      fsVersion: versionBeforeBump,
    })
    // Bump the global filesystem fingerprint. Cache keys that include it
    // (system prompt, skills) miss on the next read so the IDE sees the
    // real post-write state. Path-agnostic by design — see fsVersion.ts.
    bumpFsVersion(`write:${path}`)
    // Plan-mode progress: the active plan artefact at the project root unblocks update_tasks
    // and enables the strict-STOP guard once update_tasks has also run.
    if (this.planMode && isPlanArtefactAtRoot(path, this.getProjectRoot(), this.planModePlanFileName)) {
      const basename = path.replace(/\\/g, '/').split('/').pop()
      if (basename === this.planModePlanFileName) this.planFileWritten = true
    }
  }

  // simpleHash moved to ./toolExecutor/checks — thin wrapper for existing
  // `this.simpleHash(...)` call sites.
  private simpleHash(str: string): number { return simpleHash(str) }

  private splitCommandTokens(command: string): string[] {
    return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => {
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        return token.slice(1, -1)
      }
      return token
    }) ?? []
  }

  private isEphemeralCurlOutputPath(pathValue: string): boolean {
    return pathValue === '/dev/null'
      || pathValue === '-'
      || pathValue.startsWith('/tmp/')
      || pathValue.startsWith('/private/tmp/')
  }

  private curlWritesOutsideEphemeralPath(command: string): boolean {
    if (!/\bcurl\s/.test(command)) return false
    const tokens = this.splitCommandTokens(command)

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]

      if (token === '--remote-name' || /^-[A-Za-z]*O[A-Za-z]*$/.test(token)) {
        // Destination is derived from the URL and usually lands in CWD.
        return true
      }

      let outputPath: string | undefined
      if (token === '--output' || /^-[A-Za-z]*o$/.test(token)) {
        outputPath = tokens[i + 1]
      } else if (token.startsWith('--output=')) {
        outputPath = token.slice('--output='.length)
      } else {
        const shortOutput = token.match(/^-[A-Za-z]*o(.+)$/)
        if (shortOutput) outputPath = shortOutput[1]
      }

      if (outputPath !== undefined && !this.isEphemeralCurlOutputPath(outputPath)) {
        return true
      }
    }

    return false
  }

  private curlUsesMutatingHttpRequest(command: string): boolean {
    if (!/\bcurl\s/.test(command)) return false
    const tokens = this.splitCommandTokens(command)
    const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]

      let method: string | undefined
      if (token === '-X' || token === '--request') {
        method = tokens[i + 1]
      } else if (token.startsWith('--request=')) {
        method = token.slice('--request='.length)
      } else {
        const shortRequest = token.match(/^-X(.+)$/)
        if (shortRequest) method = shortRequest[1]
      }

      if (method && mutatingMethods.has(method.toUpperCase())) {
        return true
      }

      if (
        token === '-d' ||
        token === '-F' ||
        token === '-T' ||
        /^-[A-Za-z]*[dFT].+/.test(token) ||
        token === '--json' ||
        token.startsWith('--json=') ||
        token === '--upload-file' ||
        token.startsWith('--upload-file=') ||
        token.startsWith('--data') ||
        token.startsWith('--form')
      ) {
        return true
      }
    }

    return false
  }

  private validateCommand(command: string, options: { allowDevServer?: boolean } = {}): void {
    // Nome de TOOL interna usado como binário de shell — alucinação observada
    // no wake pós-background-command (2026-07-16): o modelo correu
    // `check_background_commands --id …` no shell em vez de chamar a tool.
    // O shell devolveria "command not found" mascarado (o modelo tinha até
    // metido um `|| echo` para engolir o erro) e o resultado real nunca era
    // lido. Redireciona explicitamente para a tool.
    const internalToolAsShell = command.trim().match(
      /^(check_background_commands|update_tasks|read_dev_server_logs|read_large_result|collect_results|update_session_memory|read_session_memory|web_fetch|web_search)\b/,
    )
    if (internalToolAsShell) {
      throw new Error(
        `"${internalToolAsShell[1]}" is a TOOL, not a shell command. Call the ${advertisedToolName(internalToolAsShell[1])} tool directly (function call), never through ${BASH_ALIAS}/shell.`,
      )
    }

    // Read-only mode: block file-writing shell operations (verification agents).
    if (this.readOnlyMode) {
      // Strip common prefixes that don't affect read/write nature: cd ../ &&, env VAR=val, etc.
      const strippedCmd = command.replace(/^\s*(cd\s+\S+\s*&&\s*)+/, '').replace(/^\s*([\w]+=\S+\s+)+/, '').trim()
      const pipeToInterpreter = /\|\s*(?:sh|bash|zsh|fish|python3?|node|ruby|perl|php|deno|bun)\b/i.test(command)
      const hasWritePattern = ToolExecutor.WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
      const curlWriteOutsideEphemeralPath = this.curlWritesOutsideEphemeralPath(command)
      const curlMutatingHttpRequest = this.curlUsesMutatingHttpRequest(command)
      const mutatingCommand = this.matchStateMutatingCommand(command)
      if (hasWritePattern || curlWriteOutsideEphemeralPath || curlMutatingHttpRequest || mutatingCommand || pipeToInterpreter) {
        throw new Error(`Command blocked: "${command}" would modify files or execute unsafe shell flow, but you are running in read-only verification mode. Only diagnostic commands (tests, linters, type checkers, curl) are allowed.`)
      }

      // Allowlist: commands that are safe diagnostic operations.
      const isDevServerCommand = options.allowDevServer === true
        && /^(npm\s+(start|run\s+(dev|start|serve))|npx\s+(vite|next\s+dev)|pnpm\s+(dev|start|serve|run\s+(dev|start|serve))|yarn\s+(dev|start|serve|run\s+(dev|start|serve))|bun\s+(dev|start|serve|run\s+(dev|start|serve))|vite\b|next\s+dev\b)/.test(strippedCmd)
      const isAllowedDiagnostic = isDevServerCommand || /^(npm\s+(test|run\s+(test|lint|typecheck|check|tsc|build))|npx\s+(tsc|eslint|jest|vitest|mocha|next\s+lint)|pnpm\s+(test|build|lint|typecheck|tsc|run\s+(test|lint|typecheck|check|tsc|build))|yarn\s+(test|build|lint|typecheck|tsc|run\s+(test|lint|typecheck|check|tsc|build))|bun\s+(test|build|lint|typecheck|tsc|run\s+(test|lint|typecheck|check|tsc|build))|ng\s+(test|lint|build)|git\s+(status|diff|show|log|ls-files)\b|curl\s|cat\s|head\s|tail\s|wc\s|grep\s|rg\s|find\s|ls\s|echo\s|pwd\b|date\b|which\s|command\s+-v\s|ps\s)/.test(strippedCmd)
      if (!isAllowedDiagnostic) {
        throw new Error(`Command blocked: "${command}" is not an approved diagnostic command in read-only verification mode. Use tests, linters, type checkers, curl, read-only inspection commands, or start_dev_server for supervised dev servers.`)
      }
    }
  }

  private async ensureAgentShellListeners(): Promise<void> {
    if (this.agentShellListenersReady) return this.agentShellListenersReady

    this.agentShellListenersReady = Promise.all([
      listen<PtyOutputEvent>('pty-output', (event) => {
        const session = this.agentShellSessions.get(event.payload.session_id)
        if (!session) return
        const clean = this.cleanPtyOutput(event.payload.data)
        if (!clean) return
        session.output += clean
        if (session.output.length > AGENT_SHELL_MAX_BUFFER_CHARS) {
          const overflow = session.output.length - AGENT_SHELL_MAX_BUFFER_CHARS
          session.output = session.output.slice(overflow)
          session.readOffset = Math.max(0, session.readOffset - overflow)
        }
        session.updatedAt = Date.now()

        if (session.activeToolCallId) {
          const lines = clean.split('\n')
          emitToolProgress({
            kind: 'command_logs',
            toolCallId: session.activeToolCallId,
            chunks: lines.map(line => line.replace(/\r/g, '')),
          })
        }
      }),
      listen<PtyExitEvent>('pty-exit', (event) => {
        const session = this.agentShellSessions.get(event.payload.session_id)
        if (!session) return
        session.exited = true
        session.exitCode = event.payload.exit_code
        session.activeToolCallId = null
        session.updatedAt = Date.now()
      }),
    ]).then(() => undefined)

    return this.agentShellListenersReady
  }

  private cleanPtyOutput(data: string): string {
    const withoutBackspaces: string[] = []
    for (const ch of data) {
      if (ch === '\b') withoutBackspaces.pop()
      else withoutBackspaces.push(ch)
    }

    return withoutBackspaces.join('')
      // Strip common ANSI/VT escape sequences so model-visible output and the
      // lightweight transcript do not fill with prompt color/control codes.
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
  }

  /**
   * Uma linha, uma ACÇÃO.
   *
   * A descrição da tool sempre proibiu "multiple commands, newlines, &&, ||,
   * semicolons, or pipes" e o código só rejeitava newlines (auditoria
   * 2026-07-29). Duas correcções, em direcções opostas:
   *
   *  · `&&`, `||` e `;` passam a ser REJEITADOS. Numa shell persistente eles
   *    não servem para nada — o `cd` fica, portanto cada passo pode ser o seu
   *    próprio write — e partem o que a tool devolve: uma resposta com o output
   *    de três comandos e um único `shell_status` não diz qual deles falhou.
   *  · O PIPE passa a ser permitido, e a descrição corrigida. `a | b` é UM
   *    statement com UM código de saída; proibi-lo tirava à shell metade da
   *    sua utilidade (`ps aux | grep node`) sem nada em troca.
   *
   * O varrimento ignora separadores dentro de aspas: `echo "a && b"` é uma
   * acção só, e recusá-la seria a mesma classe de erro — uma tool a negar o
   * gesto certo.
   */
  private validateAgentShellInput(data: string): string {
    const command = data.replace(/\n+$/g, '').trim()
    if (!command) throw new Error('Agent shell input cannot be empty.')
    if (command.includes('\n')) {
      throw new Error('Agent shell input must contain exactly one terminal action. Send separate agent_shell_write calls for multiple lines.')
    }

    let quote: string | null = null
    for (let i = 0; i < command.length; i++) {
      const ch = command[i]
      if (quote) {
        if (ch === '\\' && quote === '"') { i++; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === '\\') { i++; continue }
      const two = command.slice(i, i + 2)
      if (two === '&&' || two === '||') {
        throw new Error(
          `Agent shell input must be exactly ONE command; found "${two}". This shell is PERSISTENT — state (cwd, env, an open SSH session) survives between calls, so send each step as its own agent_shell_write and read its output. Chaining hides which step failed: the tool reports one shell_status for the whole line. Pipes (|) are fine — they are one command.`,
        )
      }
      if (ch === ';') {
        throw new Error(
          'Agent shell input must be exactly ONE command; found ";". Send each step as its own agent_shell_write — the shell is persistent, so cwd and env carry over. Pipes (|) are fine.',
        )
      }
    }
    return command
  }

  private getAgentShellSession(id?: string): AgentShellSession {
    const sessionId = id || this.lastAgentShellSessionId
    if (!sessionId) throw new Error('No active agent shell session. Call agent_shell_start first.')
    const session = this.agentShellSessions.get(sessionId)
    if (!session) throw new Error(`Agent shell session not found: ${sessionId}`)
    return session
  }

  /**
   * Espera por output novo até `waitMs`.
   *
   * O tecto é o mesmo que os schemas anunciam (120s). Estava fixo em 10s
   * (auditoria 2026-07-28) enquanto as descrições do agent_shell_write/read
   * prometiam "Max: 120000 (use high values for deploy/upload)... instead of
   * polling every 1-5s": um deploy voltava sempre ao fim de 10s sem nada e o
   * modelo era empurrado para exatamente o polling que a descrição proíbe —
   * gastando um turn inteiro por sondagem.
   */
  private async waitForAgentShellOutput(session: AgentShellSession, startLength: number, waitMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, AGENT_SHELL_MAX_WAIT_MS))
    while (Date.now() < deadline) {
      if (session.output.length > startLength || session.exited) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  private readAgentShellDelta(session: AgentShellSession, maxChars: number = 20_000): string {
    const from = Math.min(session.readOffset, session.output.length)
    let delta = session.output.slice(from)
    if (delta.length > maxChars) {
      delta = delta.slice(-maxChars)
      delta = `[output truncated to last ${maxChars} chars]\n${delta}`
    }
    session.readOffset = session.output.length
    return delta.trimEnd()
  }

  private refreshFileTree() {
    useFileTreeRepository.getState().refresh()
  }

  /**
   * Snapshot de uma árvore antes de a apagar. Devolve `null` quando o
   * checkpoint ficou gravado (o delete pode seguir) ou a MENSAGEM DE RECUSA
   * quando não é recuperável.
   *
   * Recusar é a parte que importa. Uma pasta de componentes tem 12 ficheiros e
   * cabe num checkpoint; `node_modules` tem 40 mil e não cabe em nada. Sem o
   * tecto, ou se gravava gigabytes ou — como acontecia — se apagava sem undo
   * nenhum. Quem quiser apagar uma árvore grande usa a shell e assume-o.
   */
  private async snapshotDirectoryForDelete(
    dirPath: string,
    toolCallId: string | undefined,
  ): Promise<string | null> {
    const MAX_FILES = 400
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024

    let paths: string[]
    try {
      // respect_gitignore: false — o que vai ser apagado inclui o que o git
      // ignora, e é precisamente isso que ninguém mais consegue repor.
      paths = await invoke<string[]>('glob_files_filtered', {
        pattern: '**/*',
        directory: dirPath,
        respectGitignore: false,
      })
    } catch (err) {
      return `delete_file refused: could not enumerate ${dirPath} to build an undo checkpoint (${err instanceof Error ? err.message : String(err)}). Nothing was deleted.`
    }

    // `glob_files_filtered` com respect_gitignore:false devolve também
    // DIRECTÓRIOS (filesystem.rs empurra o caminho sem filtrar por tipo). Sem
    // os separar, cada pasta da árvore falhava o `read_file` e era contada como
    // "ilegível" — um aviso a dizer que ficheiros ficaram fora do checkpoint
    // quando não ficou nenhum. Alarme falso é exactamente o que esta auditoria
    // anda a apagar. Sonda-se só o que falha a leitura, portanto o custo é
    // proporcional aos erros e não à árvore.
    if (paths.length > MAX_FILES) {
      return `delete_file refused: ${dirPath} holds ${paths.length} files (ceiling ${MAX_FILES}). A tree this size cannot be snapshotted for undo, and deleting it without one is not something this tool does. If it is genuinely meant to go, say so to the developer and let them remove it — or delete the specific files that matter.`
    }
    if (paths.length === 0) {
      // Directório vazio: nada para snapshotar, nada para perder.
      return null
    }

    const files: Array<{ filePath: string; content: string }> = []
    let totalBytes = 0
    let unreadable = 0
    for (const filePath of paths) {
      let content: string
      try {
        content = await invoke<string>('read_file', { path: filePath })
      } catch {
        // Directório: não tem conteúdo a repor, e o `delete_file_or_directory`
        // recria a estrutura ao restaurar os ficheiros. Não é uma perda.
        const isDir = await invoke<boolean>('is_directory', { path: filePath }).catch(() => false)
        if (isDir) continue
        // Binário ou ilegível. Conta-se e reporta-se — um checkpoint que
        // silencia o que não guardou é pior do que não ter checkpoint.
        unreadable += 1
        continue
      }
      totalBytes += content.length
      if (totalBytes > MAX_TOTAL_BYTES) {
        return `delete_file refused: ${dirPath} exceeds ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB of snapshottable content, so no undo can be captured. Nothing was deleted.`
      }
      files.push({ filePath, content })
    }

    if (toolCallId && files.length > 0) {
      try {
        await CheckpointService.getInstance().captureBeforeDirectoryDelete(dirPath, files, toolCallId)
        useCheckpointStore.getState().syncFromService()
      } catch (err) {
        return `delete_file refused: the undo checkpoint for ${dirPath} could not be written (${err instanceof Error ? err.message : String(err)}). Nothing was deleted.`
      }
    }
    if (unreadable > 0) {
      logger.warn(
        'agent',
        `[delete_file] ${dirPath}: ${unreadable} ficheiro(s) ilegível(eis) ficaram FORA do checkpoint`,
      )
    }
    return null
  }

  private closeEditorIfOpen(path: string) {
    const editorState = useEditorRepository.getState()
    if (editorState.openFiles.some(f => f.path === path)) {
      editorState.closeFile(path)
    }
  }

  // After a cwd-scoped (auto-applied) agent write, reload the buffer of an
  // open tab so the editor reflects the change live. Without this, only the
  // diff-APPROVAL path (diffService.acceptDiff) refreshed open buffers, and
  // direct writes required closing + reopening the tab to be seen.
  // refreshFileContent skips dirty buffers — unsaved user edits always win.
  private refreshEditorIfOpen(path: string) {
    try {
      const editorState = useEditorRepository.getState()
      if (editorState.openFiles.some(f => f.path === path)) {
        void editorState.refreshFileContent(path).catch(() => {})
      }
    } catch { /* editor refresh is best-effort */ }
  }

  private formatFileTreeCompact(
    node: Record<string, unknown>,
    indent: string = '',
    ignoreGlobs: string[] = [],
  ): string {
    if (!node) return ''
    let result = ''
    const name = (node.name || node.fileName || '') as string
    const isDir = node.type === 'directory' || (node.children !== undefined)
    if (name && ignoreGlobs.length > 0 && matchesAnyGlob(name, ignoreGlobs)) return ''
    if (name) {
      result += `${indent}${isDir ? name + '/' : name}\n`
    }
    if (node.children && Array.isArray(node.children)) {
      const childIndent = name ? indent + '  ' : indent
      for (const child of node.children) {
        result += this.formatFileTreeCompact(child, childIndent, ignoreGlobs)
      }
    }
    // Devolve VAZIO quando não há nada a mostrar. Dizer "(empty directory)"
    // aqui era mentir por omissão de causa (auditoria 2026-07-29): `result`
    // fica vazio tanto para um directório realmente vazio como para um cujas
    // entradas foram todas FILTRADAS — pelo `ignore` do pedido ou pelo
    // .gitignore. Um `list_directory` numa pasta cheia respondia
    // "(empty directory)" e o modelo concluía que o caminho não tinha o que
    // procurava. Quem chama sabe quantos filtros aplicou; a explicação é lá.
    return result
  }

  private registerTools() {
    // === read_file ===
    this.tools.set('read_file', {
      definition: {
        name: 'read_file',
        description: 'Read the contents of a file at the given file_path. By default reads the entire file; for large files use `offset` + `limit` to read a line range (1-indexed), matching Claude Code\'s Read tool semantics. Files larger than 256 KB throw with instructions to use offset/limit — auto-truncating would waste 25K+ tokens of context vs. the model refining its call. When you already know which part of the file you need, only read that part — this is important for larger files.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file to read' },
            path: { type: 'string', description: 'Alias for file_path' },
            offset: { type: 'number', description: '1-indexed line number to start from. Combine with `limit` to read a slice of a large file.' },
            limit: { type: 'number', description: 'Maximum number of lines to read. Default: read to end of file.' }
          },
          required: []
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        let filePath = (input.file_path ?? input.path) as string | undefined
        if (!filePath) return `Error: ${READ_ALIAS} requires file_path or path.`
        // Resolve relative paths to absolute (agent often sends relative paths)
        filePath = this.resolveToAbsolute(filePath)
        
        // Detect "provided" BEFORE clamping — Math.max(1, 0) would turn
        // a missing offset into 1 and make sliceRequested always true.
        let offsetProvided = typeof input.offset === 'number' && input.offset > 0
        let limitProvided = typeof input.limit === 'number' && input.limit > 0
        let offset = offsetProvided ? Math.max(1, input.offset as number) : 1
        let limit = limitProvided ? Math.max(1, input.limit as number) : 0
        let sliceRequested = offsetProvided || limitProvided
        // Injected by execute(); undefined em caminhos sem tool_call
        // (executeForMention). Guarda-se no FileState/readRangeTracker para
        // o dedup poder perguntar ao toolResultVisibility se o resultado que
        // levou este conteúdo ao modelo ainda segue INTACTO nos pedidos.
        const readToolCallId = typeof input._toolCallId === 'string' ? input._toolCallId : undefined
        await this.requirePathAccess(filePath)

        const currentFsVersion = getFsVersion()

        // ── Binary check (pre-read, claude-vaz parity) ──────────────
        // claude-vaz rejects binary files by extension before reading
        // (constants/files.ts hasBinaryExtension). The TM is text-only
        // (Rust read_to_string), so reject all binary extensions up-front
        // with a short error rather than letting UTF-8 decode fail.
        // EXCEPÇÃO: PDF. O Rust extrai a camada de texto (pdf-extract) em vez
        // de tentar `read_to_string`. Fica no `${READ_ALIAS}` de propósito, em
        // vez de uma tool nova: o modelo já chama Read por treino, portanto a
        // capacidade aparece sem lhe ensinar mais um nome — e sem ela um PDF
        // era opaco (o texto vive dentro de streams comprimidos).
        const isPdf = /\.pdf$/i.test(filePath)
        if (!isPdf && hasBinaryExtension(filePath)) {
          return `Error: ${filePath} is a binary file. ${READ_ALIAS} only supports text files. Use a dedicated tool to inspect binary content.`
        }

        try {
          let requestedOffset = offsetProvided ? offset : undefined
          let requestedLimit = limitProvided ? limit : undefined

          // ── Pre-read stat: size guard + dedup freshness (claude-vaz parity) ──
          // claude-vaz does a single getFileModificationTimeAsync(path) stat
          // — O(1), no content read — to (a) reject >256KB files pre-read
          // (limits.ts) and (b) gate read dedup on the file's actual mtime
          // (FileReadTool.ts:523-573). The Rust `file_stat` command mirrors
          // that: size + modifiedMs only, no SHA-256. This replaces the prior
          // fsVersion gate (a global counter that doesn't advance on external
          // edits — formatters/git pull/manual edits — so it could stub a
          // re-read of a file that had actually changed) and the expensive
          // SHA-256 signature preflight (which read the whole file to hash
          // it, defeating the dedup fast-path).
          let preStat: { size: number; modifiedMs: number | null } | undefined
          try {
            preStat = await invoke<{ size: number; modifiedMs: number | null }>('file_stat', { path: filePath })
          } catch {
            // stat failed (file missing / unreadable / directory) — fall
            // through to read_file_with_signature, which errors helpfully
            // (File not found / Cannot read binary file as text).
            preStat = undefined
          }

          // (a) Size guard, pre-read — claude-vaz limits.ts throws before
          // reading a >256KB file; we now match that instead of reading the
          // whole body first. Skipped when slicing (the slice IS the
          // refinement path the error would recommend).
          // PDF fica de FORA deste tecto. Ele mede os BYTES em disco, e num
          // PDF esses bytes são o contentor (fontes, imagens, streams
          // comprimidos) — não o texto. Um PDF de 1 MB rende tipicamente
          // dezenas de KB de texto; recusá-lo por "excede 256 KB" bloqueava
          // quase todos os PDFs reais, e o conselho da mensagem (usar
          // offset+limit) não resolve nada porque o stat continua o mesmo.
          // O que interessa limitar é a SAÍDA, e disso trata o corte por
          // caracteres mais abaixo, comum a todos os ficheiros.
          if (preStat && !isPdf && !sliceRequested && preStat.size > ToolExecutor.READ_FILE_MAX_BYTES) {
            void import('../../services/analytics').then(({ trackEvent }) => {
              trackEvent('read_file_oversize_throw', {
                path: filePath,
                size_kb: Math.round(preStat.size / 1024),
              })
            }).catch(() => {})
            return `Error: File is ${(preStat.size / 1024).toFixed(1)} KB which exceeds the 256 KB read cap. Use ${READ_ALIAS} with \`offset\` + \`limit\` to read a line range, or use ${GREP_ALIAS} / ${GLOB_ALIAS} to locate specific content. Reading the whole file would saturate the output budget for one call.`
          }

          // (b) Dedup freshness — claude-vaz FileReadTool.ts:523-573:
          // only stub when offset+limit match a prior read EXACTLY AND the
          // file's mtime is unchanged on disk. fsVersion is no longer the
          // gate (it missed external edits). The cached mtime lives in the
          // FileContentSignature captured at the prior read.
          // isToolResultContextVisible: TM-specific extra gate — the stub
          // claims "the content is still in the conversation", so it can only
          // fire when the tool_result that carried this content went INTACT in
          // the last provider request. If context management compacted it, we
          // fall through and serve the content (no stub, no force:true dance).
          // ── Sem supressão de releituras (paridade claude-vaz, 29-07) ──
          //
          // Havia aqui duas coisas: um stub "o ficheiro não mudou, o conteúdo
          // ainda está na conversa" para releituras do mesmo intervalo, e um
          // dedup de sobreposição que devolvia stub ou ESTREITAVA em silêncio
          // o intervalo pedido. Ambos gated por um `force` que a própria
          // descrição mandava não usar em navegação normal.
          //
          // O claude-vaz não faz nada disto: o Read devolve o que foi pedido,
          // todas as vezes, com um tecto DECLARADO (offset/limit). A economia
          // vinha de o modelo pedir menos, não de a tool entregar menos.
          //
          // Porque saiu: sessão katondo-queue (29-07) — 175 read_file em 127
          // turnos, `schema.ts` lido 23 vezes, 12,36M tokens de input, tarefa
          // por acabar e créditos esgotados. A narração do modelo explica o
          // ciclo: "os resultados do Read estão a ser compactados", "vou ler
          // em pequenas janelas para evitar compactação", "tenho andado em
          // círculos devido à compactação". O stub afirmava que o conteúdo
          // ainda estava na conversa quando, do ponto de vista do modelo, já
          // não estava; a saída documentada (`force`) era desaconselhada pela
          // própria descrição. Sem forma de obter o ficheiro, ele contornava
          // pedindo janelas cada vez menores — e cada contorno acrescentava
          // contexto, que provocava mais compactação. A economia de tokens
          // gastou 12 milhões deles.
          //
          // A dedup por mtime ANTES da leitura (file_stat) fica: essa é a que
          // o claude-vaz também faz, e não mente ao modelo sobre o que tem.

          const readResult = sliceRequested
            ? await this.readFileRange({
              filePath,
              offset,
              limit,
              limitProvided,
              preStat,
            })
            : await invoke<ReadFileWithSignatureResult>('read_file_with_signature', { path: filePath })
          const rangeResult = sliceRequested ? readResult as ReadFileRangeWithSignatureResult : null
          const signatureForRead = readResult.signature
          const contentHash = this.simpleHash(readResult.content)

          // (Second-stage content dedup removed for claude-vaz parity:
          // claude-vaz gates dedup solely on mtime (done above via file_stat).
          // Re-adding a post-read content equality check would diverge from
          // Claude's "stat is the gate" model.)

          // TECTO DE BYTES, REDE PÓS-LEITURA (auditoria 2026-07-29).
          //
          // O guarda de 256KB acima só corre quando o `file_stat` respondeu.
          // Quando ele falha o código cai para a leitura confiando que ela
          // "erra de forma útil" — o que é verdade para ficheiro inexistente
          // ou binário, e falso para tudo o resto: uma corrida de permissões,
          // um symlink, um caminho com bytes estranhos, e um ficheiro de texto
          // de 40MB entrava inteiro no contexto do modelo. O contexto é
          // precisamente o que este tecto existe para proteger, portanto a
          // ausência de stat não pode ser um passe-livre.
          //
          // Só quando não houve stat: com stat, a decisão já foi tomada acima
          // (e uma slice pedida é o caminho legítimo para ficheiros grandes).
          if (!preStat && !sliceRequested && readResult.content.length > ToolExecutor.READ_FILE_MAX_BYTES) {
            const kb = (readResult.content.length / 1024).toFixed(1)
            logger.warn(
              'agent',
              `[read_file] ${filePath}: file_stat falhou e o corpo tem ${kb} KB — recusado pelo tecto pós-leitura`,
            )
            return `Error: File is ${kb} KB which exceeds the 256 KB read cap. Use ${READ_ALIAS} with \`offset\` + \`limit\` to read a line range, or use ${GREP_ALIAS} / ${GLOB_ALIAS} to locate specific content. Reading the whole file would saturate the output budget for one call.`
          }

          // Apply line-based slice if requested. For ranged reads, Rust does
          // the line-oriented scan and returns only the selected lines (parity
          // with claude-vaz readFileInRange); full reads keep the existing
          // whole-file path. The truncation suffix is kept separate so
          // addLineNumbers (cat -n) only numbers the actual file body, not
          // the metadata line.
          let content = readResult.content
          let truncationSuffix = ''
          const startLine = sliceRequested ? offset : 1
          const totalLines = rangeResult
            ? rangeResult.totalLines
            : (content.length > 0 ? content.split('\n').length : 0)
          if (rangeResult?.hasMore) {
            const end = rangeResult.startLine + Math.max(0, rangeResult.lineCount) - 1
            const nextOffset = end + 1
            truncationSuffix = `\n\n[truncated at line ${end} of ${rangeResult.totalLines}; use offset: ${nextOffset} to continue]`
          }
          // Detect external modification BEFORE overwriting the stored
          // timestamp. If the file's content hash differs from what we
          // saw on the previous read — and the agent itself didn't write
          // through our tools in between (write_file / edit_file update
          // this map on success) — something else touched the file
          // (formatter, git pull, manual edit, dev server output). Inject
          // a system-reminder INSIDE the tool result so the model sees
          // it in the same turn the read completes.
          // NOTE: claude-vaz does NOT inject this reminder (it relies on
          // the mtime stat to either stub-or-read; when it reads changed
          // content it just sends it). Kept here as a TM-specific aid.
          const prev = this.readFileTimestamps.get(filePath)
          const externalChange = !sliceRequested && prev !== undefined && prev.hash !== contentHash

          // Track read timestamp + content hash for read-before-write enforcement.
          // Set AFTER the externalChange comparison so the comparison uses the
          // truly-previous state.
          const now = Date.now()
          this.readFileTimestamps.set(filePath, {
            timestamp: now,
            // Ranged reads intentionally do not load the whole file into JS.
            // Keep the previous full-file hash when available; write/edit
            // falls back to the range mtime below when only a ranged view is
            // known.
            hash: sliceRequested && prev ? prev.hash : contentHash,
          })
          if (/[\\/]TMS\.md$/i.test(filePath)) {
            markTmsFullContextSent('read_file:TMS.md')
          }

          const commitReadState = (visibility: ReadVisibility): void => {
            // Store the file content in the cache for dedup and state recovery.
            // offset/limit describe the range that actually reached the model,
            // not necessarily the whole internal disk read. This keeps exact
            // dedup and overlap dedup aligned with model-visible context.
            this.readFileState.set(filePath, {
              content,
              timestamp: now,
              offset: visibility.range?.offset,
              limit: visibility.range?.limit,
              source: 'read',
              signature: signatureForRead,
              hash: contentHash,
              fsVersion: currentFsVersion,
              isPartialView: visibility.partialView || undefined,
              toolCallId: readToolCallId,
            })

            if (visibility.range) {
              // `limit === undefined` means read-to-EOF, not a hidden default
              // page size. The usage export marks those ranges with readToEnd.
              recordReadRange(
                filePath,
                visibility.range.offset,
                visibility.range.limit,
                currentFsVersion,
                signatureForRead.modifiedMs,
                readToolCallId,
              )
            }
          }

          // Empty content: distinguish "file is empty" (no slice requested,
          // file genuinely has no bytes) from "slice past EOF" (model paged
          // beyond the last line). Wording mirrors claude-vaz
          // FileReadTool.ts mapToolResultToToolResultBlockParam.
          if (content.length === 0) {
            if (sliceRequested && rangeResult && rangeResult.lineCount > 0) {
              const numStr = String(startLine)
              const body = numStr.length >= 6 ? `${numStr}→` : `${numStr.padStart(6, ' ')}→`
              const result = body + truncationSuffix
              commitReadState(ToolExecutor.getModelVisibleReadRange({
                result,
                fileBodyStart: 0,
                fileBodyLength: body.length,
                startLine,
                requestedOffset,
                requestedLimit,
              }))
              return result
            }
            if (sliceRequested && totalLines > 0 && offset > totalLines) {
              const result = `<system-reminder>Warning: the file exists but is shorter than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`
              commitReadState(ToolExecutor.getModelVisibleReadRange({
                result,
                fileBodyStart: 0,
                fileBodyLength: 0,
                startLine,
                requestedOffset,
                requestedLimit,
              }))
              return result
            }
            const result = '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
            commitReadState(ToolExecutor.getModelVisibleReadRange({
              result,
              fileBodyStart: 0,
              fileBodyLength: 0,
              startLine,
              requestedOffset,
              requestedLimit,
            }))
            return result
          }

          // cat -n line numbers (claude-vaz parity — addLineNumbers). The
          // model relies on these to target offset/limit and edit ranges.
          // Only applied when the numbered result stays under the truncation
          // threshold: acima dela o output segue por truncateResult → preview
          // por offset de CHARS + paginação read_large_result, e numerar uma
          // janela parcial enganaria (os números não acompanhariam as linhas
          // reais do ficheiro, e o offset do read_large_result cairia a meio de
          // um prefixo). claude-vaz evita isto rebentando acima de 25k tokens
          // em vez de fazer preview; o preview é uma divergência do TM só para
          // ficheiros grandes.
          //
          // O limiar TEM de ser o mesmo do corte (auditoria 2026-07-28): estava
          // fixo em 12_000 com um comentário a afirmar que era igual a
          // getToolResultMaxChars('read_file') — que entretanto subiu para
          // 100_000. Qualquer leitura entre os dois valores chegava ao modelo
          // SEM numeração nenhuma, apesar de não ser truncada, e estragava o
          // offset targeting, o read_around e o "1-based as shown by Read" do LSP.
          const READ_TRUNCATION_THRESHOLD = ToolExecutor.getToolResultMaxChars('read_file')
          const numbered = addLineNumbers(content, startLine)
          const displayContent =
            numbered.length < READ_TRUNCATION_THRESHOLD ? numbered : content

          let reminder = ''
          if (externalChange) {
            reminder =
              '<system-reminder>The contents of this file have changed since you last read it '
              + '(external modification — a formatter, git pull, dev server output, or manual edit '
              + 'touched it). Treat the content below as authoritative; assumptions from the previous '
              + 'read are stale and any planned edit must be reconciled against this new content.'
              + '</system-reminder>\n\n'
          }

          const result = reminder + displayContent + truncationSuffix
          commitReadState(ToolExecutor.getModelVisibleReadRange({
            result,
            fileBodyStart: reminder.length,
            fileBodyLength: displayContent.length,
            startLine,
            requestedOffset,
            requestedLimit,
          }))

          return result
        } catch (error) {
          // formatError handles Tauri's plain-object throws — the previous
          // `String(error)` could yield "[object Object]" which both swallowed
          // the not-found heuristic AND surfaced uselessly to the model.
          const msg = formatError(error)
          if (/not found|pathnotfound|no such file|does not exist/i.test(msg)) {
            const suggestion = await this.suggestSimilarPath(filePath)
            const projectRoot = this.getProjectRoot()
            let enriched = `File not found: ${filePath}\nNote: your current working directory is ${projectRoot}`
            if (suggestion) {
              enriched += `\nDid you mean: ${suggestion}`
            }
            return enriched
          }
          // Re-throw with a real Error so the caller's catch sees a usable
          // shape (and the formatError fallback there matches what we logged).
          throw new Error(`read_file failed for ${filePath}: ${msg}`)
        }
      }
    })

    // === read_around ===
    this.tools.set(READ_AROUND, {
      definition: {
        name: READ_AROUND,
        description: `Read a bounded line window around a specific 1-indexed line in a file. Use this after ${GREP_ALIAS} returns a matching line and you need the surrounding code. This is a convenience wrapper over ${READ_ALIAS} offset/limit.`,
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file to read' },
            path: { type: 'string', description: 'Alias for file_path' },
            line: { type: 'number', description: '1-indexed target line to center the read around' },
            before: { type: 'number', description: 'Number of lines to include before line. Default: 40, max: 200.' },
            after: { type: 'number', description: 'Number of lines to include after line. Default: 40, max: 200.' },
          },
          required: ['line'],
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const requestedPath = (input.file_path ?? input.path) as string | undefined
        if (!requestedPath) return `Error: ${READ_AROUND} requires file_path or path.`
        const line = typeof input.line === 'number' ? Math.floor(input.line) : 0
        if (line <= 0) {
          return `Error: ${READ_AROUND} requires a positive 1-indexed "line" number.`
        }
        const clampWindow = (value: unknown, fallback: number): number => {
          const n = typeof value === 'number' ? Math.floor(value) : fallback
          return Math.min(Math.max(0, n), 200)
        }
        const before = clampWindow(input.before, 40)
        const after = clampWindow(input.after, 40)
        const offset = Math.max(1, line - before)
        const endLine = line + after
        const limit = endLine - offset + 1
        // Propaga o contexto por-chamada injetado pelo execute() de origem:
        // o _toolCallId é o que liga o FileState/readRangeTracker ao registo
        // de visibilidade (sem ele, releituras pós-evicção voltavam a levar
        // stub), e o _abortSignal mantém o cancelamento a meio do voo.
        return this.execute(
          'read_file',
          {
            file_path: requestedPath,
            offset,
            limit,
            ...(input.force === true ? { force: true } : {}),
          },
          typeof input._toolCallId === 'string' ? input._toolCallId : undefined,
          input._abortSignal as AbortSignal | undefined,
          typeof input._memoryScope === 'string' ? input._memoryScope : undefined,
        )
      },
    })

    // === list_directory ===
    // === enter_worktree / exit_worktree (claude-vaz parity) ===
    this.tools.set(ENTER_WORKTREE, {
      definition: {
        name: ENTER_WORKTREE,
        description: ENTER_WORKTREE_DESCRIPTION,
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional worktree name (slug). Random when omitted.' },
          },
          required: [],
        },
        concurrencySafe: false,
      },
      execute: async (input) => {
        if (this.worktreeState) {
          return `Error: already in worktree "${this.worktreeState.name}" (${this.worktreeState.path}). Call exit_worktree first.`
        }
        let root: string
        try {
          root = this.getProjectRoot()
        } catch (e) {
          return `Error: ${formatError(e)}`
        }
        const head = await this.runGit('git rev-parse HEAD', root)
        if (!head.ok) {
          return `Error: enter_worktree requires a git repository with at least one commit. git said: ${head.out || 'not a git repository'}`
        }
        // Ancestor-repo trap (2026-07-17): with no repo at the project ROOT
        // but a repo somewhere ABOVE it (~/dev was one), HEAD resolves against
        // the PARENT and the worktree would be a checkout of ANOTHER project.
        if ((await checkRepoOwnership(root)) !== 'own') {
          return 'Error: this project has no git repository of its own — the folder sits inside an ancestor repo, so enter_worktree would create a worktree of the WRONG repository. Initialize a local repo first (git init + an initial commit), or run the work as a parallel task (tasks set up a local repo automatically).'
        }
        const { sanitizeWorktreeName, worktreeBranch, WORKTREES_REL_DIR } = await import('./toolExecutor/worktrees')
        const name = sanitizeWorktreeName(input.name) ?? `wt-${Date.now().toString(36)}`
        const branch = worktreeBranch(name)
        const dir = `${root}/${WORKTREES_REL_DIR}/${name}`
        // Keep the worktrees dir (and the local identity file) out of the MAIN
        // checkout's git status via the repo-local exclude. Best-effort, fs
        // based — the old shell one-liner was POSIX-only (broken on cmd /C).
        await ensureGitInfoExclude(root, [`${WORKTREES_REL_DIR}/`, '.toquemedia-id'])
        const add = await this.runGit(`git worktree add "${dir}" -b "${branch}"`, root)
        if (!add.ok) {
          return `Error: git worktree add failed — ${add.out}`
        }
        this.worktreeState = { originalRoot: root, path: dir, branch, name, baseRef: head.out.split('\n')[0] }
        return (
          `Entered worktree "${name}".\n` +
          `- path: ${dir}\n- branch: ${branch} (off ${this.worktreeState.baseRef.slice(0, 10)})\n` +
          `All file tools and shell commands now resolve inside the worktree until exit_worktree. ` +
          `Note for the developer: the editor still shows the MAIN checkout — this session's work lives under ${WORKTREES_REL_DIR}/${name}.`
        )
      },
    })

    this.tools.set(EXIT_WORKTREE, {
      definition: {
        name: EXIT_WORKTREE,
        description: EXIT_WORKTREE_DESCRIPTION,
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['keep', 'remove'], description: '"keep" leaves the worktree on disk; "remove" deletes it (and its branch)' },
            discard_changes: { type: 'boolean', description: 'Only with action "remove": delete even when there is uncommitted/unmerged work. Confirm with the user first.' },
          },
          required: ['action'],
        },
        concurrencySafe: false,
      },
      execute: async (input) => {
        const state = this.worktreeState
        if (!state) {
          return 'No worktree session is active — nothing to exit. Filesystem unchanged.'
        }
        const action = input.action as string
        if (action !== 'keep' && action !== 'remove') {
          return 'Error: exit_worktree requires action: "keep" | "remove".'
        }
        if (action === 'keep') {
          this.worktreeState = null
          return (
            `Exited worktree "${state.name}" (kept on disk).\n` +
            `- path: ${state.path}\n- branch: ${state.branch}\n` +
            `Session root restored to ${state.originalRoot}. The branch can be merged or revisited later.`
          )
        }
        const { decideRemove } = await import('./toolExecutor/worktrees')
        const status = await this.runGit('git status --porcelain', state.path)
        const aheadRes = await this.runGit(`git rev-list --count ${state.baseRef}..HEAD`, state.path)
        const ahead = aheadRes.ok ? parseInt(aheadRes.out, 10) || 0 : 0
        const decision = decideRemove(status.ok ? status.out : '', ahead, input.discard_changes === true)
        if (!decision.proceed) {
          return decision.refusal as string
        }
        // Restore the root BEFORE deleting — a failed removal must never
        // leave the session pointing into a half-deleted directory.
        this.worktreeState = null
        const remove = await this.runGit(`git worktree remove --force "${state.path}"`, state.originalRoot)
        await this.runGit(`git branch -D "${state.branch}"`, state.originalRoot)
        return remove.ok
          ? `Exited and removed worktree "${state.name}" (directory + branch deleted). Session root restored to ${state.originalRoot}.`
          : `Exited worktree "${state.name}" (session root restored), but removal reported: ${remove.out}. You may need to clean ${state.path} manually.`
      },
    })

    // === lsp — code intelligence (claude-vaz LSPTool contract, TS/JS) ===
    this.tools.set(LSP, {
      definition: {
        name: LSP,
        description:
          'Code intelligence for TypeScript/JavaScript via the project language service — compiler-grade answers instead of grep guesses. Operations: ' +
          'goToDefinition (where is the symbol at file/line/character defined), ' +
          'findReferences (usages of that symbol across files loaded so far; use Grep for an exhaustive project-wide sweep), ' +
          'hover (type signature + docs for the symbol at the position), ' +
          'documentSymbol (outline of functions/classes/exports in a file), ' +
          'diagnostics (type + syntax errors for ONE file — much cheaper than running tsc after editing a single file). ' +
          'line/character are 1-based, exactly as shown by Read. Prefer this over Grep when the question is about a SYMBOL (definition, type, usages); prefer Grep for text/strings.',
        input_schema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'diagnostics'],
              description: 'The code-intelligence operation to run',
            },
            file_path: { type: 'string', description: 'Absolute path to the file' },
            line: { type: 'number', description: '1-based line of the symbol (required for goToDefinition/findReferences/hover)' },
            character: { type: 'number', description: '1-based character offset of the symbol (required for goToDefinition/findReferences/hover)' },
          },
          required: ['operation', 'file_path'],
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const requestedPath = input.file_path as string | undefined
        if (!requestedPath) return 'Error: lsp requires file_path.'
        // Guard de linguagem à ENTRADA (auditoria 2026-07-28): o serviço é o
        // worker TS do Monaco — chamá-lo num .py/.rs/.go devolvia um falhanço
        // opaco que não ensinava nada. O erro diz agora o que a tool É e qual
        // é o caminho certo para as outras linguagens. (LSP multi-linguagem a
        // sério = language servers no lado Rust; projeto próprio, assumido.)
        if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(requestedPath)) {
          return `Error: lsp only covers TypeScript/JavaScript (the project's TS language service). "${requestedPath}" is outside that. For other languages use ${GREP_ALIAS} for usages, ${READ_ALIAS} for definitions, and the language's own compiler/linter via ${BASH_ALIAS} for diagnostics.`
        }
        await this.requirePathAccess(requestedPath)
        const absolute = this.resolveToAbsolute(requestedPath)
        // Lazy import: keeps Monaco out of the agent module graph until the
        // model actually asks a code-intelligence question.
        const { executeLspTool } = await import('./lspTool')
        return executeLspTool(
          {
            operation: input.operation as never,
            file_path: absolute,
            line: input.line as number | undefined,
            character: input.character as number | undefined,
          },
          this.getProjectRoot(),
        )
      },
    })

    this.tools.set('list_directory', {
      definition: {
        name: 'list_directory',
        description: `List the contents of a directory. Returns a file tree with names and types. Mapping an unfamiliar area usually takes several rounds — for that, call ${TASK_ALIAS} with subagent_type "Explore" instead of walking the tree yourself.`,
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the directory to list' },
            path: { type: 'string', description: 'Alias for file_path' },
            directory: { type: 'string', description: 'Alias for file_path' },
            maxDepth: { type: 'number', description: 'Maximum depth to traverse. Default: 3' },
            showHidden: { type: 'boolean', description: 'Include dotfiles/dot-directories (.github, .env.example, .eslintrc…). Default: false. Pass true when looking for config files that start with a dot.' },
            includeIgnored: { type: 'boolean', description: 'Include entries excluded by .gitignore (build output like dist/ or lib/, node_modules). Default: false.' },
            ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns of entry NAMES to omit (e.g. ["*.test.ts", "snapshots"]).' }
          },
          required: []
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const requestedPath = (input.file_path ?? input.path ?? input.directory) as string | undefined
        if (!requestedPath) {
          return `Error: ${LS_ALIAS} requires file_path, path, or directory.`
        }
        await this.requirePathAccess(requestedPath)
        const dirPath = this.resolveToAbsolute(requestedPath)
        // showHidden estava HARDCODED a false (auditoria 2026-07-28): dotfiles
        // eram invisíveis ao LS sem alternativa nenhuma — o modelo "provava"
        // que .github/.eslintrc não existiam. Default mantém-se false (ruído);
        // agora há opt-in.
        // respectGitignore: corta output transpilado (lib/, out/…) que a lista
        // fixa do Rust não cobre com segurança; a UI do explorador fica off.
        // CONTROLÁVEL pelo modelo (auditoria 2026-07-28): estava cravado a
        // true, portanto o agente não tinha como listar build output nem sabia
        // que algo lhe tinha sido escondido.
        const includeIgnored = input.includeIgnored === true
        const filter = {
          showHidden: input.showHidden === true,
          maxDepth: (input.maxDepth as number) || 3,
          respectGitignore: !includeIgnored,
        }
        const tree = await invoke('build_file_tree', { rootPath: dirPath, filter })
        // `ignore` faz parte do contrato do LS de treino. Sem ele, o modelo
        // pedia para excluir e recebia tudo — um filtro que ele julgava ter
        // aplicado e não existia. Aplicado no formatador (o Rust devolve a
        // árvore completa), com globs simples do dialecto do LS.
        const ignore = Array.isArray(input.ignore)
          ? (input.ignore as unknown[]).filter((g): g is string => typeof g === 'string')
          : []
        const listing = this.formatFileTreeCompact(tree as Record<string, unknown>, undefined, ignore)
        if (listing.trim().length > 0) return listing

        // Nada a mostrar — e a razão importa mais do que o facto. Cada filtro
        // activo é uma hipótese que o modelo pode testar; sem elas ele conclui
        // "a pasta está vazia" e desiste do caminho certo.
        const activeFilters: string[] = []
        if (!includeIgnored) activeFilters.push('.gitignore (pass includeIgnored: true to see build output and dependencies)')
        if (ignore.length > 0) activeFilters.push(`your ignore patterns [${ignore.join(', ')}]`)
        if (input.showHidden !== true) activeFilters.push('dot-files (pass showHidden: true)')
        return activeFilters.length > 0
          ? `No entries to show for ${dirPath} at depth ${filter.maxDepth}. This may be an empty directory OR everything in it was filtered by: ${activeFilters.join('; ')}.`
          : `Empty directory: ${dirPath} (no filters were applied, so it really is empty at depth ${filter.maxDepth}).`
      }
    })

    // === get_project_state_dir ===
    this.tools.set('get_project_state_dir', {
      definition: {
        name: 'get_project_state_dir',
        description: 'Return TM Code app-managed state directories for the current project. Use this when looking for sessions, checkpoints, saved agent state, permissions, queues, or project metadata. The active location is the global per-project store under ~/.toquemedia-studio/projects/{projectId}; do not search ${project}/.toquemedia unless explicitly investigating legacy migration.',
        input_schema: {
          type: 'object',
          properties: {},
          required: []
        },
        concurrencySafe: true,
      },
      execute: async () => {
        const projectRoot = this.getProjectRoot()
        if (!projectRoot) {
          return 'No project root is active, so there is no project state directory to report.'
        }
        const stateDir = await getProjectStateDir(projectRoot)
        return [
          `project_root: ${projectRoot}`,
          `project_state_dir: ${stateDir}`,
          `sessions_dir: ${stateDir}/sessions`,
          `legacy_project_state_dir: ${getLegacyProjectStateDir(projectRoot)} (legacy only; do not use for current sessions unless checking migration)`,
        ].join('\n')
      }
    })

    // === search_files ===
    this.tools.set('search_files', {
      definition: {
        name: 'search_files',
        description: `Search for text patterns across files in a directory using ripgrep. Returns up to 50 matching lines with file paths and line numbers. Set contextLines (1-10) when you need a few surrounding lines; for deeper inspection, follow a match with read_around or ${READ_ALIAS} offset/limit. If you need more results, narrow your search with includePatterns. For an OPEN-ENDED search that will need several rounds of grep/glob to answer ("where does X live", "what implements Y", mapping an unfamiliar area), call ${TASK_ALIAS} with subagent_type "Explore" instead — one call returns the answer and keeps the intermediate output out of your context.`,
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search pattern (text or regex)' },
            directory: { type: 'string', description: 'Absolute path to a directory to search in, or a single file to search within' },
            caseSensitive: { type: 'boolean', description: 'Case sensitive search. Default: false' },
            useRegex: { type: 'boolean', description: 'Interpret query as regex. Default: false for this tool (the Grep alias defaults to TRUE instead — same engine, different default).' },
            includePatterns: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to include (e.g., ["*.tsx", "*.ts"])' },
            contextLines: { type: 'number', description: 'Number of lines before and after each match to include. Default: 0, max: 10.' },
            outputMode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'content (default): matching lines. files_with_matches: only file paths — use for broad "where is X used" sweeps. count: per-file match counts. The compact modes cover up to 500 matches; content is capped at maxResults.' },
            maxResults: { type: 'number', description: 'Max matching lines in content mode across ALL files. Default: 50, max: 200. Independently, each file returns at most 10 matches — so a single file with 60 hits shows 10 and the result says so. When results are truncated, narrow with includePatterns, or switch to count (true per-file totals) or files_with_matches.' },
            includeIgnored: { type: 'boolean', description: 'Search .gitignore\'d paths too. Default: false — build output (compiled JS, bundles) is excluded, because the project declares there what is generated rather than authored. Set true only when the generated code is itself the subject, e.g. debugging a broken build. Same flag as glob.' },
          },
          required: ['query', 'directory']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const query = input.query as string | undefined
        if (!query || !query.trim()) {
          return `Error: ${GREP_ALIAS} requires a non-empty "query" parameter. Provide a search pattern.`
        }
        await this.requirePathAccess(input.directory as string)
        const directory = this.resolveToAbsolute(input.directory as string)
        // Modos compactos (auditoria 2026-07-28 — paridade Grep do claude-vaz):
        // files_with_matches/count devolvem ~uma linha por FICHEIRO, portanto
        // podem varrer até ao teto global do Rust (500) sem inundar o contexto.
        // O modo content mantém o cap por chamada, agora ajustável até 200.
        const outputMode = (input.outputMode === 'files_with_matches' || input.outputMode === 'count')
          ? input.outputMode as 'files_with_matches' | 'count'
          : 'content'
        const maxResults = outputMode === 'content'
          ? Math.min(Math.max(1, Math.floor(Number(input.maxResults) || 50)), 200)
          : 500
        const options = {
          case_sensitive: (input.caseSensitive as boolean) || false,
          whole_word: false,
          use_regex: (input.useRegex as boolean) || false,
          include_patterns: (input.includePatterns as string[]) || [],
          // Condicional ao includeIgnored, senão o flag é uma promessa vazia:
          // estas quatro exclusões corriam SEMPRE, portanto `dist/` e
          // `node_modules/` eram inalcançáveis mesmo com o opt-in explícito —
          // os dois casos de uso que a própria descrição nomeia (depurar um
          // build, ler o código real de uma dependência). O `.git` fica de
          // fora em qualquer caso: não é o assunto de ninguém.
          exclude_patterns: (input.includeIgnored as boolean)
            ? ['.git/**']
            : ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
          max_results: maxResults,
          context_lines: outputMode === 'content' && typeof input.contextLines === 'number'
            ? Math.min(Math.max(0, Math.floor(input.contextLines)), 10)
            : 0,
          // Sealed .env content is stripped Rust-side. The walk includes
          // dot-FILES and only dot-DIRECTORIES are pruned, so without this a
          // broad search would dump secrets into the model's context — with
          // no permission dialog, since search is auto-approved as a SAFE tool.
          // Off for the developer's own Search panel (searchService.ts).
          seal_env_files: true,
          // Mesmo opt-out do Glob. Antes o Grep nem tinha a noção: caía em
          // `grep` quando faltava o binário do ripgrep e devolvia transpilado
          // sem o dizer, enquanto o Glob filtrava — o modelo recebia duas
          // descrições contraditórias da mesma árvore e resolvia-as escalando
          // para includeIgnored (sessão momenu-fact 2026-07-28).
          respect_gitignore: !(input.includeIgnored as boolean),
          // `count` conta de VERDADE: o Rust muda para SearchDepth::CountOnly,
          // sem tecto por ficheiro e sem guardar texto de linha. Antes o modo
          // count reportava o `total_matches` do modo Content — já limitado a
          // 10 por ficheiro — portanto "quantos usos tem X" respondia 10 num
          // ficheiro com 60 (auditoria 2026-07-29).
          count_only: outputMode === 'count',
        }
        const result = await invoke('search_in_files', {
          query: input.query,
          directory: directory,
          options
        })
        if (outputMode !== 'content') {
          return formatSearchResultsByFile(result, outputMode)
        }
        return this.formatSearchResultsCompact(result)
      }
    })

    // === write_file ===
    this.tools.set('write_file', {
      definition: {
        name: 'write_file',
        description: `Replace the entire content of an existing file, or create a new file. Always use Read first on existing files to understand what you are replacing. For creating new files, prefer create_file. For small edits (1-20 lines), prefer ${EDIT_ALIAS} instead.`,
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file to write' },
            content: { type: 'string', description: 'Complete content to write to the file' }
          },
          required: ['file_path', 'content']
        }
      },
      execute: async (input) => {
        await this.requirePathAccess(input.file_path as string)
        const path = this.resolveToAbsolute(input.file_path as string)
        // Binário NÃO é editável como texto. Guarda acrescentada quando o
        // `${READ_ALIAS}` passou a extrair PDFs: até aí, ler um binário
        // falhava, portanto o portão read-before-write nunca ficava satisfeito
        // para um. Com a leitura a funcionar, o modelo passa a ter um PDF
        // "lido" e nada o impedia de lhe escrever texto por cima — o ficheiro
        // ficaria destruído e o diff pareceria legítimo.
        if (hasBinaryExtension(path)) {
          return `Error: ${path} is a binary file. ${READ_ALIAS} can extract its text, but writing text back would corrupt it. Generate binaries with the project's own tooling via ${BASH_ALIAS}.`
        }
        const newContent = input.content as string

        // Read current content to generate diff data
        let oldContent = ''
        let isNewFile = true
        try {
          oldContent = await invoke<string>('read_file', { path })
          isNewFile = false
        } catch {
          isNewFile = true
        }

        // Enforce read-before-write for existing files (like Claude Code).
        // The model must read a file before overwriting it to understand what it's replacing.
        // Mirrors claude-vaz FileWriteTool.ts:275-294 (isPartialView check).
        if (!isNewFile) {
          const readState = this.readFileTimestamps.get(path)
          if (!readState) {
            this.recordReadBeforeWriteBlocked(WRITE_FILE, 'not_read')
            return `Error: You must call ${READ_ALIAS} on "${path}" before overwriting it. Read the file first to understand its current content, then call ${WRITE_ALIAS}.`
          }
          // isPartialView: if the model only saw an auto-injected partial view
          // (e.g. stripped/truncated project memory), it must do a full Read
          // first — the auto-injected content may not match what's on disk.
          const cachedState = this.readFileState.get(path)
          if (cachedState?.isPartialView) {
            this.recordReadBeforeWriteBlocked(WRITE_FILE, 'partial_view')
            return `Error: You must call ${READ_ALIAS} on "${path}" before overwriting it. The content you saw was auto-injected and may not match the file on disk. Read the file first, then call ${WRITE_ALIAS}.`
          }
          // Concurrent modification detection: full reads use the content
          // hash; ranged reads use the file mtime captured by the range
          // reader, matching claude-vaz's read-state gate.
          if (await this.hasFileChangedSinceRead(path, oldContent, readState, cachedState)) {
            this.readFileTimestamps.delete(path)
            this.recordReadBeforeWriteBlocked(WRITE_FILE, 'modified_since_read')
            return `Error: File "${path}" has been modified since you last read it (by the developer, a formatter, or another process). Read it again with ${READ_ALIAS} before writing.`
          }
        }

        // Cwd-scoped execution: write directly to disk, no approval needed, but still
        // return diff JSON so the UI renders the before/after consistently.
        // `alreadyApplied: true` tells chatStore to skip the approval queue.
        // Diffs stay JSON mini (UI + model; TOON ≈ 0 gain when bulk is file body).
        if (this.cmdModeCwd) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          if (dir) await invoke('create_directories_all', { path: dir })
          await this.captureCmdModeCheckpoint(path, oldContent, isNewFile, input._toolCallId as string | undefined, WRITE_FILE)
          await invoke('write_file', { path, content: newContent })
          if (/[\\/]TMS\.md$/i.test(path)) {
            markTmsCreated(path)
            useProjectStore.getState().setNoTmsFile(false)
          }
          this.readFileTimestamps.set(path, { timestamp: Date.now(), hash: this.simpleHash(newContent) })
          this.readFileState.set(path, { content: newContent, timestamp: Date.now(), offset: undefined, limit: undefined, source: 'write', hash: this.simpleHash(newContent), fsVersion: getFsVersion() })
          bumpFsVersion(`write:${path}`)
          this.refreshFileTree()
          this.refreshEditorIfOpen(path)
          return jsonMini({
            type: 'diff',
            path,
            oldContent,
            newContent,
            isNewFile,
            alreadyApplied: true,
          })
        }

        // Return diff data as JSON for inline display
        // The file is NOT written yet — user approves via InlineDiff
        return jsonMini({
          type: 'diff',
          path,
          oldContent,
          newContent,
          isNewFile,
        })
      }
    })

    // === create_file ===
    this.tools.set('create_file', {
      definition: {
        name: 'create_file',
        description: 'Create a new file with optional content. Fails if the file already exists.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path for the new file' },
            content: { type: 'string', description: 'Initial content for the file. Default: empty' }
          },
          required: ['file_path']
        }
      },
      execute: async (input) => {
        await this.requirePathAccess(input.file_path as string)
        const path = this.resolveToAbsolute(input.file_path as string)
        const content = (input.content as string) || ''

        // Check if file already exists
        try {
          await invoke<string>('read_file', { path })
          return `Error: File already exists: ${path}. Use ${WRITE_ALIAS} to overwrite or ${EDIT_ALIAS} for small changes.`
        } catch {
          // File doesn't exist — good, proceed
        }

        // Cwd-scoped execution: write directly to disk, still return diff JSON so the UI
        // renders the new file content. `alreadyApplied` skips approval queue.
        if (this.cmdModeCwd) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          if (dir) await invoke('create_directories_all', { path: dir })
          // create_file só chega aqui quando o ficheiro NÃO existe (o guard
          // acima rejeita o contrário), portanto o estado anterior é vazio.
          await this.captureCmdModeCheckpoint(path, '', true, input._toolCallId as string | undefined, 'create_file')
          await invoke('write_file', { path, content })
          this.readFileTimestamps.set(path, { timestamp: Date.now(), hash: this.simpleHash(content) })
          this.readFileState.set(path, { content, timestamp: Date.now(), offset: undefined, limit: undefined, source: 'write', hash: this.simpleHash(content), fsVersion: getFsVersion() })
          this.recordCreatedFile(path, content)
          bumpFsVersion(`create:${path}`)
          this.refreshFileTree()
          this.refreshEditorIfOpen(path)
          return jsonMini({
            type: 'diff',
            path,
            oldContent: '',
            newContent: content,
            isNewFile: true,
            alreadyApplied: true,
          })
        }

        // Return diff data as JSON for inline display (consistent with write_file)
        // O guard acima garante que o ficheiro não existia. Se o developer
        // recusar o diff, ele continua a não existir — e um delete_file sobre
        // um caminho inexistente falha por si, portanto a isenção não abre
        // buraco nenhum.
        this.recordCreatedFile(path, content)
        return jsonMini({
          type: 'diff',
          path,
          oldContent: '',
          newContent: content,
          isNewFile: true,
        })
      }
    })

    // === create_directory ===
    this.tools.set('create_directory', {
      definition: {
        name: 'create_directory',
        description: 'Create a directory and all necessary parent directories.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path of the directory to create' }
          },
          required: ['file_path']
        }
      },
      execute: async (input) => {
        await this.requirePathAccess(input.file_path as string)
        const filePath = this.resolveToAbsolute(input.file_path as string)
        await invoke('create_directories_all', { path: filePath })
        this.refreshFileTree()
        return `Directory created successfully: ${filePath}`
      }
    })

    // === delete_file ===
    this.tools.set('delete_file', {
      definition: {
        name: 'delete_file',
        description: 'Delete a file or directory. A checkpoint is captured first so the user can undo — for a directory that means every file inside it, and the call is REFUSED when the tree is too large to snapshot (the refusal tells you the numbers). Only use when the user explicitly asks to delete, or when removing a file you just created in error.',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to delete' }
          },
          required: ['file_path']
        }
      },
      execute: async (input) => {
        await this.requirePathAccess(input.file_path as string)
        const filePath = this.resolveToAbsolute(input.file_path as string)

        // Capture checkpoint before deleting. Use injected _toolCallId so
        // concurrent invocations don't race a shared field.
        //
        // O ramo do DIRECTÓRIO existe porque a versão anterior tentava
        // `read_file` no caminho, apanhava o erro ("Path is a directory") e
        // saltava o checkpoint em SILÊNCIO — para logo a seguir apagar a
        // árvore recursivamente. A tool prometia undo e não o tinha; era o
        // caminho mais destrutivo do executor (auditoria 2026-07-29).
        const tcId = input._toolCallId as string | undefined
        const isDirectory = await invoke<boolean>('is_directory', { path: filePath }).catch(() => false)

        if (isDirectory) {
          const refusal = await this.snapshotDirectoryForDelete(filePath, tcId)
          if (refusal) return refusal
        } else if (tcId) {
          try {
            const content = await invoke<string>('read_file', { path: filePath })
            await CheckpointService.getInstance().captureBeforeDelete(
              filePath,
              content,
              tcId,
            )
            useCheckpointStore.getState().syncFromService()
          } catch {
            // Ficheiro binário ou ilegível: sem conteúdo não há snapshot
            // possível. Fica dito no log em vez de insinuado.
            logger.warn('agent', `[delete_file] sem checkpoint para ${filePath} (ilegível) — remoção sem undo`)
          }
        }

        this.closeEditorIfOpen(filePath)
        await invoke('delete_file_or_directory', { path: filePath })
        this.refreshFileTree()
        // Deletes are filesystem mutations too — bump the version so the
        // next system-prompt build sees the file tree without the gone path.
        bumpFsVersion(`delete:${filePath}`)
        return `Deleted successfully: ${filePath}`
      }
    })

    // === rename_file ===
    this.tools.set('rename_file', {
      definition: {
        name: 'rename_file',
        description: 'Rename a file or directory.',
        input_schema: {
          type: 'object',
          properties: {
            oldPath: { type: 'string', description: 'Current absolute path' },
            newName: { type: 'string', description: 'New name (not full path, just the name)' }
          },
          required: ['oldPath', 'newName']
        }
      },
      execute: async (input) => {
        await this.requirePathAccess(input.oldPath as string)
        const oldPath = this.resolveToAbsolute(input.oldPath as string)
        // Validate newName doesn't contain path traversal
        const newName = input.newName as string
        if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
          throw new Error('Access denied: new name cannot contain path separators or "..".')
        }

        // Capture checkpoint before renaming. Use injected _toolCallId so
        // concurrent invocations don't race a shared field.
        const tcId = input._toolCallId as string | undefined
        if (tcId) {
          try {
            const content = await invoke<string>('read_file', { path: oldPath })
            const oldPathStr = oldPath
            const parentDir = oldPathStr.substring(0, oldPathStr.lastIndexOf('/'))
            const newPath = `${parentDir}/${newName}`
            await CheckpointService.getInstance().captureBeforeRename(
              oldPathStr,
              newPath,
              content,
              tcId,
            )
            useCheckpointStore.getState().syncFromService()
          } catch {
            // File might be a directory — skip checkpoint
          }
        }

        await invoke('rename_file_or_directory', {
          oldPath: oldPath,
          newName
        })
        this.refreshFileTree()
        bumpFsVersion(`rename:${input.oldPath}`)
        return `Renamed successfully: ${input.oldPath} -> ${newName}`
      }
    })

    // === edit_file ===
    this.tools.set('edit_file', {
      definition: {
        name: 'edit_file',
        description: `Replace a specific string in a file with new content. The old_string must match exactly and (unless replace_all is true) appear only once in the file. Use this for surgical edits instead of rewriting entire files with ${WRITE_ALIAS}. ONE old_string/new_string pair per call: to change several spots in the same file, issue one call per spot in the SAME turn (they are chained in order, each running against the file as the previous one left it); when every spot is the identical snippet, use replace_all. Field names match Claude Code's Edit tool: \`old_string\` / \`new_string\` / \`replace_all\`.`,
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the file to edit' },
            old_string: { type: 'string', description: 'Exact text to find and replace. Must be unique in the file unless replace_all is true.' },
            new_string: { type: 'string', description: 'Text to replace old_string with. Use empty string to delete.' },
            replace_all: { type: 'boolean', description: 'Replace EVERY occurrence of old_string (e.g. renaming a symbol or variable across the file). Default: false.' }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      },
      execute: async (input) => {
        const path = this.resolveToAbsolute(input.file_path as string)
        // Binário NÃO é editável como texto. Guarda acrescentada quando o
        // `${READ_ALIAS}` passou a extrair PDFs: até aí, ler um binário
        // falhava, portanto o portão read-before-write nunca ficava satisfeito
        // para um. Com a leitura a funcionar, o modelo passa a ter um PDF
        // "lido" e nada o impedia de lhe escrever texto por cima — o ficheiro
        // ficaria destruído e o diff pareceria legítimo.
        if (hasBinaryExtension(path)) {
          return `Error: ${path} is a binary file. ${READ_ALIAS} can extract its text, but writing text back would corrupt it. Generate binaries with the project's own tooling via ${BASH_ALIAS}.`
        }
        // Field names align with Claude Code's Edit tool — the model uses
        // these from training. Background: the May 2026 todo-mimo /plan
        // session looped when the schema was old_str-only; the model
        // defaulted to old_string (its training default) and the original
        // "cannot be empty" error gave no hint about the key-name issue.
        const oldStr = (input.old_string ?? '') as string
        const newStr = (input.new_string ?? '') as string

        if (!oldStr) {
          // Detect known typos (camelCase, snake_str legacy, alternate
          // editor names) so the error tells the model exactly what to
          // fix instead of just "empty" — which it can't act on if the
          // value was actually there under a misspelled key.
          const passedKeys = Object.keys(input).filter(k => !k.startsWith('_'))
          const wrongName = passedKeys.find(k =>
            k === 'oldStr' || k === 'oldString' || k === 'old_text' ||
            k === 'old_str' || k === 'new_str',
          )
          // Fire-and-forget telemetry (#22 from prompt techniques manual).
          // Without this we can't tell if the field-name fixes reduced
          // the loop rate or just shifted it. `kind` lets us slice by
          // failure mode in the dashboard.
          void import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('edit_file_error', {
              kind: wrongName ? 'typo' : 'empty_old_string',
              wrong_name: wrongName ?? '',
            })
          }).catch(() => { /* never block on telemetry */ })
          if (wrongName) {
            return `${t('tool.wrongFieldNames').replace('{fields}', passedKeys.join(', '))}`
          }
          return t('tool.emptyOldString')
        }

        await this.requirePathAccess(path)

        // Enforce read-before-edit: the model must have read the file to know what to edit.
        // Mirrors claude-vaz FileEditTool.ts:275-287 (readFileState + isPartialView).
        const readState = this.readFileTimestamps.get(path)
        if (!readState) {
          this.recordReadBeforeWriteBlocked(EDIT_FILE, 'not_read')
          return `Error: You must call ${READ_ALIAS} on "${path}" before editing it. Read the file first to see the current content, then call ${EDIT_ALIAS}.`
        }
        // isPartialView: if the model only saw an auto-injected partial view
        // (e.g. stripped/truncated project memory), it must do a full Read
        // first — the auto-injected content may not match what's on disk.
        const readStateEntry = this.readFileState.get(path)
        if (readStateEntry?.isPartialView) {
          this.recordReadBeforeWriteBlocked(EDIT_FILE, 'partial_view')
          return `Error: You must call ${READ_ALIAS} on "${path}" before editing it. The content you saw was auto-injected and may not match the file on disk. Read the file first, then call ${EDIT_ALIAS}.`
        }

        // Re-read from disk before generating the diff. `fsVersion` only tracks
        // agent writes, so relying on cached content would miss developer or
        // formatter changes made after the model's last read_file.
        const content = await invoke<string>('read_file', { path })
        if (await this.hasFileChangedSinceRead(path, content, readState, readStateEntry)) {
          this.readFileTimestamps.delete(path)
          this.recordReadBeforeWriteBlocked(EDIT_FILE, 'modified_since_read')
          return `Error: File "${path}" has been modified since you last read it. Read it again with ${READ_ALIAS} before editing.`
        }

        const occurrences = content.split(oldStr).length - 1

        if (occurrences === 0) {
          void import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('edit_file_error', { kind: 'not_found', wrong_name: '' })
          }).catch(() => {})
          // As DUAS causas dominantes deste erro na prática (auditoria
          // 2026-07-28) são auto-infligidas e fáceis de nomear — sem as
          // nomear, o modelo re-lia o ficheiro e tentava o MESMO match.
          return `Error: old_string not found in ${path}. The content you're trying to replace doesn't exist in the file. The two most common causes: (1) you pasted the line-number prefix from ${READ_ALIAS} output ("   123→") into old_string — strip it, it is display-only, not file content; (2) whitespace drift — tabs vs spaces or trailing spaces differ from the actual file. Use ${READ_ALIAS} first and copy the text EXACTLY as shown after the → marker.`
        }

        const replaceAll = input.replace_all === true
        if (occurrences > 1 && !replaceAll) {
          // Two failure modes look identical here — see editLiteralReplace.ts
          // for the full reasoning. Pure function so production and tests
          // can't drift.
          const { duplicateMatchError } = await import('./editLiteralReplace')
          void import('../../services/analytics').then(({ trackEvent }) => {
            trackEvent('edit_file_error', { kind: 'non_unique', wrong_name: '', occurrences })
          }).catch(() => {})
          return duplicateMatchError(path, occurrences)
        }

        // Literal substring replace — see editLiteralReplace.ts for the
        // $-sequence corruption history. Pure functions so production and
        // tests can't drift.
        const { editFileReplace, editFileReplaceAll } = await import('./editLiteralReplace')
        const newContent = replaceAll
          ? editFileReplaceAll(content, oldStr, newStr)
          : editFileReplace(content, oldStr, newStr)

        // Cwd-scoped execution: write directly to disk, still return diff JSON so the UI
        // renders the before/after. `alreadyApplied` skips approval queue.
        if (this.cmdModeCwd) {
          const dir = path.slice(0, path.lastIndexOf('/'))
          if (dir) await invoke('create_directories_all', { path: dir })
          await this.captureCmdModeCheckpoint(path, content, false, input._toolCallId as string | undefined, EDIT_FILE)
          await invoke('write_file', { path, content: newContent })
          this.readFileTimestamps.set(path, { timestamp: Date.now(), hash: this.simpleHash(newContent) })
          this.readFileState.set(path, { content: newContent, timestamp: Date.now(), offset: undefined, limit: undefined, source: 'write', hash: this.simpleHash(newContent), fsVersion: getFsVersion() })
          bumpFsVersion(`edit:${path}`)
          this.refreshFileTree()
          this.refreshEditorIfOpen(path)
          return jsonMini({
            type: 'diff',
            path,
            oldContent: content,
            newContent,
            isNewFile: false,
            alreadyApplied: true,
          })
        }

        // Return diff data as JSON for inline display
        return jsonMini({
          type: 'diff',
          path,
          oldContent: content,
          newContent,
          isNewFile: false,
        })
      }
    })

    // === glob ===
    this.tools.set('glob', {
      definition: {
        name: 'glob',
        description: `Find files matching a glob pattern. Returns a list of absolute file paths. Build output and vendored code (anything matched by the project\'s .gitignore — dist/, lib/, out/, node_modules/) is EXCLUDED by default; pass includeIgnored: true when those files are the subject (debugging a build, checking what compiled, reading a dependency\'s real code). When the search is open-ended and will take several rounds of globbing and grepping, call ${TASK_ALIAS} with subagent_type "Explore" instead.`,
        input_schema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.tsx", "src/**/*.test.ts", "**/package.json"). "**" must be its own path segment ("**/name"); to match "contains", use "**/*name*"' },
            directory: { type: 'string', description: 'Absolute path to search from. Default: project root' },
            includeIgnored: { type: 'boolean', description: 'Include files excluded by .gitignore (build output, node_modules). Default: false.' }
          },
          required: ['pattern']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const pattern = input.pattern as string
        const directory = this.resolveToAbsolute((input.directory as string) || this.getProjectRoot())

        await this.requirePathAccess(directory)

        // Filtro de .gitignore LIGADO por omissão (corta output transpilado que
        // inundava as buscas) mas CONTROLÁVEL — ver a nota do opt-out em
        // filesystem.rs::glob_files_filtered.
        const includeIgnored = input.includeIgnored === true
        const result = await invoke<string[]>('glob_files_filtered', {
          pattern,
          directory,
          respectGitignore: !includeIgnored,
        })

        if (result.length === 0) {
          // HONESTIDADE do zero-resultados (auditoria 2026-07-28): sem esta
          // nota, um glob que só não encontrou nada PORQUE filtrou levava o
          // modelo a concluir "o ficheiro não existe" — a tool a mentir-lhe.
          // É precisamente o caso de `**/*.js` num projecto onde `lib/` é
          // output ignorado.
          return includeIgnored
            ? `No files found matching pattern: ${pattern}`
            : `No files found matching pattern: ${pattern}\n(Note: .gitignore'd paths — build output like dist/ or lib/, and node_modules — were excluded. If the files you want are build output or vendored code, retry with includeIgnored: true.)`
        }

        return result.join('\n')
      }
    })

    // === web_search ===
    // Two execution paths, chosen by the current model:
    //   - DeepSeek V3.2 / Qwen on DashScope: native enable_search — the provider
    //     executes internally and returns results in the stream. The frontend
    //     NEVER receives a tool_call, so execute() is not invoked for these.
    //   - GLM (or any non-native model): execute() runs and side-cars the
    //     query to Qwen 3.6 Plus via X-Request-Type: 'web_search'. The backend
    //     forces the model + enable_search and streams the answer back.
    this.tools.set('web_search', {
      definition: {
        name: 'web_search',
        description: 'Search the internet for up-to-date information. Returns search results with titles, snippets, URLs, and metadata. Use this to look up documentation, find solutions to errors, research technical topics, or get current information.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
            max_results: { type: 'number', description: 'Maximum number of results. Default: 5' },
          },
          required: ['query']
        },
        concurrencySafe: true,
      },
      execute: async (input: Record<string, unknown>) => {
        const query = typeof input.query === 'string' ? input.query.trim() : ''
        if (!query) return `${WEB_SEARCH_ALIAS} error: query is required.`
        const maxResults = typeof input.max_results === 'number' ? input.max_results : 5
        const abortSignal = input._abortSignal as AbortSignal | undefined
        return await this.runWebSearchSubCall(query, maxResults, abortSignal)
      }
    })

    // === web_fetch ===
    this.tools.set('web_fetch', {
      definition: {
        name: 'web_fetch',
        description: `Fetch a web URL (http/https). PASS A \`prompt\`: the page is processed by a fast auxiliary model and you get the ANSWER to your question, not the page — a 200 KB page becomes three lines in your context instead of 50 000 truncated characters, and the navigation/footer noise never enters the transcript at all. Without a prompt you get the raw text and pay its full size in context, every turn, until compaction. Default mode returns readable text — HTML is stripped to article text and the page\'s stylesheet URLs are listed; JSON/plaintext/CSS is returned as-is. mode:"raw" returns the raw response body (full HTML markup with classes/inline styles). Use it to read documentation, npm/package pages, API responses, changelogs, or any URL the user pastes. DESIGN-COPY FLOW (user asks to see/copy a site\'s design): 1) fetch the page (text mode) for content/structure + the stylesheet list, 2) fetch the stylesheet URLs for colors/fonts/spacing, 3) fetch mode:"raw" when you need the actual markup, and 4) use capture_url_design for a visual screenshot description. Follows redirects. Can reach the local dev server (localhost); cloud-metadata and internal network addresses are blocked. PDFs ARE supported: point this tool at a .pdf URL and you get its text layer back (summarised, if you passed a prompt) — no need to curl it and shell out to pdftotext. Images, archives and media are NOT readable here. For anything VISUAL — how a page or PDF LOOKS, text overflowing its box, positions, colors — call \`${CAPTURE_URL_DESIGN}\` with the same URL: it renders in a real browser and describes what it looks like. Text extraction cannot show you a broken layout.`,
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to fetch (must be http or https)' },
            prompt: {
              type: 'string',
              description: 'What you want to know from this page. The page is processed by a fast model and you get the ANSWER, not the page — so ask a real question ("what does this API return on 429?", "which version added X?"). Omit only when you genuinely need the raw text; then the page comes back verbatim and costs you its full size in context.',
            },
            maxLength: { type: 'number', description: 'Maximum characters to return when no prompt is given. Default: 50000' },
            mode: {
              type: 'string',
              enum: ['text', 'raw'],
              description: 'text (default): HTML stripped to readable text + stylesheet list. raw: the raw response body as-is (full HTML/CSS/JSON) — use to inspect real markup, classes and inline styles.'
            }
          },
          required: ['url']
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const rawUrl = String(input.url ?? '').trim()
        const maxLength =
          typeof input.maxLength === 'number' && input.maxLength > 0 ? input.maxLength : 50000
        const signal = input._abortSignal as AbortSignal | undefined

        // Validate up front — a clear message beats a confusing Rust proxy error.
        let parsed: URL
        try {
          parsed = new URL(rawUrl)
        } catch {
          return `Error: "${rawUrl}" is not a valid absolute URL. Provide a full http(s) URL (e.g. https://example.com/path).`
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return `Error: ${WEB_FETCH_ALIAS} only supports http/https URLs (got "${parsed.protocol}").`
        }
        if (signal?.aborted) return `Web fetch cancelled by user (${rawUrl}).`

        // Cache de 15 min (porte do URL_CACHE do claude-vaz): a mesma página
        // costuma ser visitada com perguntas DIFERENTES. Cacheia-se o
        // conteúdo, não a resposta — a 2.ª pergunta poupa a rede e só paga o
        // modelo. `raw` não usa cache: quem pede markup quer o do momento.
        const cachedContent = input.mode === 'raw' ? null : (await import('./fetchSidecar')).getCachedPageContent(parsed.toString())
        if (cachedContent) {
          const ask = typeof input.prompt === 'string' ? input.prompt.trim() : ''
          if (ask) {
            const { answerFromPageViaSidecar } = await import('./fetchSidecar')
            const sum = await answerFromPageViaSidecar(cachedContent, ask, parsed.toString(), signal)
            if (sum) {
              return `URL: ${parsed.toString()}\n`
                + `Answered from a cached copy of the page by an auxiliary model${sum.model ? ` (${sum.model})` : ''} — not the page verbatim.\n\n`
                + sum.answer
            }
          }
          return `URL: ${parsed.toString()}\n(from cache)\n\n`
            + (cachedContent.length > maxLength ? `${cachedContent.slice(0, maxLength)}\n…[truncated]` : cachedContent)
        }

        // ── Atalho para URLs que JÁ parecem PDF ──
        //
        // Sem isto o PDF era descarregado DUAS vezes: o fetch genérico traz o
        // corpo (bytes binários que voltam como String e ficam corrompidos, ou
        // seja, inúteis), descobre-se o content-type, e só então o
        // `fetch_pdf_text` o descarrega outra vez para extrair. Em 4 KB não se
        // nota; num PDF de 20 MB são 40 MB de tráfego por nada.
        //
        // A extensão no URL cobre a esmagadora maioria dos casos. Quando ela
        // mente (um 404 em HTML servido num caminho `.pdf`), a extracção falha
        // e cai-se no caminho normal — correcção preservada, custo poupado.
        if (/\.pdf(?:$|[?#])/i.test(parsed.pathname + parsed.search)) {
          try {
            const text = await invoke<string>('fetch_pdf_text', { url: parsed.toString() })
            if (text.trim()) {
              // Um PDF é onde o sumarizador rende mais: uma factura de 30
              // páginas responde a "qual é o total?" numa linha.
              const ask = typeof input.prompt === 'string' ? input.prompt.trim() : ''
              if (ask) {
                const { answerFromPageViaSidecar } = await import('./fetchSidecar')
                const sum = await answerFromPageViaSidecar(text, ask, parsed.toString(), signal)
                if (sum) {
                  return `${parsed.toString()}\nContent-Type: application/pdf\n`
                    + `Answered from the PDF's text layer by an auxiliary model${sum.model ? ` (${sum.model})` : ''}.\n\n`
                    + `${sum.answer}\n\n`
                    + `[Text layer only. For LAYOUT questions — overflowing text, positions, what it LOOKS like — `
                    + `call \`${CAPTURE_URL_DESIGN}\` on this URL instead.]`
                }
              }
              const trimmed = text.length > 60_000 ? `${text.slice(0, 60_000)}\n…[truncated]` : text
              return `${parsed.toString()}\nContent-Type: application/pdf\n\n${trimmed}\n\n`
                + `[Text layer only. For LAYOUT questions — overflowing text, positions, what it LOOKS like — `
                + `call \`${CAPTURE_URL_DESIGN}\` on this URL instead: text extraction cannot show you a broken layout.]`
            }
          } catch {
            /* não era PDF, ou não tem camada de texto — segue o caminho normal */
          }
        }

        // Fetch DIRECTLY through the CORS-free Rust reqwest proxy (follows up to 5
        // redirects, SSRF-guards internal/metadata addresses, 30s timeout). This
        // replaces the old POST /v1/web-fetch to the control-plane worker, which
        // required a Firebase login and silently dead-ended ("Not authenticated")
        // for BYOK/offline users and was subject to that worker's outages. A
        // browser-like UA gets past sites that 403 obvious bots.
        const invokePromise = invoke<{
          status: number
          statusText: string
          headers: [string, string][]
          body: string
          sizeBytes: number
        }>('http_client_request', {
          input: {
            method: 'GET',
            url: parsed.toString(),
            headers: {
              'User-Agent': WEB_FETCH_UA,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
              'Accept-Language': 'en,*;q=0.5',
            },
            body: null,
            timeoutSecs: 30,
          },
        })

        let result: { status: number; statusText: string; headers: [string, string][]; body: string; sizeBytes: number }
        try {
          // The Rust call can't be cancelled mid-flight, but we let the caller's
          // await return immediately on abort (the request finishes in the
          // background, capped by its 30s timeout — same trade-off as tauriFetch).
          result = signal
            ? await Promise.race([
                invokePromise,
                new Promise<never>((_, reject) =>
                  signal.addEventListener(
                    'abort',
                    () => reject(new DOMException('Request aborted', 'AbortError')),
                    { once: true },
                  ),
                ),
              ])
            : await invokePromise
        } catch (err) {
          if (signal) invokePromise.catch(() => {}) // swallow late rejection if abort won
          if (err instanceof DOMException && err.name === 'AbortError') {
            return `Web fetch cancelled by user (${rawUrl}).`
          }
          const msg = err instanceof Error ? err.message : String(err)
          return `Error fetching ${rawUrl}: ${msg}\n\n${webFetchFallbackHint()}`
        }

        const contentType = (
          result.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
        ).toLowerCase()

        if (result.status >= 400) {
          return `Error: fetching ${parsed.toString()} returned HTTP ${result.status} ${result.statusText}.\n\n${webFetchFallbackHint()}`
        }

        // Cap the RAW body before parsing: the Rust proxy has no response-size
        // limit, and handing a multi-MB page to DOMParser (below) would build a
        // giant DOM and can jank/OOM the renderer. 3 MB is far more markup than
        // any readable page; extraction + the output cap shrink it further.
        // ── Binário não é texto: recusar em vez de despejar bytes ──
        //
        // Reportado em uso real (2026-07-31): o developer colou o URL de um PDF
        // de nota de crédito a pedir a correção do layout. O fetch devolveu
        // `%PDF-1.7` seguido de um stream FlateDecode — 4 KB de binário
        // comprimido. O modelo não viu a imagem NEM o texto (o conteúdo está
        // dentro do stream), corrigiu apenas o que conseguiu inferir lendo o
        // código, e o defeito reportado ficou por corrigir. Devolver bytes
        // gasta contexto e não informa: é estritamente pior do que dizer que
        // não dá e apontar para a ferramenta certa.
        const BINARY_TYPES: ReadonlyArray<[RegExp, string]> = [
          [/application\/pdf/i, 'PDF'],
          [/^image\//i, 'image'],
          [/application\/(zip|gzip|x-tar|octet-stream)/i, 'binary archive'],
          [/^(audio|video)\//i, 'media'],
          [/application\/vnd\.(openxmlformats|ms-)/i, 'Office document'],
        ]
        const binaryKind = BINARY_TYPES.find(([re]) => re.test(contentType))?.[1]
        // PDF: já não é um beco. Grava-se num ficheiro temporário e extrai-se a
        // camada de texto pelo mesmo caminho do `${READ_ALIAS}` — o developer
        // cola o URL de uma factura e o agente lê-lhe o conteúdo. Para
        // perguntas VISUAIS (layout, transbordo) o texto não chega, e a
        // resposta aponta na mesma para o capture_url_design.
        if (binaryKind === 'PDF') {
          try {
            const text = await invoke<string>('fetch_pdf_text', {
              url: parsed.toString(),
            })
            const trimmed = text.length > 60_000 ? `${text.slice(0, 60_000)}\n…[truncated]` : text
            return `${parsed.toString()}\nContent-Type: ${contentType}\n\n${trimmed}\n\n`
              + `[Text layer only. For LAYOUT questions — overflowing text, positions, what it LOOKS like — `
              + `call \`${CAPTURE_URL_DESIGN}\` on this URL instead: text extraction cannot show you a broken layout.]`
          } catch (err) {
            return `${parsed.toString()}\nContent-Type: ${contentType}\n\n`
              + `Could not extract text from this PDF (${formatError(err)}). `
              + `If it is scanned or image-only it has no text layer — call \`${CAPTURE_URL_DESIGN}\` on this URL to see it instead.`
          }
        }
        if (binaryKind) {
          const sizeKb = (result.body.length / 1024).toFixed(0)
          return `${parsed.toString()}\nContent-Type: ${contentType} (${sizeKb} KB)\n\n`
            + `This is a ${binaryKind}, not text — its bytes carry no information you can read here, `
            + `so they are not returned.\n`
            + (binaryKind === 'PDF' || binaryKind === 'image'
              ? `To SEE it, call \`${CAPTURE_URL_DESIGN}\` with this same URL: it opens the document in a real browser, `
                + `screenshots it and returns a visual description (layout, overflowing text, colors, positions). `
                + `That is the only way to judge a rendering or layout problem from a URL.`
              : `Download it with \`${BASH_ALIAS}\` and inspect it with a tool that understands the format.`)
        }

        const MAX_FETCH_BODY_CHARS = 3_000_000
        let body = result.body
        let bodyTruncated = false
        if (body.length > MAX_FETCH_BODY_CHARS) {
          body = body.slice(0, MAX_FETCH_BODY_CHARS)
          bodyTruncated = true
        }

        const isHtml =
          contentType.includes('text/html') ||
          contentType.includes('application/xhtml') ||
          (!contentType && looksLikeHtml(body))

        // mode:'raw' bypasses extraction entirely — the agent gets the real
        // markup (classes, inline styles, attributes). Still subject to the
        // 3MB parse cap above and the maxLength cap below.
        const rawMode = input.mode === 'raw'

        let title = ''
        let content: string
        let designFooter = ''
        if (isHtml && !rawMode) {
          const page = htmlToText(body, parsed.toString())
          title = page.title
          content = page.text
          // Design signals: stylesheet URLs (fetch them for colors/fonts/
          // spacing) + inline <style> presence (fetch mode:'raw' to read it).
          // Capped at 15 — past that it's bundler noise, not design intent.
          const parts: string[] = []
          if (page.stylesheets.length > 0) {
            const shown = page.stylesheets.slice(0, 15)
            parts.push(
              `Stylesheets (fetch these URLs to read the page's CSS — colors, fonts, spacing):\n${shown.map(u => `- ${u}`).join('\n')}` +
              (page.stylesheets.length > shown.length ? `\n(+${page.stylesheets.length - shown.length} more)` : ''),
            )
          }
          if (page.inlineStyleChars > 0) {
            parts.push(`Inline <style> blocks: ~${page.inlineStyleChars} chars of CSS are inlined in the page — fetch with mode:"raw" to read them.`)
          }
          if (parts.length > 0) designFooter = `\n\n${parts.join('\n\n')}`
        } else {
          // raw mode, or JSON / plain text / CSS / markdown — return as-is
          // (normalized only by size cap).
          content = body
        }

        // ── Sidecar: responder À PERGUNTA em vez de devolver a página ──
        //
        // Porte do contrato do claude-vaz (WebFetchTool): com um `prompt`, a
        // página é processada por um modelo rápido e o agente recebe a
        // RESPOSTA. Uma página de 200 KB passa a três linhas no contexto em
        // vez de 50 000 caracteres cortados a meio — e o que era irrelevante
        // (navegação, rodapés, banners) nunca entra no transcript, logo também
        // não sobrevive à compactação.
        //
        // `raw` fica de fora de propósito: quem pede markup quer o markup.
        // Sem sidecar disponível cai-se no texto integral — o sumarizador
        // nunca faz o fetch falhar.
        if (!rawMode && content.trim()) {
          ;(await import('./fetchSidecar')).cachePageContent(parsed.toString(), content)
        }

        const askPrompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
        if (askPrompt && !rawMode && content.trim()) {
          const { answerFromPageViaSidecar } = await import('./fetchSidecar')
          const summarised = await answerFromPageViaSidecar(content, askPrompt, parsed.toString(), signal)
          if (summarised) {
            return [
              `URL: ${parsed.toString()}`,
              `Status: ${result.status} ${result.statusText}`,
              title ? `Title: ${title}` : '',
              `Answered from the page by an auxiliary model${summarised.model ? ` (${summarised.model})` : ''} — this is not the page verbatim.`,
              '',
              summarised.answer,
              designFooter,
              '',
              `[Ask again with a different prompt to get more from this page, or omit the prompt to receive the raw text.]`,
            ].filter(Boolean).join('\n')
          }
        }

        // truncated = the raw body was over the parse cap OR the extracted text
        // is over the caller's maxLength.
        let truncated = bodyTruncated

        const header = [
          `URL: ${parsed.toString()}`,
          `Status: ${result.status} ${result.statusText}`,
          contentType ? `Content-Type: ${contentType}` : '',
          title ? `Title: ${title}` : '',
        ]
          .filter(Boolean)
          .join('\n')

        // O CORTE CONTA O ENVELOPE (auditoria 2026-07-29).
        //
        // Antes, o conteúdo era cortado em exactamente `maxLength` (50000 por
        // omissão) e só DEPOIS se somavam cabeçalho, rodapé de design e nota de
        // truncagem. O resultado passava dos 50000 — que é precisamente o tecto
        // do `getToolResultMaxChars('web_fetch')` — e o `truncateResult`
        // devolvia ao modelo um PREVIEW DE 2000 caracteres de uma página que
        // ele mandara buscar inteira. Ou seja: o default do schema garantia a
        // paginação que o ramo de 07-28 tinha vindo evitar.
        //
        // O tecto do resultado é o orçamento REAL. Corta-se o conteúdo para o
        // que sobra dele depois do envelope, e a nota diz o número verdadeiro.
        const ceiling = ToolExecutor.getToolResultMaxChars('web_fetch')
        const truncationNotice = (limit: number): string =>
          `\n\n[Content truncated at ${limit} chars. Re-fetch with a higher maxLength, or a more specific URL/anchor, if you need more.]`
        const envelope = `${header}\n\n${designFooter}`.length + truncationNotice(maxLength).length
        const contentBudget = Math.max(1_000, Math.min(maxLength, ceiling - envelope))
        if (content.length > contentBudget) {
          content = content.slice(0, contentBudget)
          truncated = true
        }

        // designFooter carries stylesheet URLs + inline-style signal — append
        // AFTER the body so the model sees content first, then the design-copy
        // affordances. Truncation notice comes last so it is never buried.
        let output = `${header}\n\n${content}${designFooter}`
        if (truncated) {
          output += truncationNotice(contentBudget)
        }
        return output
      }
    })

    // === capture_url_design ===
    // Conversational "see this URL and copy the design": boot the Playwright
    // browser, screenshot, describe via vision sidecar. Complements web_fetch
    // (structure/CSS) with a visual handoff. See captureUrlDesign.ts.
    this.tools.set(CAPTURE_URL_DESIGN, {
      definition: {
        name: CAPTURE_URL_DESIGN,
        description:
          `Open a public http(s) URL in a real browser, take a screenshot, and return a detailed visual design description (layout, colors, typography, components, all visible text). Use when the user asks to see/copy/recreate a website design or a section of it. Pair with ${WEB_FETCH_ALIAS} (text + stylesheet list + mode:"raw") for markup/CSS tokens. Requires Node.js + Chrome/Edge/Brave on the machine (same stack as /te2e). Optional focus narrows the description (e.g. "hero only", "pricing cards").`,
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full http(s) URL to capture' },
            focus: {
              type: 'string',
              description: 'Optional focus hint, e.g. "hero section", "nav + footer", "pricing cards only"',
            },
            full_page: {
              type: 'boolean',
              description: 'Capture the full scrollable page (default true). Set false for viewport only.',
            },
          },
          required: ['url'],
        },
        // Serial: shares one browser session; concurrent captures would race.
        concurrencySafe: false,
      },
      execute: async (input) => {
        const { captureUrlDesign, withBrowserExclusive } = await import('./captureUrlDesign')
        // Mutex GLOBAL do browser singleton: com multi-agentes (main + até 4
        // tarefas) capturas concorrentes serializam em vez de interlear na
        // mesma tab — concurrencySafe:false só serializa DENTRO de um run.
        return withBrowserExclusive(() => captureUrlDesign({
          url: String(input.url ?? ''),
          focus: typeof input.focus === 'string' ? input.focus : undefined,
          fullPage: input.full_page !== false && input.fullPage !== false,
          signal: input._abortSignal as AbortSignal | undefined,
        }))
      },
    })

    // send_agent_message — REMOVIDA do registry (2026-08-03). Ficara registada
    // "para dar um erro honesto a transcrições antigas", mas o preço era o def
    // viajar em TODOS os pedidos de TODOS os runs — custo permanente a proteger
    // um caso raro, que agora recebe o erro padrão de tool desconhecida. A
    // doutrina (um agente por projecto) continua em parallelTasks/policy.ts e
    // no prompt das tarefas paralelas.

    // === execute_command ===
    this.tools.set('execute_command', {
      definition: {
        name: 'execute_command',
        description: 'Execute a shell command in the project directory. Blocks until the command exits or the timeout is reached — do NOT use for dev servers or watchers (they never exit). Use for running tests, installing dependencies, building, linting, or short-lived CLI operations. Returns stdout, stderr, and exit code. Default timeout: 120 seconds.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute (e.g., "pnpm install", "pnpm test", "ls -la")' },
            cwd: { type: 'string', description: 'Working directory. Default: project root' },
            timeout_secs: { type: 'number', description: 'Timeout in seconds. Default: 120. Max: 600.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const cmd = (input.command as string).trim()
        this.validateCommand(cmd)

        // Scope cwd to project root or dynamic terminal directory
        const projectRoot = this.getProjectRoot()
        const cwd = this.resolveToAbsolute((input.cwd as string) || (this.cmdModeCwd || projectRoot))
        await this.requirePathAccess(cwd)

        // Detect package-manager install commands so they get the streaming
        // execution path (real-time logs in chat + PID-based cancellation).
        // We no longer skip repeated installs — npm/yarn/pnpm/bun are all
        // idempotent (they only mutate node_modules when something changed),
        // and the prior skip-memo caused false positives that masked real
        // installs. Trust the package manager.
        const normalizedCmd = cmd.replace(/\s+/g, ' ')
        const directInstall = normalizedCmd.match(/^((?:npm|yarn|pnpm|bun)\s+(?:install|ci|add|remove|uninstall))\b/)
          || normalizedCmd.match(/^(pip\s+install)\b/)
        const compoundInstall = !directInstall
          ? normalizedCmd.match(/^cd\s+(\S+)\s*&&\s*((?:npm|yarn|pnpm|bun)\s+(?:install|ci|add|remove|uninstall))\b/)
          : null
        const isInstallCmd = directInstall !== null || compoundInstall !== null

        const callSignal = input._abortSignal as AbortSignal | undefined

        if (isInstallCmd) {
          // timeout_secs vale também aqui (auditoria 2026-07-28): o schema
          // anuncia Max 600 e o caminho de install ignorava-o, fixo em 300s —
          // um monorepo grande estourava sem hipótese de o modelo pedir mais.
          // Default mais generoso (300s) porque instalar é lento por natureza.
          return this.executeInstallStreaming(
            cmd,
            cwd,
            input._toolCallId as string | undefined,
            callSignal,
            Math.min(Number(input.timeout_secs) || 300, 600),
          )
        }

        // Detect build/test/lint/script commands for streaming execution.
        // These commands benefit from real-time log output so the user can
        // monitor progress, see compilation errors as they happen, and get
        // immediate feedback on test results.
        if (isStreamingCommand(cmd)) {
          const timeoutSecs = Math.min(Number(input.timeout_secs) || 120, 600)
          return this.executeStreamingCommand(
            cmd,
            cwd,
            input._toolCallId as string | undefined,
            callSignal,
            timeoutSecs,
          )
        }

        // Agent default: 120s. Clamp to max 600s.
        const timeoutSecs = Math.min(Number(input.timeout_secs) || 120, 600)

        return this.executeStreamingCommand(
          cmd,
          cwd,
          input._toolCallId as string | undefined,
          callSignal,
          timeoutSecs,
        )
      }
    })

    // === start_dev_server ===
    this.tools.set('start_dev_server', {
      definition: {
        name: 'start_dev_server',
        description: `Start the project's dev server as a background process. Returns immediately and the server keeps running in the background. The preview does NOT open by itself. If the user should inspect the running app, finish by telling them to click the **Preview** button (top-right of the chat). Leave the server running by default while the project is being developed; use stop_dev_server only on explicit request, before a required restart, during project switch/removal, or for port/process cleanup. ONE dev server per project.

Pass the command that runs the WHOLE project (e.g. "npm run dev" — even if it fans out frontend+backend via concurrently, workspaces, or turbo).

project_kind: "frontend" (UI-only → iframe preview), "backend" (API-only → HTTP Client panel), "fullstack" (both — iframe + toggleable HTTP Client drawer). Auto-detected if omitted.

Ports: the framework picks the port (Vite=5173, Next=3000, Express=whatever your scripts bind). The IDE detects the URL from log output and classifies frontend/backend by HTTP content-type — you do not need to pass any port.

frontend_port_hint is OPTIONAL: pass it ONLY if both servers happen to respond with the same content-type and the IDE assigned the wrong URL to the iframe. Most projects do not need it.`,
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Dev server command (e.g., "npm run dev", "pnpm start", "npx vite"). Pass the top-level command even if it spawns multiple processes.' },
            project_kind: { type: 'string', enum: ['frontend', 'backend', 'fullstack'], description: '"frontend", "backend", or "fullstack". Auto-detected if omitted.' },
            frontend_port_hint: { type: 'number', description: 'Optional override for fullstack content-type ambiguity. Treats the URL on this port as frontend regardless of what it serves. Use only when the automatic content-type classifier picks the wrong URL.' },
            server_type: { type: 'string', enum: ['frontend', 'backend'], description: 'DEPRECATED — use project_kind instead.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const command = input.command as string
        let projectKind = input.project_kind as 'frontend' | 'backend' | 'fullstack' | undefined
        const legacyServerType = input.server_type as 'frontend' | 'backend' | undefined
        const explicitHint = typeof input.frontend_port_hint === 'number' ? input.frontend_port_hint : undefined
        this.validateCommand(command, { allowDevServer: true })
        const projectRoot = this.getProjectRoot()

        // Legacy server_type maps to the new project_kind
        if (!projectKind && legacyServerType) {
          projectKind = legacyServerType
        }

        // Infer from project files if still not provided
        if (!projectKind) {
          try {
            const { detectProjectCategory, categoryToServerHint } = await import('../../services/projectTypeDetector')
            const cat = await detectProjectCategory(projectRoot)
            const hint = categoryToServerHint(cat)
            projectKind = hint
          } catch { /* detection failure is non-fatal */ }
        }
        if (!projectKind) projectKind = 'frontend'

        // Frontend-port hint precedence:
        //   1. Explicit `frontend_port_hint` argument from the agent (the
        //      escape hatch when the agent has observed a misclassification).
        //   2. The `.toquemedia-template` manifest's `frontendPort` (scaffolds
        //      ship this for known fullstack templates).
        // Either source feeds the same classifier knob — the agent doesn't
        // need to know which template was used.
        let frontendPortHint = explicitHint
        if (frontendPortHint === undefined) {
          try {
            const { resolveFrontendPortHint } = await import('../../services/templateService')
            frontendPortHint = await resolveFrontendPortHint(projectRoot, projectKind)
          } catch { /* missing manifest is fine — no hint to apply */ }
        }

        try {
          await devServerManager.start(projectRoot, command, { projectKind, frontendPortHint })
          const url = devServerManager.getUrl()
          const hintNote = frontendPortHint ? ` [frontend port hint: ${frontendPortHint}]` : ''
          if (url) {
            return `Dev server started and running at ${url} (${projectKind})${hintNote}. The preview does NOT open automatically. Keep it running for continued development and tell the user to click the Preview button (top-right of the chat) when they want to inspect it.`
          }
          return `Dev server starting with command: ${command} (${projectKind})${hintNote}. It boots in the background; the preview does NOT open automatically. Keep it running for continued development and tell the user to click the Preview button (top-right of the chat) when they want to inspect it.`
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error starting dev server: ${msg}. You can try a different command or check that dependencies are installed.`
        }
      }
    })

    // === stop_dev_server ===
    this.tools.set(STOP_DEV_SERVER, {
      definition: {
        name: STOP_DEV_SERVER,
        description: 'Stop the currently running project dev server started by start_dev_server. Do not use this as routine cleanup after successful verification. Use it only when the user explicitly asks, before a required restart, during project switch/removal, or to resolve a port/process conflict.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      execute: async () => {
        if (!devServerManager.isActive()) {
          return 'No dev server is running.'
        }

        try {
          await devServerManager.stop()
          return 'Dev server stopped.'
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          return `Error stopping dev server: ${msg}`
        }
      },
    })



    // === read_dev_server_logs ===
    this.tools.set('read_dev_server_logs', {
      definition: {
        name: 'read_dev_server_logs',
        description: 'Read output from the dev server AND browser runtime errors from the live preview. Includes: build errors, type errors, HMR failures (from dev server stdout/stderr), plus uncaught exceptions, unhandled promise rejections, console.error, and HTTP 4xx/5xx responses from fetch/XMLHttpRequest in the preview browser (all prefixed [runtime]). Network failures appear as `[runtime] Network: METHOD URL → STATUS STATUSTEXT` — use them to confirm auth-proxy endpoints, /api/* routes, and backend integrations actually return 2xx during testing (a green dev server start does NOT mean the app works end-to-end). Use after file changes, after start_dev_server, or when asked about preview/console/browser/network errors. The buffer is CUMULATIVE — old errors are not cleared when the dev server reloads after a fix. Each entry comes with its timestamp; the response footer includes a cursor (`next_since: <ms>`). Pass that cursor as `since_timestamp` on the next call to get only entries that arrived AFTER your last read — this is how you tell whether your fix actually resolved the previous error vs. seeing the same stale entry. Without `since_timestamp`, you get the tail of the full buffer (default 50 lines).',
        input_schema: {
          type: 'object',
          properties: {
            lines: { type: 'number', description: 'Number of log lines to return when reading the tail. Default: 50. Max: 200. Ignored when since_timestamp is set.' },
            level: { type: 'string', enum: ['all', 'error', 'warn'], description: 'Filter by log level. "error" shows only errors. "warn" shows errors and warnings. "all" shows everything. Default: all.' },
            since_timestamp: { type: 'number', description: 'Unix epoch milliseconds — return only entries with timestamp > this value. Use the next_since cursor from the previous read to get just-arrived entries (the right way to verify a fix landed). Omit on first read.' }
          },
          required: []
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        const { useLayoutStore, DEV_LOG_EVENT } = await import('../../stores/layoutStore')

        if (!devServerManager.isActive()) {
          return 'No dev server is running. Start one with start_dev_server.'
        }

        // Event-driven wait for runtime errors. Browser runtime errors
        // (uncaught exceptions, SyntaxError from bad imports) arrive via the
        // preview WebView's IPC → CustomEvent → addDevServerLog pipeline.
        // This pipeline has latency: browser loads → executes JS → throws
        // → dispatches IPC → addDevServerLog fires event.
        //
        // Strategy:
        //   1. Check for RECENT errors (last 5s) — not stale ones from
        //      previous deploys that are already fixed.
        //   2. Only wait if the dev server reloaded recently (last 5s) —
        //      if the server has been stable for a while, no point waiting.
        //   3. Subscribe to DEV_LOG_EVENT and return immediately when an
        //      error arrives. Timeout after 3s.
        //   4. Re-check after subscribing to close the race window between
        //      the initial check and the addEventListener.
        const RECENCY_WINDOW = 5000
        const now = Date.now()

        const hasRecentErrors = () =>
          useLayoutStore.getState().devServerLogs.some(
            l => l.level === 'error' && l.timestamp > now - RECENCY_WINDOW,
          )

        // Only wait if: no recent errors AND server had recent activity
        // (a log was added in the last 5s — proxy for "just reloaded").
        const hasRecentActivity = () => {
          const logs = useLayoutStore.getState().devServerLogs
          return logs.length > 0 && logs[logs.length - 1].timestamp > now - RECENCY_WINDOW
        }

        if (!hasRecentErrors() && hasRecentActivity()) {
          await new Promise<void>(resolve => {
            let timer: ReturnType<typeof setTimeout>
            const handler = (e: Event) => {
              const detail = (e as CustomEvent<{ level: string }>).detail
              if (detail.level === 'error') {
                clearTimeout(timer)
                window.removeEventListener(DEV_LOG_EVENT, handler)
                resolve()
              }
            }
            window.addEventListener(DEV_LOG_EVENT, handler)

            // Re-check: error may have arrived between hasRecentErrors()
            // and addEventListener — close the race window.
            if (hasRecentErrors()) {
              clearTimeout(timer!)
              window.removeEventListener(DEV_LOG_EVENT, handler)
              resolve()
              return
            }

            timer = setTimeout(() => {
              window.removeEventListener(DEV_LOG_EVENT, handler)
              resolve()
            }, 3000)
          })
        }

        const logs = useLayoutStore.getState().devServerLogs

        if (logs.length === 0) {
          // CURSOR TAMBÉM AQUI (auditoria 2026-07-29). A descrição da tool
          // promete um `next_since` no rodapé e manda passá-lo na chamada
          // seguinte; este ramo devolvia texto sem cursor. Consequência: numa
          // primeira leitura antes de o servidor escrever nada, o modelo ficava
          // sem cursor, chamava outra vez sem `since_timestamp` e recebia a
          // cauda inteira do buffer — sem forma de distinguir o erro NOVO do
          // erro velho que ele acabou de corrigir. É precisamente o trabalho
          // para o qual o cursor existe.
          //
          // `- 1` porque o filtro é `> since`: um log escrito neste mesmo
          // milissegundo seria saltado com o valor exacto.
          return `Dev server is running but has produced no output yet.\nnext_since: ${Date.now() - 1}`
        }

        // The buffer is cumulative — old errors persist after fixes.
        // since_timestamp lets the agent fetch only entries that arrived
        // after its last read, which is the only reliable way to tell
        // whether a fix actually resolved the previous error.
        const sinceTimestamp = (input.since_timestamp as number) || 0
        const maxLines = Math.min((input.lines as number) || 50, 200)
        const levelFilter = (input.level as string) || 'all'

        let filtered = logs
        if (sinceTimestamp > 0) {
          filtered = filtered.filter(l => l.timestamp > sinceTimestamp)
        }
        if (levelFilter === 'error') {
          filtered = filtered.filter(l => l.level === 'error')
        } else if (levelFilter === 'warn') {
          filtered = filtered.filter(l => l.level === 'warn' || l.level === 'error')
        }

        // Tail-slice only when no cursor was provided. With since_timestamp
        // the agent wants the full delta, not the tail of it.
        const recent = sinceTimestamp > 0 ? filtered : filtered.slice(-maxLines)

        // Cursor for the next call — always the last entry's timestamp in
        // the FULL (unfiltered) buffer, not the filtered slice. Otherwise
        // a level=error read would skip past info entries and the next
        // since_timestamp call would re-surface them as "new".
        const nextSince = logs[logs.length - 1].timestamp

        if (recent.length === 0) {
          const sinceLabel = sinceTimestamp > 0 ? ' since last read' : ''
          return `No ${levelFilter === 'all' ? 'new ' : levelFilter + '-level '}logs${sinceLabel}. Dev server appears healthy.\nnext_since: ${nextSince}`
        }

        const formatted = recent.map(l => {
          const prefix = l.level === 'error' ? 'ERROR' : l.level === 'warn' ? 'WARN' : 'INFO'
          return `[${prefix}] [${l.timestamp}] ${l.text}`
        }).join('\n')

        const errorCount = recent.filter(l => l.level === 'error').length
        const warnCount = recent.filter(l => l.level === 'warn').length
        const header = sinceTimestamp > 0
          ? `Dev server logs since ${sinceTimestamp} (${recent.length} new entries, ${errorCount} errors, ${warnCount} warnings):`
          : `Dev server logs (${recent.length} lines, ${errorCount} errors, ${warnCount} warnings):`

        return `${header}\n${formatted}\nnext_since: ${nextSince}`
      }
    })

    // === delegate (sub-agent delegation — v0.7.0) ===
    this.tools.set('delegate', {
      definition: {
        name: 'delegate',
        description: `Delegate a task to a team member. Returns immediately — the task runs in background while you continue working.\n\nAvailable team members:\n  Explore — Read-only codebase search (${GLOB_ALIAS}, ${GREP_ALIAS}, ${READ_ALIAS}, ${LS_ALIAS}). Use for "find all usages of X", "where is Y defined", "list every file that imports Z".\n  Research — Web research + skill lookup + read-only diagnostics (${WEB_SEARCH_ALIAS}, ${WEB_FETCH_ALIAS}, read_skill, curl via ${BASH_ALIAS}). Use for "find the API docs for X", "what's the auth shape of service Y".\n  Verify — Adversarial verification (read + execute, no writes). Use after non-trivial changes (3+ files, backend/API work) to catch issues before reporting done. Its prompt MUST state what the task was, how you implemented it, and the EXACT files you changed — it sees nothing of your conversation and cannot verify what it cannot locate. Ends with a verdict: PASS, FAIL, or PARTIAL. For a quick type-check alone, prefer ${BASH_ALIAS}("npx tsc --noEmit 2>&1") — it is faster and more direct than delegating.\n\nAll tasks run in parallel. Results are DELIVERED to you automatically when each member finishes — mid-run at your next step if you are still working, or by an auto-wake if you are idle. After delegating:\n  • If you have other work to do (reads, edits, analysis), do it in the same turn — results will arrive as you work.\n  • If you have nothing else to do, end your turn and tell the user you delegated and will synthesize when the results arrive.\n  • NEVER poll collect_results while members are running — it is a manual fallback for full untruncated text, not a waiting mechanism.\n\nWhen NOT to use:\n  • The task is a single ${READ_ALIAS} call — just do it directly.\n  • The task requires editing files — team members are read-only.\n  • You already have the answer in your context.`,
        input_schema: {
          type: 'object',
          properties: {
            subagent_type: {
              type: 'string',
              enum: ['Explore', 'Research', 'Verify'],
              description: 'Which team member to delegate to.'
            },
            member: {
              type: 'string',
              enum: ['Explore', 'Research', 'Verify'],
              description: 'Alias for subagent_type. Which team member to delegate to.'
            },
            team_member: {
              type: 'string',
              enum: ['Explore', 'Research', 'Verify'],
              description: 'Alias for subagent_type. Which team member to delegate to.'
            },
            description: {
              type: 'string',
              description: 'Short label (3-5 words) for the task. Shown in the team activity indicator.'
            },
            prompt: {
              type: 'string',
              description: 'Self-contained task description. The team member sees nothing from your conversation. Be specific about what you need back as a final summary.'
            },
            task: {
              type: 'string',
              description: 'Alias for prompt. Self-contained task description.'
            },
            thoroughness: {
              type: 'string',
              enum: ['quick', 'medium', 'thorough'],
              description: 'Controls search depth. "quick" = first match, stop. "medium" = check 2-3 locations. "thorough" = comprehensive sweep across naming conventions and edge cases. Default: medium.'
            }
          },
          required: []
        },
        concurrencySafe: true,
      },
      execute: async (input) => {
        // ── Alias normalization ──
        // The schema's canonical field is `subagent_type`, but models may send
        // `member`, `type`, `agentType`, `subAgentType`, or `name` instead.
        // Normalize defensively so a field-name mismatch never silently breaks
        // delegation. The canonical field in the schema is `subagent_type`;
        // `member` is declared as an alias property so the model sees it too.
        const ALIASES = ['subagent_type', 'member', 'team_member', 'teamMember', 'type', 'agentType', 'subAgentType', 'name'] as const
        let rawMember: string | undefined
        for (const alias of ALIASES) {
          const v = input[alias]
          if (typeof v === 'string' && v.trim()) {
            rawMember = v.trim()
            break
          }
        }

        // Track telemetry for the usage log (read by query.ts onRequestUsage).
        this.lastDelegateInfo = {
          requestedMember: rawMember ?? null,
          resolvedMember: null,
          blocked: false,
          blockedReason: null,
          inputSchemaVersion: 'v2-aliases',
          recoveryAttempted: false,
        }

        const AVAILABLE = ['Explore', 'Research', 'Verify']
        if (!rawMember) {
          this.lastDelegateInfo.blocked = true
          this.lastDelegateInfo.blockedReason = 'No member field found in input'
          throw new Error(jsonMini({
            status: 'blocked',
            reason: 'No team member specified. Pass subagent_type (or member alias) as one of: Explore, Research, Verify.',
            receivedInput: Object.keys(input),
            availableMembers: AVAILABLE,
          }))
        }

        // Case-insensitive resolve against the canonical names.
        const resolved = AVAILABLE.find((a) => a.toLowerCase() === rawMember!.toLowerCase())
        if (!resolved) {
          this.lastDelegateInfo.blocked = true
          this.lastDelegateInfo.blockedReason = `Unknown member '${rawMember}'`
          throw new Error(jsonMini({
            status: 'blocked',
            reason: `Unknown team member '${rawMember}'. Available: ${AVAILABLE.join(', ')}.`,
            receivedInput: { member: rawMember, description: input.description, prompt: input.prompt },
            availableMembers: AVAILABLE,
          }))
        }

        this.lastDelegateInfo.resolvedMember = resolved
        const subagentType = resolved
        const prompt =
          typeof input.prompt === 'string' && input.prompt.trim()
            ? input.prompt
            : typeof input.task === 'string' && input.task.trim()
              ? input.task
              : ''
        if (!prompt) {
          this.lastDelegateInfo.blocked = true
          this.lastDelegateInfo.blockedReason = 'No prompt/task field found in input'
          throw new Error(jsonMini({
            status: 'blocked',
            reason: 'No task prompt specified. Pass prompt (or task alias) with a self-contained task for the team member.',
            receivedInput: Object.keys(input),
            availableMembers: AVAILABLE,
          }))
        }
        const description =
          (typeof input.description === 'string' && input.description.trim())
            ? input.description
            : prompt.split(/\s+/).slice(0, 5).join(' ')
        const thoroughness = (input.thoroughness as string as 'quick' | 'medium' | 'thorough') || 'medium'

        // Resolve the definition (concurrent limit is checked atomically inside startRun)
        const { getAgentDefinition } = await import('./subAgents/builtInAgents')
        const def = getAgentDefinition(subagentType as 'Explore' | 'Research' | 'Verify')
        if (!def) {
          this.lastDelegateInfo.blocked = true
          this.lastDelegateInfo.blockedReason = `getAgentDefinition returned null for '${subagentType}'`
          throw new Error(jsonMini({
            status: 'blocked',
            reason: `Internal error: team member '${subagentType}' is recognized but has no definition. Available: ${AVAILABLE.join(', ')}.`,
            receivedInput: { member: rawMember },
            availableMembers: AVAILABLE,
          }))
        }

        // Build filtered tools — only the sub-agent's allowed tools
        const allowedTools = new Set(def.tools)
        const disallowedTools = new Set(def.disallowedTools ?? [])
        const filteredTools: OpenAIToolDefinition[] = []
        for (const [name, entry] of this.tools) {
          if (name === 'delegate' || name === 'collect_results') continue // block recursive delegation
          if (disallowedTools.has(name)) continue
          if (allowedTools.has(name)) {
            filteredTools.push({
              type: 'function' as const,
              function: {
                name: entry.definition.name,
                description: entry.definition.description,
                parameters: entry.definition.input_schema,
              },
            })
          }
        }

        // Build parent context
        const settingsStore = (await import('../../stores/settingsStore')).useSettingsStore.getState()
        const parentCtx = {
          cmdOnlyMode: !!this.ctx.getCmdModeCwd(),
          // Tarefa isolada em worktree (Fase 5): a equipa delegada explora a
          // ÁRVORE DA TAREFA (com as edições dela), não o checkout principal
          // desatualizado — cmdModeCwd é o worktree quando ativo.
          workingPath: this.ctx.getCmdModeCwd() ?? this.ctx.getProjectRoot(),
          agentLanguage: settingsStore.agentLanguage ?? 'en',
          thoroughness,
        }

        // Get parent message ID — find the USER message that triggered
        // this turn, not the streaming assistant message (which is last).
        // Delegação de TAREFA PARALELA (Fase 3): ancora o SubAgentCard na
        // SESSÃO DA TAREFA (o user vê a equipa dela no chat dela), nunca na
        // sessão que o user está a ver.
        const { useChatStore } = await import('../../stores/chatStore')
        const chatState = useChatStore.getState()
        const taskOwner = this.permissionOrigin
        const anchorSessionId = taskOwner?.sessionId ?? chatState.activeSessionId
        const session = anchorSessionId ? chatState.sessions.get(anchorSessionId) : null
        const messages = session?.messages || []
        let parentMessageId: string | undefined
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            parentMessageId = messages[i].id
            break
          }
        }

        // Fire and forget — returns immediately. Throws if concurrent limit (4) is reached.
        let runId: string
        try {
          const { runSubAgent } = await import('./subAgents/subAgentRunner')
          runId = await runSubAgent({
            definition: def,
            prompt,
            description,
            parentMessageId,
            parentCtx,
            filteredTools,
            requestType: this.requestType ?? undefined,
            ownerTaskId: taskOwner?.taskId,
          })
        } catch (e) {
          throw new Error(`Failed to start ${subagentType} sub-agent: ${e instanceof Error ? e.message : String(e)}`)
        }

        // Wire subAgentRunIds so SubAgentCard renders in the UI.
        if (parentMessageId) {
          chatState.appendSubAgentRunId(parentMessageId, runId)
        }

        return `Task ${runId} started (${subagentType}: "${description}"). Results will be available when ready.`
      }
    })

    // === collect_results (v0.7.0) ===
    this.tools.set('collect_results', {
      definition: {
        name: 'collect_results',
        description: 'Collect results from team members. Returns immediately with all finished results. If some members are still running, their status is shown but results are not yet available. Do not poll repeatedly; the system auto-wakes you when new results arrive. After seeing running tasks, end your turn unless you have independent work to do.',
        input_schema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      execute: async () => {
        const { useSubAgentStore } = await import('../../stores/subAgentStore')
        const store = useSubAgentStore.getState()

        // Owner scoping (Fase 3): uma tarefa só vê a SUA equipa; o main só a
        // dele — resultados nunca cruzam donos.
        const ownerTaskId = this.permissionOrigin?.taskId
        const ownedSummaries = store
          .getRunSummaries()
          .filter(s => (s.ownerTaskId ?? undefined) === ownerTaskId)

        // Nothing to check
        if (ownedSummaries.length === 0) {
          return `No team tasks are active. Use the ${TASK_ALIAS} tool to assign work to team members first.`
        }

        // Circuito: nada mudou desde a última chamada → recusa.
        //
        // A assinatura são os ids AINDA A CORRER. Se um membro tiver acabado no
        // intervalo, a assinatura muda, o contador reinicia e o relatório vem
        // normalmente — o que se recusa é só voltar a perguntar o que já se
        // sabe. Os resultados são ENTREGUES automaticamente (auto-wake), por
        // isso parar o turno aqui nunca perde nada.
        const runningSignature = ownedSummaries
          .filter(sm => sm.status === 'running')
          .map(sm => sm.id)
          .sort()
          .join(',')
        if (runningSignature && runningSignature === this.lastCollectResultsSignature) {
          this.collectResultsRepeats += 1
        } else {
          this.collectResultsRepeats = 0
          this.lastCollectResultsSignature = runningSignature
        }
        if (this.collectResultsRepeats >= 1) {
          return (
            `Nothing has changed since your last collect_results — the same team member(s) are still working, and this call cost a full round-trip to learn that.\n\n` +
            `END YOUR TURN NOW. Their results are delivered to you automatically the moment they finish (mid-run or via auto-wake), so stopping here does not abandon the work. ` +
            `If you have independent work that does NOT depend on them, do that instead — but do not ask again.`
          )
        }

        const { buildTeamResultsReport } = await import('./subAgents/resultsReport')
        const { markSubAgentResultsDelivered } = await import('./subAgents/autoWake')

        const report = buildTeamResultsReport(ownedSummaries, {
          includeRunning: true,
          lastActionFor: (id) => {
            // Last tool call so the model can see the sub-agent is progressing.
            const run = store.runs.get(id)
            const lastTc = run?.toolCalls.length ? run.toolCalls[run.toolCalls.length - 1] : null
            return lastTc ? `${lastTc.toolName} (${lastTc.status})` : null
          },
        })

        // These results are now in the model's context — the push-delivery
        // path must never re-send them.
        markSubAgentResultsDelivered(report.finishedIds)

        const lines = [report.text]
        if (report.runningCount > 0) {
          lines.push(
            `${report.runningCount} team member${report.runningCount > 1 ? 's are' : ' is'} still working. ` +
            `Do NOT call collect_results again to wait — their results are DELIVERED to you automatically ` +
            `(mid-run or via auto-wake). End your turn unless you have independent work to do.`,
          )
        }

        // Only clear completed runs when ALL runs are done (no running left).
        // If some are still running, keep completed ones so the model can still
        // reference them in its next turn (deliveries fire again as the
        // remaining ones finish). OWNER GUARD (Fase 3): clearCompleted é
        // owner-blind — só limpa quando não existem runs de OUTROS donos,
        // senão o collect_results de uma tarefa apagava resultados do main
        // (ou vice-versa) antes de serem entregues.
        const hasOtherOwners = store
          .getRunSummaries()
          .some(s => (s.ownerTaskId ?? undefined) !== ownerTaskId)
        if (report.runningCount === 0 && !hasOtherOwners) {
          store.clearCompleted()
        }

        return lines.join('\n')
      }
    })

    // ── Domain extractions (SOLID decomposition) ─────────────────────
    // provision_* tools (managed-platform auth/database/files/deploy) were
    // deregistered in the dev-only-IDE pivot (2026-07); the managed layer
    // lives in TM Code Web.
    registerTaskTools(this.ctx)
    registerMemoryTools(this.ctx)
    registerInteractionTools(this.ctx)

    // === agent_shell_* (persistent PTY controlled by the agent) ===
    this.tools.set('agent_shell_start', {
      definition: {
        name: 'agent_shell_start',
        description: 'Start a persistent interactive shell session for the agent. Use this when the task benefits from staying inside a real shell or SSH session across multiple steps. Returns a session_id. After this, call agent_shell_write with one command at a time, then agent_shell_read to observe more output.',
        input_schema: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory. Defaults to the project root or active workspace cwd.' },
            wait_ms: { type: 'number', description: 'How long to wait for the initial shell prompt/output. Default: 500. Max: 5000.' },
          },
          required: [],
        },
      },
      execute: async (input) => {
        await this.ensureAgentShellListeners()
        const projectRoot = this.getProjectRoot()
        const cwd = this.resolveToAbsolute((input.cwd as string) || (this.cmdModeCwd || projectRoot))
        await this.requirePathAccess(cwd)

        const sessionId = `agent-shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const session: AgentShellSession = {
          id: sessionId,
          cwd,
          output: '',
          readOffset: 0,
          activeToolCallId: input._toolCallId as string | null | undefined || null,
          exited: false,
          exitCode: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        this.agentShellSessions.set(sessionId, session)
        this.lastAgentShellSessionId = sessionId

        let shellInfo: InteractiveShellInfo | null = null
        try {
          shellInfo = await invoke<InteractiveShellInfo>('get_interactive_shell_info')
        } catch {
          shellInfo = null
        }

        await invoke<string>('start_pty_shell', { sessionId, cwd })
        await this.waitForAgentShellOutput(session, 0, Math.min(Number(input.wait_ms) || 500, 5000))
        session.activeToolCallId = null

        const initial = this.readAgentShellDelta(session, 8000)
        const lines = [
          `Agent shell started.`,
          `session_id: ${sessionId}`,
          `cwd: ${cwd}`,
        ]
        if (shellInfo) {
          lines.push(`shell: ${shellInfo.kind}`)
          lines.push(`platform: ${shellInfo.platform}`)
          lines.push(`command_style: ${shellInfo.commandStyle}`)
          if (shellInfo.warning) lines.push(`warning: ${shellInfo.warning}`)
        }
        lines.push(initial ? `initial_output:\n${initial}` : 'initial_output: (none yet)')
        return lines.join('\n')
      },
    })

    this.tools.set('agent_shell_write', {
      definition: {
        name: 'agent_shell_write',
        description: 'Write exactly one command/input line to a persistent agent shell session. This keeps the agent inside the same shell/SSH context — cwd, env and an open SSH session survive between calls. Exactly one command is ENFORCED: newlines, &&, || and ; are rejected (send each step as its own call and read its output — a chained line reports one status for everything). Pipes are allowed: `a | b` is one command. For long jobs (deploy, upload, install) use a large wait_ms so the command can finish in one write+read cycle — avoid polling every few seconds.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session id returned by agent_shell_start. Defaults to the latest agent shell session.' },
            input: { type: 'string', description: 'One command or interactive input line to send.' },
            press_enter: { type: 'boolean', description: 'Append Enter/newline after input. Default: true.' },
            wait_ms: { type: 'number', description: 'How long to wait for output after writing. Default: 10000. Max: 120000 (use high values for deploy/upload). Returns EARLY on the first new output or on shell exit, so this is a ceiling, not a delay.' },
          },
          required: ['input'],
        },
      },
      execute: async (input) => {
        await this.ensureAgentShellListeners()
        const session = this.getAgentShellSession(input.session_id as string | undefined)
        if (session.exited) return `Agent shell session ${session.id} has exited with code ${session.exitCode ?? '?'}. Start a new session.`

        const command = this.validateAgentShellInput(String(input.input || ''))
        const pressEnter = input.press_enter !== false
        const payload = pressEnter ? `${command}\n` : command
        const startLength = session.output.length
        session.activeToolCallId = input._toolCallId as string | null | undefined || null

        await invoke('write_to_pty', { sessionId: session.id, data: payload })
        // Default 10s, não 1s: a espera termina no PRIMEIRO output novo, portanto
        // um tecto alto não custa nada quando o comando fala — e quando ele está
        // calado é exactamente aí que a descrição manda esperar. O default de 1s
        // treinava o polling que as duas descrições proíbem (auditoria 2026-07-29).
        await this.waitForAgentShellOutput(session, startLength, Math.min(Number(input.wait_ms) || 10_000, 120_000))
        session.activeToolCallId = null

        const output = this.readAgentShellDelta(session)
        return [
          `session_id: ${session.id}`,
          `sent: ${command}`,
          output ? `output:\n${output}` : 'output: (none yet)',
          session.exited ? `shell_exit_code: ${session.exitCode ?? '?'}` : 'shell_status: running',
        ].join('\n')
      },
    })

    this.tools.set('agent_shell_read', {
      definition: {
        name: 'agent_shell_read',
        description: 'Read new output from a persistent agent shell session without writing input. Use after agent_shell_write when a command is still running. Prefer ONE long wait_ms (up to 120s) over many short polls — the UI shows a single live terminal for the session. The wait returns as soon as ANY new output arrives, so a long wait_ms costs nothing when the command is talking.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session id returned by agent_shell_start. Defaults to the latest agent shell session.' },
            wait_ms: { type: 'number', description: 'How long to wait for new output before returning. Default: 30000. Max: 120000. Returns EARLY on the first new output or on shell exit, so this is a ceiling, not a delay. For deploys/uploads pass 60000–120000.' },
            max_chars: { type: 'number', description: 'Maximum characters to return. Default: 20000. Max: 50000.' },
          },
          required: [],
        },
      },
      execute: async (input) => {
        await this.ensureAgentShellListeners()
        const session = this.getAgentShellSession(input.session_id as string | undefined)
        const startLength = session.output.length
        session.activeToolCallId = input._toolCallId as string | null | undefined || null
        // 30s por omissão — ver a nota no agent_shell_write. Esta é A tool de
        // polling, portanto era a que mais sofria com o default de 1s.
        await this.waitForAgentShellOutput(session, startLength, Math.min(Number(input.wait_ms) || 30_000, 120_000))
        session.activeToolCallId = null
        const maxChars = Math.min(Number(input.max_chars) || 20_000, 50_000)
        const output = this.readAgentShellDelta(session, maxChars)
        return [
          `session_id: ${session.id}`,
          output ? `output:\n${output}` : 'output: (no new output)',
          session.exited ? `shell_exit_code: ${session.exitCode ?? '?'}` : 'shell_status: running',
        ].join('\n')
      },
    })

    this.tools.set('agent_shell_stop', {
      definition: {
        name: 'agent_shell_stop',
        description: 'Stop a persistent agent shell session and release its PTY. Use when the shell/SSH workflow is complete.',
        input_schema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session id returned by agent_shell_start. Defaults to the latest agent shell session.' },
          },
          required: [],
        },
      },
      execute: async (input) => {
        const session = this.getAgentShellSession(input.session_id as string | undefined)
        await invoke('kill_pty_session', { sessionId: session.id })
        this.agentShellSessions.delete(session.id)
        if (this.lastAgentShellSessionId === session.id) this.lastAgentShellSessionId = null
        return `Agent shell stopped: ${session.id}`
      },
    })

    // === execute_command_background ===
    this.tools.set('execute_command_background', {
      definition: {
        name: 'execute_command_background',
        description: 'Execute a shell command in the background. Returns immediately with a tracking ID — the command runs while you continue working. Use for long-running operations like npm install, build, or compile that would otherwise block your workflow. The command runs in the project directory. The system auto-wakes you when the command exits; use check_background_commands once to read the result. Do not poll. Max 6 concurrent background commands.',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute (e.g., "npm install", "npm run build", "tsc --noEmit")' },
            cwd: { type: 'string', description: 'Working directory. Default: project root' },
            timeout_secs: { type: 'number', description: 'Timeout in seconds. Default: 300. Max: 600.' }
          },
          required: ['command']
        }
      },
      execute: async (input) => {
        const cmd = (input.command as string).trim()
        this.validateCommand(cmd)

        const projectRoot = this.getProjectRoot()
        // resolveToAbsolute como no execute_command em primeiro plano
        // (auditoria 2026-07-28): um cwd RELATIVO ("server") era validado
        // contra o projeto mas seguia cru para o Rust, que o resolvia a partir
        // do cwd do processo da IDE — o comando corria noutro sítio.
        const cwd = this.resolveToAbsolute(
          (input.cwd as string) || (this.cmdModeCwd || projectRoot),
        )
        await this.requirePathAccess(cwd)

        // P3.1: o registry do motor é a fonte de verdade — a store zustand
        // passou a fachada-espelho para a UI.

        // Fix #4: GC old completed entries before checking concurrency
        processRegistry.removeCompleted()

        if (processRegistry.getRunningCount() >= 6) {
          return 'Cannot start: maximum 6 background commands running. Wait for one to complete or use check_background_commands.'
        }

        const { listen } = await import('@tauri-apps/api/event')
        const { invoke } = await import('@tauri-apps/api/core')

        const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        const allOutput: string[] = []
        let targetPid = 0
        let finished = false
        // Fix #6: declared before listeners so they can clear it on normal exit
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined

        const wakeForTerminalState = (status: 'completed' | 'error' | 'cancelled', exitCode?: number | null) => {
          import('./backgroundCommands/autoWake')
            .then(({ maybeWakeMainAgentForBackgroundCommand }) => {
              maybeWakeMainAgentForBackgroundCommand({ id: cmdId, command: cmd, status, exitCode })
            })
            .catch(() => { /* auto-wake is best-effort */ })
        }

        const bufferedOutput: { pid: number; data: string }[] = []
        const bufferedExit: { pid: number; code: number }[] = []

        // Register listeners BEFORE spawning
        const unOutput = await listen<{ pid: number; stream: string; data: string }>(
          'cmd-output',
          (event) => {
            if (targetPid === 0) {
              bufferedOutput.push({ pid: event.payload.pid, data: event.payload.data })
            } else if (event.payload.pid === targetPid) {
              allOutput.push(event.payload.data)
              processRegistry.appendOutput(cmdId, event.payload.data)
            }
          }
        )

        const unExit = await listen<{ pid: number; code: number }>(
          'cmd-exit',
          (event) => {
            if (targetPid === 0) {
              bufferedExit.push({ pid: event.payload.pid, code: event.payload.code })
            } else if (event.payload.pid === targetPid && !finished) {
              finished = true
              if (timeoutTimer) clearTimeout(timeoutTimer) // Fix #6
              unOutput(); unExit()
              const code = event.payload.code
              // Cancel do USER (BackgroundCommandsBar / Stop): o store já diz
              // 'cancelled' e este exit é consequência do kill — reporta
              // cancel ao auto-wake, não uma falha, e sem notificação de SO
              // (foi o próprio user a terminar o processo).
              if (processRegistry.getById(cmdId)?.status === 'cancelled') {
                wakeForTerminalState('cancelled', code)
              } else if (code === 0) {
                processRegistry.completeCommand(cmdId, code)
                wakeForTerminalState('completed', code)
                // Send OS notification when command completes successfully
                notifyHost({
                  title: '✅ Command completed',
                  body: cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd,
                  dedupKey: `bgcmd-done-${cmdId}`,
                })
              } else {
                processRegistry.failCommand(cmdId, `Process exited with code ${code}`)
                wakeForTerminalState('error', code)
                // Send OS notification when command fails
                notifyHost({
                  title: '❌ Command failed',
                  body: `${cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd} (exit ${code})`,
                  evenWhenFocused: true,
                  dedupKey: `bgcmd-fail-${cmdId}`,
                })
              }
            }
          }
        )

        try {
          const pid = await invoke<number>('run_streaming_command', { command: cmd, cwd })
          targetPid = pid

          // Fix #1: addCommand BEFORE flush — so store entry exists when
          // buffered exit events are processed (avoids completeCommand no-op)
          processRegistry.addCommand({
            id: cmdId,
            command: cmd,
            // F2 MDI: stamp the run that owns this process (a parallel task's
            // runId, else 'main') so the main run's cancel/restart never kills
            // another project's live task's background process.
            owner: this.permissionOrigin?.taskId ?? 'main',
            status: 'running',
            pid,
            exitCode: null,
            output: '',
            startedAt: Date.now(),
            completedAt: null,
          })

          // Flush buffered events (events emitted between spawn and PID assignment)
          for (const ev of bufferedOutput) {
            if (ev.pid === pid) {
              allOutput.push(ev.data)
              processRegistry.appendOutput(cmdId, ev.data)
            }
          }
          for (const ev of bufferedExit) {
            if (ev.pid === pid && !finished) {
              finished = true
              if (timeoutTimer) clearTimeout(timeoutTimer)
              unOutput(); unExit()
              if (ev.code === 0) {
                processRegistry.completeCommand(cmdId, ev.code)
                wakeForTerminalState('completed', ev.code)
              } else {
                processRegistry.failCommand(cmdId, `Process exited with code ${ev.code}`)
                wakeForTerminalState('error', ev.code)
              }
            }
          }

          // If command already exited during flush, return immediately
          if (finished) {
            const result = processRegistry.getById(cmdId)
            const exitInfo = result?.exitCode !== null ? ` (exit ${result?.exitCode})` : ''
            return `Command completed immediately (PID: ${pid}, id: ${cmdId})${exitInfo}. Use check_background_commands once to see results.`
          }

          const timeoutSecs = Math.min((input.timeout_secs as number) || 300, 600)
          timeoutTimer = setTimeout(async () => {
            if (!finished) {
              finished = true
              unOutput(); unExit()
              // Se o user já cancelou mas o kill dele falhou (sem cmd-exit),
              // o timeout é só o backstop do kill — não reclassificar como erro.
              const userCancelled =
                processRegistry.getById(cmdId)?.status === 'cancelled'
              try { await invoke('kill_process', { pid }) } catch { /* best effort */ }
              if (userCancelled) {
                wakeForTerminalState('cancelled', null)
              } else {
                processRegistry.failCommand(cmdId, `Timed out after ${timeoutSecs}s`)
                wakeForTerminalState('error', null)
              }
            }
          }, timeoutSecs * 1000)

          // Setup abort listener — kills on agent stop
          const callSignal = input._abortSignal as AbortSignal | undefined
          if (callSignal) {
            callSignal.addEventListener('abort', async () => {
              if (!finished) {
                finished = true
                if (timeoutTimer) clearTimeout(timeoutTimer)
                unOutput(); unExit()
                try { await invoke('kill_process', { pid }) } catch { /* best effort */ }
                processRegistry.cancelCommand(cmdId)
                wakeForTerminalState('cancelled', null)
              }
            }, { once: true })
          }

          return `Background command started (PID: ${pid}, id: ${cmdId}). Continue other work or end your turn; the system will wake you when it exits.`
        } catch (err) {
          unOutput(); unExit()
          const msg = err instanceof Error ? err.message : String(err)
          return `Failed to start background command: ${msg}`
        }
      }
    })

    // === check_background_commands ===
    this.tools.set('check_background_commands', {
      definition: {
        name: 'check_background_commands',
        description: 'Read the status and output of background commands started with execute_command_background. Use once after an auto-wake or after you have done other useful work. Calling it again while the same commands are still running returns a refusal instead of output — end your turn and the system auto-wakes you when a command exits.',
        input_schema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional specific command ID to check. Omit to see all.' }
          },
          required: []
        }
      },
      execute: async (input) => {
        // P3.1: o registry do motor é a fonte de verdade — a store zustand
        // passou a fachada-espelho para a UI.

        const targetId = input.id as string | undefined

        // ── Recusa de polling ──────────────────────────────────────────
        // A regra "não faças polling" existia só em prosa, e prosa perde para
        // o circuito de retorno: cada resposta a um comando ainda a correr
        // parecia informação útil, portanto o modelo repetia. Sessão
        // katondo-streaming (29-07): 15 chamadas seguidas a ver se o
        // `npm install` já tinha acabado — 42% dos turnos, ~552 mil tokens de
        // input, para um auto-wake que depois funcionou em 86 segundos.
        //
        // A partir da SEGUNDA consulta consecutiva sem nada ter mudado, a
        // tool deixa de responder com log e devolve a instrução. Não é
        // bloqueio: assim que algum comando muda de estado (ou termina), o
        // contador reinicia e a resposta normal volta. O que se recusa é
        // exactamente o gesto inútil — perguntar outra vez o que já se sabe.
        const stillRunningSignature = processRegistry
          .getAll()
          .filter(cmd => cmd.status === 'running')
          .map(cmd => cmd.id)
          .sort()
          .join(',')
        if (stillRunningSignature && stillRunningSignature === this.lastBackgroundPollSignature) {
          this.backgroundPollRepeats += 1
        } else {
          this.backgroundPollRepeats = 0
          this.lastBackgroundPollSignature = stillRunningSignature
        }
        // A recusa cobre a VARREDURA ("mudou algo?"), não o pedido por id.
        //
        // Estava antes deste ponto e apanhava os dois (auditoria 2026-07-29):
        // `check_background_commands({ id })` é o caminho DOCUMENTADO para
        // obter o output completo de um comando que terminou, e era negado
        // sempre que a assinatura se repetia — o modelo pedia o resultado que a
        // tool lhe tinha dito para ir buscar e ouvia "não perguntes outra vez".
        // Uma recusa que bloqueia o gesto certo deixa de ser um guardrail.
        const targetStillRunning = targetId
          ? processRegistry.getById(targetId)?.status === 'running'
          : false
        if (this.backgroundPollRepeats >= 1 && (!targetId || targetStillRunning)) {
          return (
            `Nothing has changed since your last check — the same command(s) are still running, and this call cost a full round-trip to learn that.\n\n` +
            `END YOUR TURN NOW. The system auto-wakes you the moment a background command exits; the run resumes by itself, so stopping here is not abandoning the task. ` +
            `If you have other useful work that does NOT depend on this command, do that instead — but do not ask again.`
          )
        }

        if (targetId) {
          const cmd = processRegistry.getById(targetId)
          if (!cmd) return `No background command found with id: ${targetId}`
          if (cmd.status !== 'running') {
            const { acknowledgeBackgroundCommandWake } = await import('./backgroundCommands/autoWake')
            acknowledgeBackgroundCommandWake(cmd.id)
          }
          // Pedido por id = quer o resultado a sério → output COMPLETO; o
          // truncateResult (preview de cauda, refId real) faz o corte honesto.
          return formatBackgroundCommandResult(cmd, { full: true })
        }

        const all = processRegistry.getAll()
        if (all.length === 0) return 'No background commands running or recently completed.'

        const lines: string[] = []
        const { acknowledgeBackgroundCommandWake } = await import('./backgroundCommands/autoWake')
        for (const cmd of all) {
          if (cmd.status !== 'running') {
            acknowledgeBackgroundCommandWake(cmd.id)
          }
          lines.push(formatBackgroundCommandResult(cmd))
        }

        return lines.join('\n\n---\n\n')
      }
    })
  }
}

export default ToolExecutor
