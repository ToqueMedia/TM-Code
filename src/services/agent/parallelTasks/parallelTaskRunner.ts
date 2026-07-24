/**
 * Runner for a single user-initiated parallel task (v1.0.1 "multi-agent").
 *
 * Modeled on subAgentRunner, but for a co-equal WRITABLE coding agent rather than
 * a read-only delegate:
 *   - full tool set (not a read-only whitelist);
 *   - cwd-scoped execution (enableCmdMode) so file writes APPLY DIRECTLY to disk
 *     — card tasks live outside the transcript, so they can't use the inline
 *     diff-approval UI; cwd mode is the app's existing "write straight to disk"
 *     path (alreadyApplied), and safety comes from the write serializer below;
 *   - every file-mutating tool runs inside withWriteLock, so no two runs (task or
 *     main agent) apply a change at the same instant — the "serialize diff
 *     approvals" guarantee;
 *   - publishes to parallelTaskStore (never chatStore streaming), so it can't
 *     collide with the main interactive agent;
 *   - on terminal it pumps the queue so the next waiting task starts.
 *
 * System prompt (fusão 4b, doutrina "sem deus"): o MESMO ContextBuilder do
 * agente interativo, numa instância EFÉMERA por tarefa (estado próprio — o
 * singleton continua exclusivo do main, cuja auxiliarySelection é lida logo
 * após o build dele). Raiz do build = o worktree da tarefa (cada developer vê
 * a SUA cópia). Fallback: prompt artesanal degradado se o build falhar — a
 * tarefa nunca deixa de arrancar por causa do prompt.
 */

import type OpenAI from 'openai'
import FirebaseAuthService from '../../auth/firebaseAuth'
import { writeProjectRunBadge } from '../../projectAgentStatusService'
import { buildRunClient } from '../runClient'
import {
  resolveByokSnapshotForSession,
  buildByokThinkingConfig,
} from '../byokRouting'
import { FALLBACK_CONTEXT_WINDOW } from '../../../utils/contextWindow'
import { QueryEngine } from '../queryEngine'
import type { QueryStreamEvent, QueryTerminal, ToolExecutorFn } from '../query'
import type { ContentBlockAPI } from '../../../types/chat'
import ToolExecutor from '../toolExecutor'
import {
  canonicalToolName,
  WRITE_FILE, EDIT_FILE, CREATE_FILE, DELETE_FILE, RENAME_FILE, CREATE_DIRECTORY,
} from '../toolNames'
import { REQUEST_TOOLS_NAME, REQUEST_CONTEXT_NAME, requestContextDefinition } from '../toolsetSelector'
import type ContextBuilderT from '../contextBuilder'
import { formatError } from '../../../utils/errors'
import { useBillingStore } from '../../../stores/billingStore'
import { useProjectStore } from '../../../stores/projectStore'
import { useParallelTaskStore } from '../../../stores/parallelTaskStore'
import { useChatStore, rebuildConversationHistory } from '../../../stores/chatStore'
import { toQueryMessages } from '../queryEngine'
import { withWriteLock } from './writeSerializer'
import { finalizeTaskWorktree, autoMergeTaskBranch, dirtyFilesInMainCheckout, type TaskWorktree } from './taskWorktree'
import { makeTaskPathNormalizer } from './taskPaths'
import { releaseOwnerClaims } from '../fileClaims'
import { consumeTaskStopRequest, consumeProjectAgentStop } from './taskStopRequestService'
import { WORKTREES_REL_DIR } from '../toolExecutor/worktrees'
import { useAgentStore } from '../../../stores/agentStore'
import { getProfileForPlan, MODEL_PROFILES } from '../modelProfiles'
import { pumpParallelTasks } from './parallelTaskManager'
import { t } from '../../../i18n'
import { logger } from '../../../utils/logger'

/** Resolve a projectId for path-based binding (permission store / Rust registry).
 *  Prefers the focused project when paths match, else recents. */
function resolveProjectIdForPath(projectPath: string): string | undefined {
  try {
    const st = useProjectStore.getState()
    if (st.currentProject?.path === projectPath) return st.currentProject.id
    const recent = st.recentProjects.find((p) => p.path === projectPath)
    return recent?.id
  } catch {
    return undefined
  }
}

/** Write into the task's OWN chat session (created by addParallelTask) —
 *  the transcript the ProjectMenu opens when the user clicks the task. */
function appendToTaskSession(
  sessionId: string | undefined,
  message: { role: 'user' | 'assistant' | 'system'; content: string; level?: 'info' | 'warn' | 'error' },
): void {
  if (!sessionId) return
  try {
    useChatStore.getState().appendMessageToSession(sessionId, message)
  } catch { /* transcript is best-effort — never fails the task */ }
}

/** Persist the task's final state ON the session — the sidebar/ProjectMenu
 *  rows derive from sessions, so the task survives reloads (never vanishes). */
function stampTaskSessionStatus(
  sessionId: string | undefined,
  status: 'completed' | 'error' | 'aborted',
): void {
  if (!sessionId) return
  try {
    useChatStore.getState().setSessionTaskStatus(sessionId, status)
  } catch { /* best-effort */ }
}

/** File-mutating tools whose APPLY step is serialized across all runs. Commands
 *  (build/test) stay parallel; only clobber-prone file writes serialize. */
const SERIALIZED_WRITE_TOOLS = new Set<string>([
  WRITE_FILE, EDIT_FILE, CREATE_FILE, DELETE_FILE, RENAME_FILE, CREATE_DIRECTORY,
])

/** Tools a parallel task must NOT have:
 *   - web_search: native/server-side only (never in the schema);
 *   - delegate/task/collect_results: no nested sub-agent delegation (Fase 3
 *     do modelo foreground — ver ARCHITECTURE.md);
 *   - update_session_memory / read_session_memory: scoped to the main chat
 *     session, which the task is not part of.
 *  update_tasks é PERMITIDA desde o tracker por-sessão (sem-deus 2026-07-18):
 *  a tarefa escreve no tracker da SUA sessão (getTaskOrigin().sessionId), nunca
 *  no do chat principal — cada agente planeia o seu próprio trabalho. Antes
 *  estava excluída porque o tracker era global e uma tarefa pisava a checklist
 *  do agente interativo.
 *  ask_user_question / request_credentials são PERMITIDAS desde a Fase 1 do
 *  modelo foreground (2026-07-16): a tarefa tem sessão própria — o card é
 *  escrito NELA, a row ganha badge âmbar (Pergunta/Credenciais) e o user
 *  responde abrindo o chat da tarefa. Nada fica pendurado invisível.
 *  delegate / collect_results são PERMITIDAS desde a Fase 3: as entregas são
 *  roteadas POR DONO (autoWake pendingDeliveriesByOwner) — os resultados da
 *  equipa de uma tarefa drenam nos turn boundaries DELA e nunca vazam para o
 *  main; o cap de concorrência de sub-agents (4) é GLOBAL e partilhado.
 *  (Persistent project/user memory — save_memory/read_memory — stays allowed.) */
const TASK_EXCLUDED_TOOLS = new Set<string>([
  'task',
  'update_session_memory', 'read_session_memory',
  // Fase 5: a tarefa pode JÁ estar num worktree próprio — worktrees
  // aninhados/geridos pelo modelo dentro de uma tarefa são confusão.
  'enter_worktree', 'exit_worktree',
  // web_search e capture_url_design DEVOLVIDOS às tarefas (trono nº3,
  // 2026-07-17): web_search é passive (o provider resolve server-side — a
  // rota da tarefa é a mesma do main); capture_url_design serializa no mutex
  // GLOBAL do browser (withBrowserExclusive) em vez de ser excluída.
])

/** Generous safety cap so a runaway task can't run forever (user Stop is the
 *  normal exit). 30 min — long enough for real multi-step work. */
const TASK_WALL_CLOCK_MS = 30 * 60_000

function buildTaskSystemPrompt(
  projectPath: string,
  worktree?: TaskWorktree | null,
  /** Pre-built heading + body from TMS or foreign compat instructions. */
  projectInstructions?: { heading: string; body: string } | null,
): string {
  return [
    'You are a TM Code parallel task agent — one of up to four agents the developer launched to work on this project AT THE SAME TIME.',
    'You work INDEPENDENTLY on the single task in the user message. Do not wait for or coordinate with the other agents.',
    '',
    worktree
      ? `Working directory (your ISOLATED git worktree): ${worktree.path} — you are on branch "${worktree.branch}", checked out from the project at ${worktree.originalRoot}. Your edits do NOT touch the developer's main checkout; they merge the branch when they choose. ALWAYS use paths RELATIVE to your working directory (e.g. "src/App.tsx") — NEVER prefix paths with "${WORKTREES_REL_DIR}/..."; you are ALREADY inside the worktree. When your work is done, stage and commit it on your branch (git add -A && git commit -m "...") so the branch is mergeable.`
      : `Working directory (your project root): ${projectPath}`,
    '',
    'How to work:',
    '- Explore before you change: read the relevant files (read_file/search_files/glob/list_directory) to understand the code before editing.',
    '- Make the change with edit_file/write_file/create_file. Keep edits tight and match the surrounding style.',
    '- Run builds/tests with execute_command when useful to verify your work.',
    '- You may delegate read-only research to team members (delegate tool: Explore/Research/Verify) — their results are DELIVERED to you automatically at your next step; never poll collect_results.',
    '- Other agents may be working on this project in parallel. You can coordinate with them via send_agent_message (target "main" or another task); messages from them arrive automatically between your steps.',
    worktree
      ? '- File writes are applied directly in YOUR worktree — the tree is exclusively yours; no other agent touches it.'
      : '- File writes are applied directly and are serialized with the other agents, so keep your edits scoped to YOUR task to avoid stepping on theirs.',
    '- If you genuinely need the developer (a decision between options, or credentials for a service), use ask_user_question / request_credentials — the developer is notified on your task row and answers in your task chat. Prefer sensible defaults over asking.',
    '- FILE OWNERSHIP RULE: files being modified by ANOTHER parallel task, or with the developer\'s own uncommitted changes, are OFF-LIMITS — the system blocks writes to them. When a blocked file prevents part of your task, do NOT work around it: skip that part and EXPLAIN exactly which files were blocked and why in your final report.',
    '- When done, finish with a short summary of exactly what you changed (files + what/why), INCLUDING any files you skipped due to the ownership rule. That summary is shown on your task card.',
    ...(projectInstructions
      ? ['', `# ${projectInstructions.heading}`, projectInstructions.body]
      : []),
  ].join('\n')
}

/** Extrai o(s) caminho(s)-alvo de uma tool de escrita. */
function writeTargetsOf(input: Record<string, unknown>): string[] {
  const targets: string[] = []
  for (const key of ['file_path', 'path', 'old_path', 'new_path', 'source', 'destination']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) targets.push(v.trim())
  }
  return targets
}

/** Normaliza um alvo para caminho relativo à raiz (worktree ou projecto). */
function toRelPath(target: string, roots: string[]): string {
  let rel = target
  for (const root of roots) {
    if (rel.startsWith(root + '/')) {
      rel = rel.slice(root.length + 1)
      break
    }
    if (rel === root) return ''
  }
  return rel.replace(/^\.\//, '')
}

/**
 * Execute the parallel task identified by `runId`. Fire-and-forget: resolves when
 * the run reaches a terminal state (the store is updated throughout). Must only
 * be called by the manager after markRunning(runId).
 */
export async function runParallelTask(runId: string): Promise<void> {
  const store = useParallelTaskStore.getState()
  const run = store.runs.get(runId)
  if (!run || run.status !== 'running') return

  const { prompt, abortController } = run
  // Prefer the run's own project (stamped at enqueue). After in-window
  // multi-project switch, currentProject may be a DIFFERENT project — using
  // it would contaminate the background run's cwd/paths.
  const projectPath =
    run.projectPath
    ?? useProjectStore.getState().currentProject?.path
    ?? null

  const fail = (msg: string) => {
    useParallelTaskStore.getState().error(runId, msg)
    // Falha ANTES do engine (sem projeto/auth/BYOK): sem isto a sessão da
    // tarefa ficava 'running' órfã e o chat dela sem qualquer explicação
    // (H13 da ronda crítica 2026-07-16).
    appendToTaskSession(run.sessionId, {
      role: 'system',
      level: 'error',
      content: t('parallel.taskFailed').replace('{error}', msg),
    })
    stampTaskSessionStatus(run.sessionId, 'error')
    pumpParallelTasks()
  }

  if (!projectPath) {
    fail('Open a project before running parallel tasks.')
    return
  }

  const authToken = await FirebaseAuthService.getInstance().getIdToken()
  if (!authToken) {
    fail('Authentication expired.')
    return
  }

  // ── Client (BYOK direct, else managed) — same discipline as the main run.
  // Herança BYOK: o snapshot CONGELADO na sessão DA TAREFA (capturado no
  // lançamento), nunca o da sessão visível — trocar de vista não muda a rota.
  const { snapshot: byokSnapshot, byokActive } = resolveByokSnapshotForSession(run.sessionId)
  // FUSÃO F3: cliente + refresh no núcleo partilhado (runClient.ts) — mesma
  // dança de refresh do agente principal. model/thinkingConfig são da tarefa.
  const runClient = await buildRunClient({
    authToken,
    snapshot: byokSnapshot,
    byokActive,
    lightweight: false,
  })
  if (!runClient) {
    fail(`BYOK key missing for "${byokSnapshot?.providerId ?? 'provider'}".`)
    return
  }
  const { client, refreshClient } = runClient
  let model = 'tm-active-model'
  let thinkingConfig: Record<string, unknown> | undefined
  if (byokActive && byokSnapshot) {
    model = byokSnapshot.modelId
    thinkingConfig = buildByokThinkingConfig(byokSnapshot)
  }

  // F3 (2026-07-23): worktrees-por-tarefa REMOVIDOS com o fan-out
  // intra-projecto. Project-runs e continuações trabalham sempre no checkout
  // do projecto (cmdModeCwd = projectPath). Isolação multi-agente no MESMO
  // projecto já não existe — 1 agente/projecto.
  const worktree: TaskWorktree | null = null
  const sessionForRun = run.sessionId ? useChatStore.getState().sessions.get(run.sessionId) : undefined
  const continuationOfPlainChat = run.continuation === true && sessionForRun?.isParallelTask !== true

  // Regra de propriedade — baseline: ficheiros com trabalho POR COMMITAR do
  // developer no checkout principal. A tarefa não lhes toca (em worktree, a
  // versão deles no HEAD estaria desatualizada; na árvore partilhada,
  // pisava o trabalho do user).
  // Continuação de chat normal = PAR do developer (como o run interativo):
  // pode tocar no WIP dele — o guard fica vazio nesse caso.
  const userWipFiles = continuationOfPlainChat ? new Set<string>() : await dirtyFilesInMainCheckout(projectPath)
  if (abortController.signal.aborted) {
    // Stop durante a criação do worktree — não arranca o engine. Fecha o
    // transcript honestamente (o finally do try nunca corre neste caminho).
    useParallelTaskStore.getState().abort(runId)
    appendToTaskSession(run.sessionId, { role: 'system', level: 'info', content: t('parallel.taskStopped') })
    stampTaskSessionStatus(run.sessionId, 'aborted')
    pumpParallelTasks()
    return
  }

  const normalizeTaskPaths = makeTaskPathNormalizer(null, projectPath)

  // ── Writable, cwd-scoped, isolated tool executor ──
  const toolExecutor = ToolExecutor.getInstance().createIsolatedChild()
  // #13: the child inherited the MAIN run's worktree redirect from
  // createIsolatedChild — clear it so a task NEVER resolves into the main
  // agent's enter_worktree checkout (it uses enableCmdMode(projectPath) below).
  toolExecutor.clearWorktreeState()

  // F4: register MCP tools for THIS project on the CHILD executor — NEVER the
  // shared singleton (that would delete/replace the concurrent main run's
  // mcp__* tools). createIsolatedChild does not copy the parent tool map, so
  // the task's own executor needs its MCP registered here to actually see them.
  try {
    const { refreshMcpForDispatch } = await import('../mainDispatch')
    refreshMcpForDispatch(projectPath, toolExecutor)
  } catch { /* MCP optional */ }
  // F3: always the project checkout (no per-task worktree).
  toolExecutor.enableCmdMode(projectPath)
  // F2 multi-project: bind path resolution + permission grants to THIS
  // run's project (not the focused one). projectId from the run stamp or
  // a path match in recents / currentProject.
  // ALWAYS bind the run's project PATH so getProjectRoot() returns THIS project,
  // never the inherited/focused one. The id resolves from recents/currentProject
  // when available, else a path-keyed fallback so permission grants fail-closed
  // (re-prompt) instead of leaking another project's grants (#13 Finding B).
  const projectId = resolveProjectIdForPath(projectPath) ?? `path:${projectPath}`
  toolExecutor.setProjectContext({ projectId, projectPath })
  // Permission prompts raised by this task carry ITS identity — the dialog
  // says which task is asking and the task rows show the "Autorização" badge.
  // projectId ensures approve* writes grants under the run's project.
  toolExecutor.setPermissionOrigin({
    taskId: runId,
    label: run.description,
    sessionId: run.sessionId,
    projectId,
  })

  // Full toolset minus the tools that don't belong in an independent, headless task.
  const openaiTools: OpenAI.ChatCompletionTool[] = toolExecutor
    .getToolDefinitions()
    .filter((t) => !TASK_EXCLUDED_TOOLS.has(t.function.name))
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
      },
    }))

  // Builder EFÉMERO desta tarefa — resolve request_context do prompt construído.
  let taskBuilder: ContextBuilderT | null = null

  const executeTool: ToolExecutorFn = async (toolName, toolInput, toolUseId, signal) => {
    // Meta-tools do prompt construído (fusão 4b) — nunca chegam ao toolExecutor.
    // request_tools: sem seleção dinâmica nas tarefas (toolset completo desde
    // o turno 1). request_context: secções auxiliares omitidas pelo planner,
    // resolvidas na instância EFÉMERA desta tarefa.
    if (toolName === REQUEST_TOOLS_NAME) {
      return { content: 'All tools are already available (parallel tasks run with the full toolset).', isError: false }
    }
    if (toolName === REQUEST_CONTEXT_NAME) {
      const auxiliaryId = typeof toolInput.auxiliary === 'string' ? toolInput.auxiliary : ''
      if (!auxiliaryId || !taskBuilder) {
        return { content: 'No auxiliary id provided. Call request_context with an auxiliary id from the on-demand index.', isError: false }
      }
      try {
        const { content, name } = await taskBuilder.loadAuxiliaryOnDemand(auxiliaryId)
        if (content === null) {
          const sel = taskBuilder.getLastAuxiliarySelection()
          const available = sel ? sel.omitted.map(o => o.id).join(', ') : '(none)'
          return { content: `Auxiliary "${auxiliaryId}" is not available on-demand. It may already be loaded inline. Available: ${available}.`, isError: false }
        }
        return { content: `# Auxiliary context: ${name}\n\n${content}`, isError: false }
      } catch (err) {
        return { content: `Error loading auxiliary context: ${formatError(err)}`, isError: true }
      }
    }
    const canonical = canonicalToolName(toolName)
    // Caminhos do modelo → referencial do worktree (execução, claims e
    // display coerentes; sem isto os ficheiros aninhavam no próprio worktree).
    toolInput = normalizeTaskPaths(toolInput)

    // ── WIP do developer (só tarefas — o main é o par interativo dele):
    // escrita num ficheiro com alterações por commitar do user → bloqueada.
    // Os claims agente↔agente vivem no registry ÚNICO (fileClaims.ts),
    // verificados dentro do toolExecutor.execute para TODOS os agentes.
    if (SERIALIZED_WRITE_TOOLS.has(canonical)) {
      const roots = [projectPath]
      for (const rel of writeTargetsOf(toolInput).map(tgt => toRelPath(tgt, roots))) {
        if (rel && userWipFiles.has(rel)) {
          return {
            content: `BLOCKED (file ownership): "${rel}" has the developer's own uncommitted changes in the main checkout. Do NOT modify it or work around the block. Skip this part of the task and explain it in your final report.`,
            isError: true,
          }
        }
      }
    }

    const apply = async () => {
      try {
        const raw = await toolExecutor.execute(toolName, toolInput, toolUseId, signal ?? undefined)
        return { content: raw, isError: false }
      } catch (err) {
        return { content: `Error: ${formatError(err)}`, isError: true }
      }
    }
    // Serialize the APPLY of file-mutating tools across every run; everything
    // else (reads, commands, model calls) stays fully parallel. Num WORKTREE
    // próprio (Fase 5) o lock é desnecessário — árvore exclusiva da tarefa.
    // O registo do claim acontece DENTRO do toolExecutor.execute (registry
    // único) — aqui só resta a serialização física em árvore partilhada.
    return !worktree && SERIALIZED_WRITE_TOOLS.has(canonical) ? withWriteLock(apply) : apply()
  }

  const chatSessionId = run.sessionId
  // Bolha assistant ao vivo desta tarefa (Fase 4). Declarada ANTES do engine:
  // o collectQueuedSteering roda a bolha no drain (fecha a atual, abre nova
  // DEPOIS da mensagem de steer do user — mesma dança do split do main).
  let assistantMessageId: string | null = null

  // ── Fusão 4b: o MESMO system prompt do agente interativo. Instância
  // EFÉMERA (sem corrida com o singleton do main); raiz = o worktree quando
  // isolada (árvore/branch/git status da CÓPIA desta tarefa); o router de
  // intenção corre sobre o prompt DA TAREFA (sem override). O contrato de
  // tarefa (worktree, propriedade, relatório) entra DEPOIS do prompt base —
  // é o que distingue esta superfície, não a capacidade.
  let systemPrompt: string
  let taskVolatileCtx: string | null = null
  try {
    const { default: ContextBuilderClass } = await import('../contextBuilder')
    // FUSÃO F1: a montagem passa pelo NÚCLEO ÚNICO (mainDispatch) — mesma
    // função do Chat e do runner serializado, com o builder EFÉMERO desta
    // tarefa por parâmetro (o singleton continua exclusivo do interativo).
    const { buildMainSystemPrompt } = await import('../mainDispatch')
    const builder = ContextBuilderClass.createEphemeral({ taskSurface: true })
    const projectType = useProjectStore.getState().currentProject?.projectType || 'unknown'
    const base = await buildMainSystemPrompt({
      projectPath,
      projectType,
      userMessageText: prompt,
      bootstrapOnly: false,
      builder,
      coreToolCountOverride: openaiTools.length,
    })
    taskBuilder = builder
    // Secções omitidas pelo planner ficam alcançáveis: injeta o meta-tool
    // request_context (interceptado no executeTool, resolvido no builder
    // efémero). Sem omissões, nada a injetar.
    const omittedIds = builder.getLastAuxiliarySelection()?.omitted.map(o => o.id) ?? []
    if (omittedIds.length > 0) openaiTools.push(requestContextDefinition(omittedIds))
    // FASE B: volátil na mensagem (system prompt da tarefa byte-estável —
    // vale ouro nas CONTINUAÇÕES, que repetem o mesmo prefixo).
    taskVolatileCtx = builder.getLastVolatileContext()
    systemPrompt = `${base}\n\n${buildTaskSystemPrompt(projectPath, worktree, null)}`
  } catch (err) {
    logger.warn('agent', `[parallel] ContextBuilder falhou para ${runId} — prompt degradado: ${formatError(err)}`)
    let projectInstructions: { heading: string; body: string } | null = null
    try {
      const {
        loadProjectInstructions,
        buildParallelTaskInstructionsBody,
      } = await import('../projectInstructions')
      const bundle = await loadProjectInstructions(projectPath)
      projectInstructions = buildParallelTaskInstructionsBody(bundle)
    } catch { /* sem instruções de projecto — segue sem memória */ }
    systemPrompt = buildTaskSystemPrompt(projectPath, worktree, projectInstructions)
  }
  // Guarda pré-voo (paridade com o main): Stop durante a montagem do prompt
  // (router+planner = segundos) não pode deixar o engine arrancar.
  if (abortController.signal.aborted) {
    useParallelTaskStore.getState().abort(runId)
    appendToTaskSession(run.sessionId, { role: 'system', level: 'info', content: t('parallel.taskStopped') })
    stampTaskSessionStatus(run.sessionId, 'aborted')
    pumpParallelTasks()
    return
  }

  // Fase 4b (paridade de compaction): limites reais do modelo ativo para o
  // auto-compact do engine — tarefas longas deixam de morrer em prompt_too_long.
  const contextLimits = (() => {
    // REGRA DO MAIN (getContextLimits): header do worker → perfil conhecido →
    // FALLBACK 200K conservador (nunca o perfil do plano, que assumia 1M para
    // modelos desconhecidos e estourava). Sob BYOK o header gerido é ignorado
    // (é do modelo do worker, possivelmente stale) e o perfil resolve pelo
    // modelId do snapshot.
    const { modelContextWindow, modelName } = useAgentStore.getState()
    const knownProfile = byokActive
      ? MODEL_PROFILES[model]
      : (modelName ? MODEL_PROFILES[modelName] : undefined)
    const profile = knownProfile ?? getProfileForPlan(useBillingStore.getState().plan)
    return {
      contextWindow: (byokActive ? null : modelContextWindow) ?? knownProfile?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
      maxOutputTokens: profile.maxOutputTokens ?? null,
    }
  })()

  const engine = new QueryEngine({
    client,
    refreshClient,
    model,
    systemPrompt,
    getContextLimits: () => contextLimits,
    tools: openaiTools,
    executeTool,
    isStreamSafeTool: (name) =>
      toolExecutor.isConcurrencySafe(name) || toolExecutor.isConcurrencySafe(canonicalToolName(name)),
    thinkingConfig,
    onResponseHeaders: (headers) => useBillingStore.getState().updateFromHeaders(headers),
    // Fase 3: turn boundaries drenam (a) orientações do composer com a sessão
    // desta tarefa em foco (a bolha do user já foi escrita pelo handleSend) e
    // (b) resultados da equipa delegada POR ESTA tarefa (roteados por dono).
    collectQueuedSteering: async () => {
      // Cross-window Stop no turn boundary (latência ~1 turno em atividade):
      // session-scoped (task row X) or project-scoped (sidebar Stop).
      const sessionStop = chatSessionId
        ? await consumeTaskStopRequest(projectPath, chatSessionId)
        : false
      const projectStop = await consumeProjectAgentStop(projectPath)
      if (sessionStop || projectStop) {
        // Unified stop reason: Stop clicked in another window / sidebar.
        if (chatSessionId) {
          try {
            const { t } = await import('../../../i18n')
            useChatStore.getState().appendMessageToSession(chatSessionId, {
              role: 'system',
              level: 'info',
              content: t('parallel.stoppedRemoteWindow'),
            })
          } catch { /* best-effort */ }
        }
        useParallelTaskStore.getState().abort(runId)
        return null
      }
      const steer = useParallelTaskStore.getState().drainSteer(runId)
      const { drainSubAgentDeliveries } = await import('../subAgents/autoWake')
      const deliveries = drainSubAgentDeliveries(runId)
      if (steer.length === 0 && !deliveries) return null
      if (steer.length > 0 && chatSessionId) {
        // Roda a bolha: fecha a atual e abre uma nova DEPOIS da(s) bolha(s)
        // de steer que o handleSend já escreveu — os turnos seguintes
        // streamam abaixo da mensagem do user, não acima dela.
        flushDelta()
        safeUi(() => {
          const chat = useChatStore.getState()
          if (assistantMessageId) chat.finalizeAssistantMessageInSession(chatSessionId, assistantMessageId)
          assistantMessageId = chat.startAssistantMessageInSession(chatSessionId)
        })
      }
      // Pacote 2: multimodal steer (images/files) — main parity via resolveSteerItemsToContent.
      let steerPayload: string | import('../../../types/chat').ContentBlockAPI[] | null = null
      if (steer.length > 0) {
        const { resolveSteerItemsToContent } = await import('./steerContent')
        steerPayload = await resolveSteerItemsToContent(steer, { sessionId: chatSessionId })
      }
      if (!steerPayload && !deliveries) return null
      if (!steerPayload) return deliveries
      if (!deliveries) return steerPayload
      if (typeof steerPayload === 'string') return `${deliveries}\n\n${steerPayload}`
      return [
        { type: 'text' as const, text: deliveries },
        ...steerPayload,
      ]
    },
  })

  // Abort wiring — the store's abortController (Stop button) cancels the engine.
  const onAbort = () => engine.cancel()
  abortController.signal.addEventListener('abort', onAbort, { once: true })

  // Wall-clock safety cap. Re-armed (instead of killing) while the task is
  // waiting on the DEVELOPER — a pending question/credential/permission of
  // this task is human latency, not a runaway agent.
  let wallClock: ReturnType<typeof setTimeout> | undefined
  const armWallClock = () => {
    wallClock = setTimeout(async () => {
      if (useParallelTaskStore.getState().runs.get(runId)?.status !== 'running') return
      try {
        const [{ usePermissionStore }, { useAskUserQuestionStore }, { useCredentialRequestStore }] =
          await Promise.all([
            import('../../../stores/permissionStore'),
            import('../../../stores/askUserQuestionStore'),
            import('../../../stores/credentialRequestStore'),
          ])
        const perm = usePermissionStore.getState()
        const waitingOnUser =
          perm.pendingPermission?.origin?.taskId === runId ||
          perm.permissionQueue.some(q => q.origin?.taskId === runId) ||
          Array.from(useAskUserQuestionStore.getState().pending.values()).some(q => q.origin?.taskId === runId) ||
          Array.from(useCredentialRequestStore.getState().pending.values()).some(q => q.origin?.taskId === runId)
        if (waitingOnUser) {
          armWallClock()
          return
        }
      } catch { /* stores unavailable — fall through to the cap */ }
      engine.cancel()
      abortController.abort()
    }, TASK_WALL_CLOCK_MS)
  }
  armWallClock()

  // #9 B2: cross-window badge for this BACKGROUND project-run. The single-slot
  // main-run writer only tracks the FOCUSED main run, so a background run on
  // another project must drive its own 'running' badge (+ the heartbeat below),
  // else it shows idle in every window's recents. Settled in the finally.
  const badgeStartedAt = Date.now()
  if (projectPath) {
    writeProjectRunBadge(projectPath, 'running', { label: run.description, startedAt: badgeStartedAt })
  }

  // Heartbeat de persistência (30s): mantém o updatedAt do índice fresco —
  // é a prova-de-vida que outras janelas usam para mostrar esta tarefa como
  // 'running' (limitação #3) — e protege o transcript contra crash (#2).
  const persistBeat = chatSessionId
    ? setInterval(() => {
        useChatStore.getState().persistSessionNow(chatSessionId)
        // #9 B2: keep the cross-window badge fresh (>90s runs would go stale).
        if (projectPath) {
          writeProjectRunBadge(projectPath, 'running', { label: run.description, startedAt: badgeStartedAt })
        }
        // Canal cross-window: outra janela pediu Stop desta tarefa (session)
        // ou do projecto inteiro (sidebar Stop só tem o path)? O abort do
        // store dispara o caminho normal (controller → engine.cancel →
        // finally stampa 'aborted'). Teto de latência = este heartbeat.
        void Promise.all([
          consumeTaskStopRequest(projectPath, chatSessionId),
          consumeProjectAgentStop(projectPath),
        ]).then(([sessionStop, projectStop]) => {
          if (sessionStop || projectStop) useParallelTaskStore.getState().abort(runId)
        })
      }, 30_000)
    : null

  // ── Fase 4 (transcript unificado): o run escreve o transcript COMPLETO na
  // sua sessão — bolha assistant ao vivo + tool calls pelos MESMOS updaters
  // do main (donos-cientes via targetMessageId). Abrir o chat da tarefa
  // mostra o run exatamente como um run principal.
  //
  // BLINDAGEM (feedback do user 2026-07-16, "Tarefa falhou: Maximum update
  // depth exceeded"): escritas de UI são ESPELHO, nunca o trabalho — um throw
  // do React (ex.: #185) a subir por um set() não pode falhar a tarefa.
  let uiWriteWarned = false
  const safeUi = (write: () => void): void => {
    try {
      write()
    } catch (err) {
      if (!uiWriteWarned) {
        uiWriteWarned = true
        logger.warn('agent', `[parallel-task ${runId}] UI mirror write failed — continuing headless: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (chatSessionId) {
    safeUi(() => {
      assistantMessageId = useChatStore.getState().startAssistantMessageInSession(chatSessionId)
    })
  }

  // Coalescer de deltas (paridade com o buffer de 50ms do main): um set() no
  // chatStore POR TOKEN × N tarefas era a pressão de updates que despoletava
  // o "Maximum update depth exceeded" com a 2ª tarefa em simultâneo. O texto
  // acumula e flusha a cada ~60ms — e SEMPRE antes de um tool call/rotação/
  // terminal, para o interleaving dos contentBlocks ficar correto.
  let pendingDelta = ''
  let deltaTimer: ReturnType<typeof setTimeout> | null = null
  const flushDelta = (): void => {
    if (deltaTimer) {
      clearTimeout(deltaTimer)
      deltaTimer = null
    }
    if (!pendingDelta) return
    const chunk = pendingDelta
    pendingDelta = ''
    if (chatSessionId && assistantMessageId) {
      const mid = assistantMessageId
      safeUi(() => useChatStore.getState().appendTextToMessageInSession(chatSessionId, mid, chunk))
    }
  }
  const queueDelta = (text: string): void => {
    pendingDelta += text
    if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 60)
  }

  // ── Iterate the engine, publishing to parallelTaskStore ──
  const argsByCallId = new Map<string, string>()
  const buildArgPreview = (argsJson: string): string => {
    try {
      const parsed = JSON.parse(argsJson) as Record<string, unknown>
      const key = ['file_path', 'path', 'command', 'query', 'pattern', 'url']
        .find((k) => typeof parsed[k] === 'string' && (parsed[k] as string).trim())
      if (key) return String(parsed[key]).slice(0, 60)
    } catch { /* partial args */ }
    return argsJson.replace(/\s+/g, ' ').slice(0, 60)
  }

  let resultText = ''
  let streamError: string | undefined
  let inputTokens = 0
  let outputTokens = 0

  // First user turn for the model. Priority:
  //  1. run.initialBlocks (session-agent spawn with attachments) — resolve
  //     via the same vision pipeline as mid-run steer (native / sidecar).
  //  2. Last session user message promptBlocks (continuation safety net).
  //  3. Plain prompt string (+ @-mention enrichment).
  // Without (1)/(2), history pops the last user bubble and resubmits plain
  // text only — attachments on the first turn were silently lost (review).
  let firstMessage: string | ContentBlockAPI[] = prompt
  try {
    const { resolveSteerItemsToContent } = await import('./steerContent')
    let blocks = run.initialBlocks
    if ((!blocks || blocks.length === 0) && run.continuation && chatSessionId) {
      const msgs = useChatStore.getState().sessions.get(chatSessionId)?.messages ?? []
      const last = [...msgs].reverse().find(m => m.role === 'user')
      if (last?.promptBlocks?.length) {
        blocks = last.promptBlocks
      } else if (last?.attachments?.length) {
        const b: import('../../../types/chat').PromptBlock[] = []
        if (last.content?.trim()) b.push({ type: 'text', text: last.content })
        for (const att of last.attachments) b.push({ type: 'attachment', attachment: att })
        blocks = b
      }
    }
    if (blocks && blocks.length > 0) {
      const resolved = await resolveSteerItemsToContent(
        [{ text: prompt, blocks }],
        { sessionId: chatSessionId },
      )
      if (resolved) firstMessage = resolved
    }
  } catch { /* multimodal is enrichment — never fail the task */ }

  // Fusão 4b: @-mentions no prompt da tarefa — MESMA resolução do main
  // (atMentions: snapshots em system-reminder + imagens multimodais). Os
  // caminhos resolvem contra o checkout principal: é o que o developer vê
  // quando escreve @ficheiro, e no arranque o worktree == HEAD. Best-effort.
  // Only enrich plain-string first messages; multimodal arrays already carry
  // the user text + attachments.
  try {
    if (typeof firstMessage === 'string' && /(^|\s)@\S/.test(firstMessage)) {
      const { resolveMentionContext } = await import('../atMentions')
      const mention = await resolveMentionContext(firstMessage)
      if (mention.contextText || mention.imageParts.length > 0) {
        const blocks: ContentBlockAPI[] = [{ type: 'text', text: firstMessage }]
        if (mention.contextText) blocks.push({ type: 'text', text: mention.contextText })
        for (const img of mention.imageParts) {
          blocks.push({ type: 'text', text: img.reminder })
          blocks.push({ type: 'image_url', image_url: { url: img.dataUri } })
        }
        firstMessage = blocks
      }
    }
  } catch { /* mentions são enriquecimento — nunca falham a tarefa */ }
  if (taskVolatileCtx && taskBuilder) {
    // FUSÃO F1: apêndice do volátil no núcleo único (builder efémero).
    const { appendVolatileToUserContent } = await import('../mainDispatch')
    firstMessage = appendVolatileToUserContent(firstMessage, {
      builder: taskBuilder,
      surface: `task:${runId}`,
    }) as typeof firstMessage
  }

  // Continuação: o histórico COMPLETO da sessão segue para o modelo — mesma
  // reconstrução do main (rebuildConversationHistory: tool-pairs, compact
  // boundaries, system omitidos). A bolha do prompt já está na sessão
  // (manager) e o submitMessage re-acrescenta o prompt — exclui-se a última
  // user message do histórico para não duplicar (rebuilt as firstMessage above,
  // including attachments when present).
  let history: ReturnType<typeof toQueryMessages> = []
  if (run.continuation && chatSessionId) {
    try {
      const msgs = useChatStore.getState().sessions.get(chatSessionId)?.messages ?? []
      const rebuilt = toQueryMessages(rebuildConversationHistory(msgs))
      if (rebuilt.length > 0 && rebuilt[rebuilt.length - 1].role === 'user') rebuilt.pop()
      history = rebuilt
    } catch { /* histórico é enriquecimento — a continuação corre na mesma */ }
  }

  try {
    const generator = engine.submitMessage(firstMessage, history)
    let result = await generator.next()
    while (!result.done) {
      const event = result.value as QueryStreamEvent
      const st = useParallelTaskStore.getState()
      switch (event.type) {
        case 'text_delta':
          resultText += event.text
          queueDelta(event.text)
          break
        case 'tool_use_start':
          flushDelta()
          safeUi(() => st.addToolCall(runId, { callId: event.id, toolName: event.name, argPreview: '', status: 'running' }))
          if (assistantMessageId) {
            const mid = assistantMessageId
            safeUi(() => useChatStore.getState().addPendingToolCall(event.id, event.name, undefined, mid))
          }
          break
        case 'tool_use_delta':
          if (event.input) argsByCallId.set(event.id, (argsByCallId.get(event.id) ?? '') + event.input)
          break
        case 'tool_use_stop': {
          const args = argsByCallId.get(event.id)
          if (args) {
            // Display com caminhos normalizados — o card do chat mostra
            // "src/App.tsx", não ".toquemedia/worktrees/task-…/src/App.tsx".
            let displayArgs: Record<string, unknown> | null = null
            let displayJson = args
            try {
              displayArgs = normalizeTaskPaths(JSON.parse(args) as Record<string, unknown>)
              displayJson = JSON.stringify(displayArgs)
            } catch { /* args parciais/inválidos — usa o bruto */ }
            safeUi(() => st.updateToolCall(runId, event.id, { argPreview: buildArgPreview(displayJson) }))
            if (assistantMessageId && displayArgs) {
              const mid = assistantMessageId
              const parsed = displayArgs
              safeUi(() => {
                useChatStore.getState().updateToolCallWithArgs(event.id, parsed, mid)
              })
            }
            argsByCallId.delete(event.id)
          }
          break
        }
        case 'tool_result':
          flushDelta()
          safeUi(() => st.updateToolCall(runId, event.toolUseId, {
            status: event.isError ? 'errored' : 'completed',
            resultPreview: typeof event.content === 'string' ? event.content.slice(0, 80) : undefined,
          }))
          if (assistantMessageId) {
            const mid = assistantMessageId
            safeUi(() => useChatStore.getState().updateToolCallWithResult(
              event.toolUseId,
              typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
              event.isError,
              mid,
            ))
          }
          break
        case 'message_stop':
          if (event.usage) {
            inputTokens += event.usage.prompt_tokens
            outputTokens += event.usage.completion_tokens
          }
          // Turno completo → flush + snapshot em disco (limitação #2: um
          // crash perde no máximo o turno em curso, não o transcript).
          flushDelta()
          if (chatSessionId) safeUi(() => useChatStore.getState().persistSessionNow(chatSessionId))
          break
        case 'error':
          streamError = event.message
          break
        default:
          break
      }
      result = await generator.next()
    }

    const terminal = result.value as QueryTerminal
    const finalStore = useParallelTaskStore.getState()
    const runNow = finalStore.runs.get(runId)
    if (runNow && runNow.status === 'running') {
      if (terminal.reason === 'error') {
        const errText = streamError || resultText || 'Model stream failed'
        finalStore.error(runId, errText)
        flushDelta()
        if (chatSessionId && assistantMessageId) {
          const mid = assistantMessageId
          safeUi(() => useChatStore.getState().finalizeAssistantMessageInSession(chatSessionId, mid))
        }
        appendToTaskSession(run.sessionId, {
          role: 'system',
          level: 'error',
          content: t('parallel.taskFailed').replace('{error}', errText),
        })
        stampTaskSessionStatus(run.sessionId, 'error')
      } else {
        finalStore.finalize(runId, resultText || 'Task finished (no summary produced).', {
          input: inputTokens, output: outputTokens,
        })
        flushDelta()
        if (chatSessionId && assistantMessageId) {
          const mid = assistantMessageId
          safeUi(() => useChatStore.getState().finalizeAssistantMessageInSession(
            chatSessionId, mid, resultText || 'Task finished (no summary produced).',
          ))
        } else {
          appendToTaskSession(run.sessionId, {
            role: 'assistant',
            content: resultText || 'Task finished (no summary produced).',
          })
        }
        stampTaskSessionStatus(run.sessionId, 'completed')
        void import('@/services/notificationService').then(({ notify }) =>
          notify({
            title: `✅ Task completed`,
            body: `"${run.description}" finished`,
            dedupKey: `parallel-task-done-${runId}`,
          }),
        )
      }
    }
  } catch (err) {
    const runNow = useParallelTaskStore.getState().runs.get(runId)
    if (runNow && runNow.status === 'running') {
      const errText = err instanceof Error ? err.message : String(err)
      useParallelTaskStore.getState().error(runId, errText)
      flushDelta()
      if (chatSessionId && assistantMessageId) {
        const mid = assistantMessageId
        safeUi(() => useChatStore.getState().finalizeAssistantMessageInSession(chatSessionId, mid))
      }
      appendToTaskSession(run.sessionId, {
        role: 'system',
        level: 'error',
        content: t('parallel.taskFailed').replace('{error}', errText),
      })
      stampTaskSessionStatus(run.sessionId, 'error')
    }
  } finally {
    flushDelta()
    if (deltaTimer) clearTimeout(deltaTimer)
    if (wallClock) clearTimeout(wallClock)
    if (persistBeat) clearInterval(persistBeat)
    abortController.signal.removeEventListener('abort', onAbort)
    toolExecutor.disposeIsolatedChild()
    // Fase 6 (inbox): se o developer estava A VER o chat da tarefa quando ela
    // terminou, o resultado conta como visto — nada de item fantasma no inbox.
    if (chatSessionId && useChatStore.getState().activeSessionId === chatSessionId) {
      useParallelTaskStore.getState().markResultSeen(runId)
    }

    // TRACKER POR-SESSÃO: num fim limpo, fecha as tarefas in_progress do
    // tracker DESTA tarefa (o agente faz o trabalho mas salta o update_tasks
    // de fecho — mesmo raciocínio do agente principal). Balde da sessão da
    // tarefa; nada toca no tracker do chat principal.
    if (chatSessionId && useParallelTaskStore.getState().runs.get(runId)?.status === 'completed') {
      const { useAgentStore } = await import('../../../stores/agentStore')
      const tk = useAgentStore.getState().getTasksForSession(chatSessionId)
      if (tk.some(x => x.status === 'in_progress')) {
        const closed = tk.map(x =>
          x.status === 'in_progress'
            ? { ...x, status: 'completed' as const, evidence: x.evidence || 'Task run completed' }
            : x,
        )
        useAgentStore.getState().setTasksForSession(chatSessionId, closed)
        void import('../taskPersistence')
          .then(({ saveTasksForSession }) => saveTasksForSession(projectPath, chatSessionId, closed))
          .catch(() => { /* best-effort */ })
      }
    }

    // Fase 5: fecho do worktree — auto-commita trabalho solto (branch
    // consumível) e diz ao developer onde o trabalho vive e como fundir.
    // O worktree fica SEMPRE no disco; remover é decisão do developer.
    if (worktree) {
      const wt = worktree
      const finishedOk = useParallelTaskStore.getState().runs.get(runId)?.status === 'completed'
      void finalizeTaskWorktree(wt, run.description)
        .then(async ({ aheadCount }) => {
          if (aheadCount === 0) return // nada para fundir — silêncio honesto
          // AUTO-MERGE (decisão do produto 2026-07-17): tarefa COMPLETA funde
          // sozinha na branch do developer; a nota manual só aparece como
          // fallback (conflito/recusa) ou em tarefas paradas/erradas.
          if (finishedOk) {
            const outcome = await autoMergeTaskBranch(wt, run.description)
            if (outcome.merged) {
              appendToTaskSession(run.sessionId, {
                role: 'system',
                level: 'info',
                content: t('parallel.mergedToBranch')
                  .replace('{count}', String(aheadCount))
                  .replace('{branch}', outcome.userBranch || 'main'),
              })
              return
            }
            if (outcome.conflicted) {
              appendToTaskSession(run.sessionId, {
                role: 'system',
                level: 'warn',
                content: t('parallel.mergeConflictFallback').replace('{branch}', wt.branch),
              })
              return
            }
          }
          appendToTaskSession(run.sessionId, {
            role: 'system',
            level: 'info',
            content: t('parallel.worktreeResult')
              .replace('{branch}', wt.branch)
              .replace('{count}', String(aheadCount))
              .replace('{path}', wt.path),
          })
        })
        .catch(() => { /* best-effort */ })
    }

    // H10 (ronda crítica): orientações enfileiradas que o run nunca drenou
    // (tarefa terminou/foi parada antes do turn boundary) não podem morrer
    // em silêncio — a bolha do user está no transcript; di-lo explicitamente.
    const undrained = useParallelTaskStore.getState().drainSteer(runId)
    if (undrained.length > 0) {
      appendToTaskSession(run.sessionId, {
        role: 'system',
        level: 'warn',
        content: t('parallel.steerUndelivered'),
      })
    }
    // Fase 3: a equipa delegada por esta tarefa morre com ela — aborta os
    // sub-agents ainda vivos e descarta entregas sem destinatário.
    void import('../../../stores/subAgentStore').then(({ useSubAgentStore }) => {
      useSubAgentStore.getState().abortByOwner(runId)
    }).catch(() => {})
    void import('../subAgents/autoWake').then(({ dropSubAgentDeliveriesForOwner }) => {
      dropSubAgentDeliveriesForOwner(runId)
    }).catch(() => {})
    // F2 MDI: kill THIS task's own background processes (owner = runId). The
    // main run's cancel kills only owner 'main', so the task reaps its own here.
    void import('../../../stores/backgroundCommandStore').then(async ({ useBackgroundCommandStore }) => {
      const { invoke } = await import('@/utils/invokeMetrics')
      const store = useBackgroundCommandStore.getState()
      for (const c of store.getAll()) {
        if (c.owner === runId && c.status === 'running') {
          try { await invoke('kill_process', { pid: c.pid }) } catch { /* best effort */ }
          store.cancelCommand(c.id)
        }
      }
    }).catch(() => {})
    // User stop lands as status 'aborted' (store.abort), which the terminal
    // branches above deliberately skip — close the transcript here instead.
    if (useParallelTaskStore.getState().runs.get(runId)?.status === 'aborted') {
      flushDelta()
      if (chatSessionId && assistantMessageId) {
        const mid = assistantMessageId
        safeUi(() => useChatStore.getState().finalizeAssistantMessageInSession(chatSessionId, mid))
      }
      appendToTaskSession(run.sessionId, {
        role: 'system',
        level: 'info',
        content: t('parallel.taskStopped'),
      })
      stampTaskSessionStatus(run.sessionId, 'aborted')
    }
    releaseOwnerClaims(runId)
    // #9 B2: settle this background project-run's cross-window badge (done /
    // error / idle-on-abort). persistBeat is already cleared (833) so no
    // 'running' heartbeat races this terminal write.
    if (projectPath) {
      const finalStatus = useParallelTaskStore.getState().runs.get(runId)?.status
      writeProjectRunBadge(
        projectPath,
        finalStatus === 'error' ? 'error' : finalStatus === 'aborted' ? 'idle' : 'done',
        { label: run.description },
      )
    }
    pumpParallelTasks() // a slot just freed — start the next queued task
  }
}
