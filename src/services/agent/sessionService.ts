import { invoke } from '@/utils/invokeMetrics'
import { ChatSession, ChatMessage, PersistedSession, SessionSummary, ToolCallDisplay, ByokSessionSnapshot, SessionTurnSnapshot } from '../../types/chat'
import { logger } from '../../utils/logger'
// Sessões são JSON em claro (pedido do developer, 2026-08-06 e de novo
// 2026-08-17). São um artefacto de depuração: lêem-se, exportam-se e
// partilham-se. Cifrá-las com uma chave derivada do caminho do projecto
// protegia contra nada (a chave está no mesmo disco) e tornava o ficheiro
// inútil. Ficheiros antigos (ENC1: / {_enc,d}) ainda abrem — decrypt +
// overwrite in-place — para o disco ficar alinhado com a regra.
import { hashProjectPath, decryptSession, isEncryptedSession } from '../../utils/crypto'
import { useByokStore } from '../../stores/byokStore'
import { getProjectSessionsDir } from '../projectStatePaths'
import { READ_ALIAS } from './toolNames'
import { countDiffLineStats } from '../../utils/diffStats'

/** Snapshot the current BYOK selection so the session uses the same provider
 *  and model for its entire lifetime, even if the user later switches the
 *  active selection in Settings. Returns null when BYOK is not active or
 *  not configured.
 *
 *  Capabilities are captured whenever the model isn't a registry hit — both
 *  for `custom` providers (no registry) and for "other model" mode on a
 *  curated provider (model id not in our hardcoded catalog). The IDE then
 *  forwards them as X-BYOK-Capabilities and the backend trusts them over
 *  the registry. */
export function captureByokSnapshot(): ByokSessionSnapshot | null {
  const state = useByokStore.getState()
  const active = state.resolveActive()
  if (!active) return null
  const inRegistry = active.provider.models.some(m => m.id === active.model.id)
  const isCustom = active.provider.custom === true
  const isLocal = active.provider.local === true
  // Context window: the USER declares it in Settings (perProviderConfig) since
  // the BYOK request bypasses the worker (no X-Model-Context-Window header).
  // Fall back to the catalog model's window, then to undefined (agentService
  // then uses FALLBACK_CONTEXT_WINDOW).
  const userCw = state.perProviderConfig[active.provider.id]?.contextWindow
  const reasoningEffort = state.perProviderConfig[active.provider.id]?.reasoningEffort
  const contextWindow =
    userCw && userCw > 0
      ? userCw
      : active.model.contextWindow > 0
        ? active.model.contextWindow
        : undefined
  return {
    providerId: active.provider.id,
    modelId: active.model.id,
    baseURL: active.baseURL,
    custom: isCustom,
    local: isLocal,
    capabilities: !inRegistry ? active.model.capabilities : undefined,
    // Thinking shape is part of the model spec — freeze it on the snapshot
    // so the request body sends the right param shape per BYOK provider
    // (anthropic / openai / qwen / gemini), not the plan-profile shape.
    supportsThinking: active.model.supportsThinking,
    thinkingShape: active.model.thinkingShape,
    reasoningEffort,
    contextWindow,
  }
}

/**
 * Um diff JÁ RESOLVIDO não guarda o conteúdo — nem em disco, nem em memória.
 *
 * MEDIDO a 2026-08-12, e é o maior item de todos: `sanitizeMessageForSave`
 * fazia `...tc` e só truncava o `result`, portanto `diffOldContent` +
 * `diffNewContent` — DUAS cópias completas do ficheiro por edição — iam
 * inteiras para o disco. Num ficheiro de sessão de 19,7 MB: **11,9 MB (60%)
 * eram diffs**, em 185 tool calls, contra 0,6 MB de results (esses truncados).
 * Total em disco na máquina do developer: **391 MB**. E tudo isso volta a ser
 * materializado ao ABRIR o projecto — medido: +553 MB de RSS só na abertura.
 *
 * PORQUE NÃO CHEGAVA O `releaseResolvedDiff` do chatStore: aquele tem um
 * limiar de 200 KB POR DIFF, pensado para não estragar o cartão de um diff
 * normal. A média real são ~64 KB por diff, portanto quase nenhum passa o
 * limiar — e o problema nunca foi um diff grande, é a SOMA de 185 médios.
 * Aqui não há limiar: depois de aprovado ou recusado a edição já está (ou não
 * está) no disco, e as cópias só serviam para re-renderizar um cartão fechado.
 *
 * PENDENTE fica intacto, sempre: esse ainda precisa de ser mostrado para o
 * developer decidir. As contagens `diffAdded`/`diffRemoved` FICAM — o header
 * compacto precisa delas depois de reabrir o projecto. Sem conteúdo o corpo
 * do diff não expande; os +N −M continuam visíveis.
 */
function stripResolvedDiff(tc: ToolCallDisplay): ToolCallDisplay {
  if (tc.diffStatus !== 'approved' && tc.diffStatus !== 'denied') return tc
  if (tc.diffOldContent === undefined && tc.diffNewContent === undefined) return tc
  const next = { ...tc }
  if (next.diffAdded === undefined && next.diffRemoved === undefined) {
    const stats = countDiffLineStats(
      next.diffOldContent || '',
      next.diffNewContent || '',
      next.isNewFile === true,
    )
    next.diffAdded = stats.added
    next.diffRemoved = stats.removed
  }
  delete next.diffOldContent
  delete next.diffNewContent
  return next
}

const MAX_SESSIONS_PER_PROJECT = 50
const MAX_TOOL_RESULT_LENGTH = 2000
/** Quanto do teto fica reservado ao FIM do output. Ver `truncateToolResult`. */
const TOOL_RESULT_TAIL_SHARE = 0.4

/**
 * Corta um tool result para persistência guardando CABEÇA **e** CAUDA.
 *
 * PORQUE NÃO É SÓ `slice(0, N)` (auditoria da sessão golive, 2026-08-10)
 * ────────────────────────────────────────────────────────────────────
 * Era. E para os outputs que mais interessa auditar — `yarn build`, `firebase
 * deploy`, `yarn test` — o veredicto vive no FIM: "Deploy complete!", o exit
 * code, o número de testes que falharam. Guardar os primeiros 2000 chars de um
 * deploy de 20KB preserva a lista de APIs a serem activadas e deita fora a
 * única linha que diz se correu bem.
 *
 * Na sessão auditada, 28 dos 66 resultados saíram assim — incluindo os quatro
 * deploys de produção, todos cortados em "hosting: beginning deploy...". O
 * runtime faz o contrário (guarda a cauda e injecta um `<system-reminder>` com
 * `read_large_result`), portanto o ficheiro exportado era menos fiável do que o
 * que o modelo tinha visto — e o export existe precisamente para auditar.
 *
 * Guardar as duas pontas custa o mesmo em bytes e mantém o comando E o
 * resultado. O marcador diz quanto se perdeu, para ninguém ler o meio que não
 * existe como se fosse contíguo.
 */
function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result

  const tailChars = Math.floor(MAX_TOOL_RESULT_LENGTH * TOOL_RESULT_TAIL_SHARE)
  const headChars = MAX_TOOL_RESULT_LENGTH - tailChars
  const dropped = result.length - MAX_TOOL_RESULT_LENGTH

  return (
    result.slice(0, headChars) +
    `\n\n[… ${dropped.toLocaleString()} chars omitidos na persistência — ` +
    `original ${result.length.toLocaleString()} chars …]\n\n` +
    result.slice(result.length - tailChars)
  )
}
/** Teto do mentionContext persistido por mensagem (~30K chars ≈ 7.5K tokens).
 *  Display/contexto continua completo em memória; só o disco é capado. */
const MAX_MENTION_CONTEXT_PERSIST = 30_000
/** Legacy home-dir root for sessions written before project-id based app
 *  state. Kept only as the SOURCE side of the one-shot migration in
 *  `migrateLegacySessions`; nothing else reads from here. */
const LEGACY_BASE_DIR_NAMES = ['.tmcode', '.toquemedia-studio'] as const

class SessionService {
  private static instance: SessionService
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private saving = false
  private getSessionFn: (() => ChatSession | null) | null = null
  private getTokenUsageFn: (() => { input: number; output: number; turns: number }) | null = null
  private getTurnSnapshotFn: (() => SessionTurnSnapshot | null) | null = null
  // Tracks the promise of the most recent saveSession invocation. Used by
  // deleteAllProjectSessions to await any in-flight write before unlinking
  // the directory — otherwise Tauri's thread pool can interleave write_file
  // and delete_file_or_directory, recreating a session file inside (or just
  // after) the directory we're trying to remove.
  private currentSavePromise: Promise<void> | null = null
  /**
   * ESCRITOR ÚNICO: todas as gravações passam por esta cadeia. O índice de
   * sumários é um read-modify-write partilhado — gravações concorrentes
   * (flush da sessão ativa + save direto de uma sessão de tarefa, ou duas
   * tarefas a terminar juntas) intercalavam e PERDIAM entradas/estados do
   * índice (ronda estrutural 2026-07-17).
   */
  private saveChain: Promise<void> = Promise.resolve()
  // Set to true while deleteAllProjectSessions is running so any in-flight
  // saveSession that completes between the await and the actual unlink
  // becomes a no-op rather than re-creating the file. Reset after delete.
  private deletingProjectPath: string | null = null

  static getInstance(): SessionService {
    if (!SessionService.instance) {
      SessionService.instance = new SessionService()
    }
    return SessionService.instance
  }

  setSessionGetter(fn: () => ChatSession | null) {
    this.getSessionFn = fn
  }

  setTokenUsageGetter(fn: () => { input: number; output: number; turns: number }) {
    this.getTokenUsageFn = fn
  }

  /** Snapshot of the last on-wire turn — persisted alongside the session so
   *  the context-window indicator survives a reload (otherwise the bar
   *  shows 0% until the next turn). Read at save time only; no-op when unset. */
  setTurnSnapshotGetter(fn: () => SessionTurnSnapshot | null) {
    this.getTurnSnapshotFn = fn
  }

  /** Legacy home-dir base — used ONLY by `migrateLegacySessions` to locate
   *  the pre-migration data on first init. New writes never touch this. */
  private async getLegacyBasePaths(): Promise<string[]> {
    const home = await invoke<string>('get_home_directory')
    const normalized = home.endsWith('/') || home.endsWith('\\') ? home.slice(0, -1) : home
    return LEGACY_BASE_DIR_NAMES.map(name => `${normalized}/${name}`)
  }

  /** Sessions are tool state. They live in the app's per-project state dir,
   *  keyed by `.toquemedia-id`, so the user's project tree stays clean. */
  private async getSessionsDir(projectPath: string): Promise<string> {
    return getProjectSessionsDir(projectPath)
  }

  /** Path under the LEGACY home-dir scheme. Used only during migration. */
  private async getLegacySessionsDirs(projectPath: string): Promise<string[]> {
    const bases = await this.getLegacyBasePaths()
    const hash = await hashProjectPath(projectPath)
    return bases.map(base => `${base}/sessions/${hash}`)
  }

  private async getSessionFilePath(projectPath: string, sessionId: string): Promise<string> {
    const dir = await this.getSessionsDir(projectPath)
    return `${dir}/session_${sessionId}.json`
  }

  private async getActiveSessionFile(projectPath: string): Promise<string> {
    const dir = await this.getSessionsDir(projectPath)
    return `${dir}/active_session.json`
  }

  private async getIndexFile(projectPath: string): Promise<string> {
    const dir = await this.getSessionsDir(projectPath)
    return `${dir}/sessions_index.json`
  }

  /**
   * If `raw` is a pre-2026-08-06 AES-GCM envelope, decrypt it and overwrite
   * the file as pretty JSON. Returns the plaintext (rewritten or already
   * clear). Null means ciphertext that would not decrypt — caller treats
   * that as an unreadable session, same as a corrupt file.
   */
  private async rewritePlaintextIfEncrypted(
    filePath: string,
    projectPath: string,
    raw: string,
  ): Promise<string | null> {
    if (!isEncryptedSession(raw)) return raw
    const decrypted = await decryptSession(raw, projectPath)
    if (decrypted === null) return null
    try {
      const pretty = JSON.stringify(JSON.parse(decrypted), null, 2)
      await invoke('write_file', { path: filePath, content: pretty })
      return pretty
    } catch (error) {
      logger.warn('session', `Failed to rewrite encrypted session ${filePath} as plaintext:`, error)
      return decrypted
    }
  }

  /** Best-effort scan on project init so leftover ciphertext does not sit on disk. */
  private async rewriteEncryptedSessionFiles(projectPath: string): Promise<void> {
    const dir = await this.getSessionsDir(projectPath)
    const markerPath = `${dir}/.plaintext`
    try {
      await invoke<string>('read_file', { path: markerPath })
      return
    } catch { /* first pass — scan */ }

    // `list_directory` is NOT a Tauri command (it is an agent tool over
    // `build_file_tree`). The first version of this scan invoked it and
    // silently no-op'd on every project open.
    let paths: string[] = []
    try {
      paths = await invoke<string[]>('glob_files', {
        pattern: 'session_*.json',
        directory: dir,
      })
    } catch {
      return
    }
    for (const filePath of paths) {
      try {
        const raw = await invoke<string>('read_file', { path: filePath })
        await this.rewritePlaintextIfEncrypted(filePath, projectPath, raw)
      } catch (error) {
        logger.warn('session', `Failed to inspect session ${filePath} for plaintext rewrite:`, error)
      }
    }
    try {
      await invoke('write_file', { path: markerPath, content: new Date().toISOString() })
    } catch { /* next open retries the scan */ }
  }

  // === Lifecycle ===

  async init(projectPath: string): Promise<void> {
    try {
      await invoke('migrate_project_state', { projectPath })
    } catch (error) {
      logger.warn('session', 'Project state migration failed (non-fatal):', error)
    }

    const dir = await this.getSessionsDir(projectPath)
    try {
      await invoke('create_directories_all', { path: dir })
    } catch (error) {
      logger.error('session', 'Failed to create sessions directory:', error)
    }

    // One-shot migration from the legacy home-dir layout. Runs every init
    // but is cheap (`list_directory` + a marker check) and short-circuits
    // when there's nothing to migrate. After it succeeds the marker stops
    // future runs from doing anything.
    try {
      await this.migrateLegacySessions(projectPath)
    } catch (error) {
      // Migration failure is non-fatal — sessions in the legacy location
      // remain readable via manual rescue if ever needed. New writes go
      // to the project regardless.
      logger.warn('session', 'Legacy session migration failed (non-fatal):', error)
    }

    // After the copy, any leftover AES-GCM envelopes become readable JSON.
    try {
      await this.rewriteEncryptedSessionFiles(projectPath)
    } catch (error) {
      logger.warn('session', 'Encrypted session rewrite failed (non-fatal):', error)
    }

    // Legacy no-op kept for older frontend/native combinations.
    try {
      await invoke('ensure_toquemedia_gitignore_cmd', { projectPath })
    } catch (error) {
      logger.warn('session', 'Legacy state ignore update failed:', error)
    }

    // Clean up stale empty sessions from previous runs (e.g. if app crashed before cleanup)
    try {
      await this.cleanupEmptySessions(projectPath)
    } catch {
      // Ignore — index may not exist yet on first run
    }
  }

  /**
   * One-shot best-effort migration of the legacy session tree from
   * `~/.tmcode/sessions/{projectHash}/` (or the pre-rename
   * `~/.toquemedia-studio/sessions/{projectHash}/`) into the project-id keyed
   * sessions directory. Idempotent via a `.migrated` marker file in the new
   * directory — after the first successful run, every
   * subsequent init returns immediately.
   *
   * The migration is intentionally simple: copy every file from legacy
   * to new, then write the marker. Ciphertext copied here is rewritten
   * to plaintext by `rewriteEncryptedSessionFiles` on the same init.
   * The legacy tree is LEFT in place — we don't risk data loss if the
   * user rolls back, and the orphan can be cleaned by an admin command
   * later. The legacy dir won't appear in the IDE again because nothing
   * reads from it post-migration.
   */
  private async migrateLegacySessions(projectPath: string): Promise<void> {
    const newDir = await this.getSessionsDir(projectPath)
    const markerPath = `${newDir}/.migrated`

    // Marker check — already migrated.
    try {
      await invoke<string>('read_file', { path: markerPath })
      return
    } catch { /* not migrated yet — continue */ }

    const legacyDirs = await this.getLegacySessionsDirs(projectPath)
    // Probe each historic home-dir layout. If none exist or they are empty,
    // write the marker and exit — nothing to migrate, but we still drop
    // the marker so future inits don't re-probe.
    let legacyDir = ''
    let legacyEntries: string[] = []
    for (const candidate of legacyDirs) {
      try {
        // Same command the rest of the app uses to list a folder — there is
        // no Tauri `list_directory` (that name is an agent tool).
        const entries = await invoke<string[]>('glob_files', {
          pattern: '*',
          directory: candidate,
        })
        if (entries.length > 0) {
          legacyDir = candidate
          legacyEntries = entries
          break
        }
      } catch {
        /* try next historic path */
      }
    }
    if (!legacyDir) {
      try {
        await invoke('write_file', { path: markerPath, content: 'no-legacy' })
      } catch { /* marker write best-effort */ }
      return
    }
    if (legacyEntries.length === 0) {
      try {
        await invoke('write_file', { path: markerPath, content: 'empty-legacy' })
      } catch { /* best-effort */ }
      return
    }

    // Copy every file. The legacy dir is flat (session_*.json, active_session.json,
    // sessions_index.json, queue-operations.jsonl) — no nested traversal needed.
    let migrated = 0
    for (const entry of legacyEntries) {
      const basename = entry.split('/').pop() ?? entry
      const srcPath = entry.includes('/') ? entry : `${legacyDir}/${basename}`
      const destPath = `${newDir}/${basename}`
      try {
        const content = await invoke<string>('read_file', { path: srcPath })
        await invoke('write_file', { path: destPath, content })
        migrated++
      } catch (err) {
        logger.warn('session', `Failed to migrate ${basename}:`, err)
      }
    }
    logger.info('session', `Migrated ${migrated}/${legacyEntries.length} legacy session files for ${projectPath}`)

    // Marker written last so partial migrations (process killed mid-loop)
    // re-attempt next init and finish copying. The copy step is idempotent
    // — write_file overwrites — so re-running is safe.
    try {
      await invoke('write_file', {
        path: markerPath,
        content: JSON.stringify({
          migratedAt: new Date().toISOString(),
          fileCount: migrated,
          legacyDir,
        }, null, 2),
      })
    } catch { /* marker write best-effort */ }
  }

  // === Session CRUD ===

  async createSession(projectPath: string): Promise<ChatSession> {
    const now = Date.now()
    const sessionId = `sess_${now}_${Math.random().toString(36).slice(2, 8)}`

    const session: ChatSession = {
      id: sessionId,
      projectPath,
      messages: [],
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      byokSnapshot: captureByokSnapshot(),
    }

    await this.saveSession(session)
    await this.setActiveSessionId(projectPath, sessionId)
    await this.enforceMaxSessions(projectPath)

    return session
  }

  async loadSession(projectPath: string, sessionId: string): Promise<ChatSession | null> {
    try {
      const filePath = await this.getSessionFilePath(projectPath, sessionId)
      const raw = await invoke<string>('read_file', { path: filePath })
      const json = await this.rewritePlaintextIfEncrypted(filePath, projectPath, raw)
      if (json === null) return null
      const persisted: PersistedSession = JSON.parse(json)

      // Truncate tool results that may have been saved with full content
      const messages = persisted.messages.map(msg => this.sanitizeMessage(msg))

      // Carry the persisted turn snapshot through on the returned session
      // even though it isn't a formal ChatSession field — the chatStore
      // loader reads it via type assertion to restore the context-window
      // indicator without requiring a parallel return value.
      const out: ChatSession = {
        id: persisted.id,
        projectPath: persisted.projectPath,
        messages,
        status: persisted.status === 'running' ? 'idle' : persisted.status,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        byokSnapshot: persisted.byokSnapshot ?? null,
        sessionMemory: persisted.sessionMemory,
        planResumePending: persisted.planResumePending ?? null,
        requestUsageLog: persisted.requestUsageLog,
        lastTurnSnapshot: persisted.lastTurnSnapshot,
        lastPromptTokens: persisted.lastPromptTokens,
        lastResponseTokens: persisted.lastResponseTokens,
        peakPromptTokens: persisted.peakPromptTokens,
      }
      if (persisted.isParallelTask) {
        out.isParallelTask = true
        // Um 'running' persistido é órfão (crash/quit a meio do run — o
        // processo que corria a tarefa morreu). Normaliza para 'aborted'.
        out.parallelTaskStatus =
          persisted.parallelTaskStatus === 'running' ? 'aborted' : persisted.parallelTaskStatus
      }
      return out
    } catch (error) {
      logger.error('session', `Failed to load session ${sessionId}:`, error)
      return null
    }
  }

  async saveSession(session: ChatSession, tokenUsage?: { input: number; output: number; turns: number }): Promise<void> {
    // Refuse new saves for a project that's mid-deletion. Without this guard
    // a debounced save fired just before deleteProject ran could complete
    // its write_file AFTER the directory was removed, recreating it with a
    // stale session file inside.
    if (this.deletingProjectPath === session.projectPath) return
    const promise = this.saveChain.then(() => this._writeSessionToDisk(session, tokenUsage))
    // A cadeia sobrevive a falhas — um save rejeitado não pode encravar todos
    // os seguintes.
    this.saveChain = promise.catch(() => {})
    this.currentSavePromise = promise
    try {
      await promise
    } finally {
      if (this.currentSavePromise === promise) this.currentSavePromise = null
    }
  }

  private async _writeSessionToDisk(session: ChatSession, tokenUsage?: { input: number; output: number; turns: number }): Promise<void> {
    try {
      const filePath = await this.getSessionFilePath(session.projectPath, session.id)

      const persisted: PersistedSession = {
        id: session.id,
        projectPath: session.projectPath,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        messages: session.messages
          .map(msg => this.sanitizeMessageForSave(msg))
          .filter((m): m is ChatMessage => m !== null),
        byokSnapshot: session.byokSnapshot ?? null,
        sessionMemory: session.sessionMemory,
        planResumePending: session.planResumePending ?? null,
        requestUsageLog: session.requestUsageLog,
        lastPromptTokens: session.lastPromptTokens,
        lastResponseTokens: session.lastResponseTokens,
        peakPromptTokens: session.peakPromptTokens,
        // Tarefas paralelas: flag + estado persistem para as rows da
        // sidebar/ProjectMenu sobreviverem a reload (o chat da tarefa fica
        // consultável a qualquer momento — pedido do user 2026-07-16).
        ...(session.isParallelTask && { isParallelTask: true }),
        ...(session.parallelTaskStatus && { parallelTaskStatus: session.parallelTaskStatus }),
      }

      if (tokenUsage) {
        persisted.tokenUsage = {
          totalPromptTokens: tokenUsage.input,
          totalCompletionTokens: tokenUsage.output,
          totalTurns: tokenUsage.turns,
        }
      }

      const turnSnapshot = this.getTurnSnapshotFn?.()
      if (turnSnapshot) {
        persisted.lastTurnSnapshot = turnSnapshot
      }

      const json = JSON.stringify(persisted, null, 2)
      // Re-check the kill switch right before the actual write. Between the
      // start of this method and now, JSON encoding has run; the user may
      // have triggered deletion in that window.
      if (this.deletingProjectPath === session.projectPath) return
      await invoke('write_file', { path: filePath, content: json })
      // Restrict file permissions to owner-only (600) to protect sensitive session data
      try {
        const safePath = filePath.replace(/'/g, "'\\''")
        await invoke('execute_command', { command: `chmod 600 '${safePath}'`, cwd: '/' })
      } catch { /* non-fatal on non-Unix or sandboxed environments */ }
      await this.updateIndex(session.projectPath, session)
    } catch (error) {
      logger.error('session', `Failed to save session ${session.id}:`, error)
    }
  }

  /**
   * Enfileira uma mutação do ÍNDICE na mesma cadeia dos saves. Sem isto, o
   * removeFromIndex/updateIndex faziam read-modify-write FORA da cadeia: um
   * save concorrente (heartbeat de tarefa, persist da ativa) que tivesse lido
   * o índice ANTES da remoção escrevia a lista velha por cima e RESSUSCITAVA
   * a entrada apagada — o "fechei a tarefa mas continua no menu de sessões"
   * (report do user 2026-07-17).
   */
  private enqueueIndexWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.saveChain.then(op)
    this.saveChain = run.then(() => undefined, () => undefined)
    return run
  }

  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    await this.enqueueIndexWrite(async () => {
      try {
        const filePath = await this.getSessionFilePath(projectPath, sessionId)
        await invoke('delete_file_or_directory', { path: filePath })
        await this.removeFromIndex(projectPath, sessionId)
      } catch (error) {
        logger.error('session', `Failed to delete session ${sessionId}:`, error)
      }
    })
  }

  async deleteAllProjectSessions(projectPath: string): Promise<void> {
    // 1. Latch the kill switch so any saveSession invocation racing with
    //    this delete becomes a no-op once it observes the flag.
    this.deletingProjectPath = projectPath
    try {
      // 2. Wait for the in-flight save (if any) started BEFORE the latch
      //    was set. _writeSessionToDisk re-checks the latch right before
      //    invoke('write_file'), so a save that started the JSON encoding
      //    pass earlier will short-circuit before touching disk. Awaiting
      //    here makes the ordering deterministic — without it the JS
      //    promise + Tauri thread-pool interleaving could complete the
      //    write AFTER our delete_file_or_directory call returns.
      if (this.currentSavePromise) {
        try { await this.currentSavePromise } catch { /* swallowed in saveSession */ }
      }
      // 3. Now safe to remove the directory. Subsequent debounced/streaming
      //    saves that try to fire will hit the latch and bail.
      const dir = await this.getSessionsDir(projectPath)
      await invoke('delete_file_or_directory', { path: dir })
      logger.info('session', `Deleted all sessions for project: ${projectPath}`)
    } catch (error) {
      logger.error('session', 'Failed to delete all project sessions:', error)
    } finally {
      // 4. Clear the latch so opening a different project later isn't blocked
      //    from saving. (Per-project: only writes targeting `projectPath`
      //    were blocked; other paths were always allowed.)
      if (this.deletingProjectPath === projectPath) {
        this.deletingProjectPath = null
      }
    }
  }

  // === Session listing ===

  async listSessions(projectPath: string): Promise<SessionSummary[]> {
    try {
      const indexPath = await this.getIndexFile(projectPath)
      const content = await invoke<string>('read_file', { path: indexPath })
      const summaries: SessionSummary[] = JSON.parse(content)
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  // === Active session pointer ===

  async getActiveSessionId(projectPath: string): Promise<string | null> {
    try {
      const filePath = await this.getActiveSessionFile(projectPath)
      const content = await invoke<string>('read_file', { path: filePath })
      const data = JSON.parse(content)
      return data.sessionId || null
    } catch {
      return null
    }
  }

  async setActiveSessionId(projectPath: string, sessionId: string): Promise<void> {
    try {
      const filePath = await this.getActiveSessionFile(projectPath)
      await invoke('write_file', {
        path: filePath,
        content: JSON.stringify({ sessionId, updatedAt: Date.now() }),
      })
    } catch (error) {
      logger.error('session', 'Failed to set active session:', error)
    }
  }

  // === Auto-save ===

  markDirty() {
    this.dirty = true
  }

  startAutoSave(intervalMs: number = 30000): void {
    this.stopAutoSave()
    this.autoSaveInterval = setInterval(() => {
      if (this.dirty) {
        this.flushNow()
      }
    }, intervalMs)
  }

  stopAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval)
      this.autoSaveInterval = null
    }
  }

  async flushNow(): Promise<void> {
    if (!this.dirty || !this.getSessionFn || this.saving) return

    this.saving = true
    try {
      const session = this.getSessionFn()
      if (session) {
        // Skip saving empty sessions — prevents repeated writes when the
        // user opens a project but doesn't type anything. Initial creation
        // (createSession) uses saveSession directly, so it's unaffected.
        if (session.messages.length === 0) {
          this.dirty = false
          return
        }
        const tokenUsage = this.getTokenUsageFn?.()
        await this.saveSession(session, tokenUsage ?? undefined)
        this.dirty = false
      }
    } finally {
      this.saving = false
    }
  }

  // === Internal helpers ===

  private sanitizeMessage(msg: ChatMessage): ChatMessage {
    if (!msg.toolCalls?.length) return msg
    return {
      ...msg,
      // Também na LEITURA, e não só na escrita: as sessões já gravadas trazem
      // o conteúdo todo (391 MB em disco na máquina do developer a 12-08), e
      // sem o strip aqui uma sessão antiga voltava a materializá-lo inteiro
      // ao abrir o projecto. Com ele, o custo desaparece na abertura e a
      // gravação seguinte já persiste a forma pequena.
      toolCalls: msg.toolCalls.map(tc => stripResolvedDiff({
        ...tc,
        result: tc.result ? truncateToolResult(tc.result) : tc.result,
      })),
    }
  }

  private sanitizeMessageForSave(msg: ChatMessage): ChatMessage | null {
    // Drop ephemeral status messages from the persisted session. They were
    // transient by design (permission grants, "session saved" feedback,
    // dev-server lifecycle) — the in-memory timer already removes them after
    // ~8s, persisting would resurrect them on the next reload as stale noise.
    if (msg.ephemeral) return null

    const sanitized: ChatMessage = {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
    }

    // Persist UI-discriminator + meta fields. These were silently dropped by
    // the earlier "copy these 7 fields" sanitizer — bug exposed when the user
    // reloaded a chat with a pending plan_approval card and the card returned
    // as an empty system message (no approve/reject buttons). Same class of
    // bug for the compact_boundary marker and per-turn token stats.
    //
    // Rule: anything that drives rendering OR resumes a user-actionable flow
    // (cards, permission requests) goes in here. Anything that's purely
    // runtime state (isStreaming, in-flight resolve promises) does NOT.
    if (msg.card) sanitized.card = msg.card
    if (msg.level) sanitized.level = msg.level
    if (msg.kind) sanitized.kind = msg.kind
    if (typeof msg.compactBeforeTokens === 'number') {
      sanitized.compactBeforeTokens = msg.compactBeforeTokens
    }
    if (typeof msg.thinkingRequested === 'boolean') {
      sanitized.thinkingRequested = msg.thinkingRequested
    }
    // Effort por turno (managed) — o seletor é global; o histórico precisa do
    // valor carimbado em cada mensagem do assistente para o user ver o que
    // cada pedido usou (e se o header saiu de facto).
    if (typeof msg.reasoningEffort === 'string' && msg.reasoningEffort) {
      sanitized.reasoningEffort = msg.reasoningEffort
    }
    if (typeof msg.reasoningEffortSent === 'boolean') {
      sanitized.reasoningEffortSent = msg.reasoningEffortSent
    }
    if (typeof msg.turnDurationMs === 'number') sanitized.turnDurationMs = msg.turnDurationMs
    if (typeof msg.turnInputTokens === 'number') sanitized.turnInputTokens = msg.turnInputTokens
    if (typeof msg.turnOutputTokens === 'number') sanitized.turnOutputTokens = msg.turnOutputTokens

    // @-mention context must survive reloads — rebuildConversationHistory
    // re-emits it on every follow-up turn (claude-vaz keeps the equivalent
    // attachment messages in the persisted transcript). CAPPED on disk: uma
    // menção pode carregar até 2000 linhas de ficheiro; persistir isso por
    // mensagem inchava os ficheiros de sessão (escrever em cada autosave).
    // Em memória fica completo durante a sessão; após reload o
    // modelo vê o prefixo + nota para reler com read_file se precisar.
    if (msg.mentionContext) {
      sanitized.mentionContext = msg.mentionContext.length > MAX_MENTION_CONTEXT_PERSIST
        ? msg.mentionContext.slice(0, MAX_MENTION_CONTEXT_PERSIST)
          + `\n<system-reminder>[mention context truncated on session reload — re-read the file with ${READ_ALIAS} if its tail matters]</system-reminder>`
        : msg.mentionContext
      // Paths the snapshot covers — lets the reload-time rebuild still void a
      // snapshot a later tool superseded (mentionContext staleness fix).
      if (msg.mentionedPaths?.length) sanitized.mentionedPaths = msg.mentionedPaths
    }

    // Persist attachment metadata WITHOUT base64. The base64 data URI is
    // potentially several MB per image and would bloat the session file.
    // On reload, attachments come back with only metadata
    // (id, type, name, path, mimeType, sizeBytes) — image base64 is gone,
    // so multimodal reconstruction in rebuildConversationHistory falls
    // back to the text path. Multimodal across app restarts is a known
    // limitation; in-session multimodal works correctly.
    if (msg.attachments?.length) {
      sanitized.attachments = msg.attachments.map(a => {
        const { base64: _base64, ...rest } = a
        return rest
      })
    }

    // Persist promptBlocks the same way — preserve the interleaved
    // ordering, but strip base64 from any attachment blocks. On reload
    // the block ordering is intact (so the bubble can still derive a
    // correct display) but image content has to be re-resolved from
    // disk via attachment.path if multimodal is needed.
    if (msg.promptBlocks?.length) {
      sanitized.promptBlocks = msg.promptBlocks.map(block => {
        if (block.type === 'attachment') {
          const { base64: _base64, ...rest } = block.attachment
          return { type: 'attachment' as const, attachment: rest }
        }
        return block
      })
    }

    if (msg.codeBlocks?.length) {
      sanitized.codeBlocks = msg.codeBlocks
    }

    if (msg.toolCalls?.length) {
      sanitized.toolCalls = msg.toolCalls.map((tc: ToolCallDisplay) => stripResolvedDiff({
        ...tc,
        result: tc.result ? truncateToolResult(tc.result) : tc.result,
      }))
    }

    // Persist contentBlocks for interleaved text + tool call rendering
    if (msg.contentBlocks?.length) {
      sanitized.contentBlocks = msg.contentBlocks
    }

    // Persist reasoning content if present
    if (msg.reasoningContent) {
      sanitized.reasoningContent = msg.reasoningContent
      if (msg.reasoningDurationMs) sanitized.reasoningDurationMs = msg.reasoningDurationMs
    }

    // Persist provider-native state for exact round-trip across sessions.
    // When present, rebuildConversationHistory uses this instead of
    // reconstructing from reasoningContent/contentBlocks.
    if (msg.providerState) {
      sanitized.providerState = msg.providerState
    }
    // Per-internal-turn native states — required for the per-turn history
    // rebuild (one assistant+tool_results pair per turn). Without persisting
    // this, a reloaded session falls back to the lossy last-turn-only path.
    if (msg.providerStates?.length) {
      sanitized.providerStates = msg.providerStates
    }

    // Don't persist isStreaming
    return sanitized
  }

  async updateIndex(projectPath: string, session: ChatSession): Promise<void> {
    try {
      const summaries = await this.listSessions(projectPath)
      const lastMsg = session.messages[session.messages.length - 1]

      const summary: SessionSummary = {
        id: session.id,
        name: session.name,
        description: session.description,
        projectPath: session.projectPath,
        messageCount: session.messages.length,
        lastMessage: lastMsg?.content?.slice(0, 100) ?? '',
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        // Rows de tarefas paralelas na sidebar/ProjectMenu leem o índice de
        // sumários (não carregam sessões inteiras) — a flag+estado têm de
        // viajar aqui para as tarefas reaparecerem após reload.
        ...(session.isParallelTask && { isParallelTask: true }),
        ...(session.parallelTaskStatus && { parallelTaskStatus: session.parallelTaskStatus }),
      }

      const filtered = summaries.filter(s => s.id !== session.id)
      filtered.unshift(summary)

      const indexPath = await this.getIndexFile(projectPath)
      await invoke('write_file', {
        path: indexPath,
        content: JSON.stringify(filtered, null, 2),
      })
    } catch (error) {
      logger.error('session', 'Failed to update session index:', error)
    }
  }

  private async removeFromIndex(projectPath: string, sessionId: string): Promise<void> {
    try {
      const summaries = await this.listSessions(projectPath)
      const filtered = summaries.filter(s => s.id !== sessionId)
      const indexPath = await this.getIndexFile(projectPath)
      await invoke('write_file', {
        path: indexPath,
        content: JSON.stringify(filtered, null, 2),
      })
    } catch (error) {
      logger.error('session', 'Failed to remove from session index:', error)
    }
  }

  private async enforceMaxSessions(projectPath: string): Promise<void> {
    const summaries = await this.listSessions(projectPath)
    if (summaries.length <= MAX_SESSIONS_PER_PROJECT) return

    // Chats de TAREFA nunca entram no prune — doutrina multi-agent ("uma
    // tarefa nunca desaparece; só o developer apaga", ARCHITECTURE.md). O cap
    // aplica-se só às sessões normais; as de tarefa saem via closeParallelTask.
    const prunable = summaries.filter(s => s.isParallelTask !== true)
    if (prunable.length <= MAX_SESSIONS_PER_PROJECT) return

    // Sort by updatedAt ascending (oldest first)
    const sorted = [...prunable].sort((a, b) => a.updatedAt - b.updatedAt)
    const toDelete = sorted.slice(0, sorted.length - MAX_SESSIONS_PER_PROJECT)

    for (const session of toDelete) {
      await this.deleteSession(projectPath, session.id)
    }
  }

  async renameSession(session: ChatSession, name: string): Promise<void> {
    session.name = name
    await this.enqueueIndexWrite(() => this.updateIndex(session.projectPath, session))
  }

  /**
   * Edita título/descrição de uma sessão que NÃO está carregada em memória:
   * roundtrip disco → mutação → save + índice. Para a sessão ATIVA usa-se o
   * caminho em memória (chatStore.updateSessionMeta) — carregar do disco aqui
   * clobberaria mensagens ainda não persistidas pelo debounce.
   */
  async updateSessionMetaOnDisk(
    projectPath: string,
    sessionId: string,
    meta: { name?: string; description?: string },
  ): Promise<boolean> {
    const session = await this.loadSession(projectPath, sessionId)
    if (!session) return false
    if (meta.name !== undefined) session.name = meta.name
    if (meta.description !== undefined) session.description = meta.description
    // saveSession já escreve ficheiro + índice DENTRO da cadeia — o
    // updateIndex extra que existia aqui era redundante e corria FORA dela.
    await this.saveSession(session)
    return true
  }

  async cleanupEmptySessions(projectPath: string): Promise<void> {
    // Read the active session FIRST so we never delete it, even if it has 0 messages.
    // Deleting the active session causes a PathNotFound error on the next startup
    // because active_session.json still points to it.
    const activeId = await this.getActiveSessionId(projectPath)
    const summaries = await this.listSessions(projectPath)
    for (const summary of summaries) {
      if (summary.messageCount === 0 && summary.id !== activeId) {
        await this.deleteSession(projectPath, summary.id)
      }
    }
  }
}

export const sessionService = SessionService.getInstance()
export default SessionService
