/**
 * Tool name constants — single source of truth.
 *
 * The system prompts, the /plan architect prompt, and the
 * mechanical access controls (planMode allowlist, env-file gate) all
 * reference tools by name. Hardcoding literals across ~70 sites means a
 * rename in toolExecutor silently desyncs the prompt: the model is told
 * to use a tool that no longer exists, and the desync is invisible until a
 * developer notices the agent calling a phantom name.
 *
 * Centralising the names here makes a rename one-line: change the literal
 * once, and every prompt + every allowlist update simultaneously. Mirrors
 * the `BASH_TOOL_NAME`, `FILE_READ_TOOL_NAME` pattern used in claude-vaz.
 *
 * Add a new tool: add the export here AND register the same string in
 * `toolExecutor.registerTools` via `this.tools.set(<NAME>, ...)`.
 */

// Read tools — concurrency-safe, allowed in /plan architect mode
export const READ_FILE = 'read_file'
export const READ_AROUND = 'read_around'
export const LIST_DIRECTORY = 'list_directory'
export const SEARCH_FILES = 'search_files'
export const GLOB = 'glob'
export const READ_SKILL = 'read_skill'
export const READ_LARGE_RESULT = 'read_large_result'
export const READ_DEV_SERVER_LOGS = 'read_dev_server_logs'
/** Code intelligence (Monaco TS worker): definitions/references/hover/symbols/diagnostics. */
export const LSP = 'lsp'

// Claude-like read aliases — exposed to the model, mapped internally to the
// TM Code tools above. Keep internal names stable for history/telemetry.
// ── Nomes de treino do Claude Code ───────────────────────────────────────────
//
// O modelo NÃO deixa de os emitir por lhe darmos outros no schema: numa sessão
// real medida em 2026-07-28, 14 de 16 chamadas usaram `Grep`/`Read`/`LS` em vez
// dos canónicos — com ZERO erros, porque estes quatro aliases já os absorviam.
// A conclusão não é "o modelo confunde-se"; é que o dialecto de treino é o
// comportamento base e o custo depende só de haver ou não tradução.
//
// Os quatro de baixo cobriam a leitura/pesquisa. Os de cima faltavam: caíam em
// `Unknown tool: Bash` — um turno inteiro perdido no tool mais usado do
// claude-vaz. Só recebem alias os que têm contrato COMPATÍVEL (ver
// normalizeToolInputForCanonical); os divergentes ganham um erro que ensina,
// em vez de uma tradução que mente sobre a forma dos argumentos.
export const BASH_ALIAS = 'Bash'
export const EDIT_ALIAS = 'Edit'
export const WRITE_ALIAS = 'Write'
export const TASK_ALIAS = 'Task'
export const WEB_FETCH_ALIAS = 'WebFetch'
export const WEB_SEARCH_ALIAS = 'WebSearch'

export const READ_ALIAS = 'Read'
export const GREP_ALIAS = 'Grep'
export const GLOB_ALIAS = 'Glob'
export const LS_ALIAS = 'LS'

// Write tools — produce diffs, require approval
export const WRITE_FILE = 'write_file'
export const CREATE_FILE = 'create_file'
export const EDIT_FILE = 'edit_file'
export const CREATE_DIRECTORY = 'create_directory'
export const DELETE_FILE = 'delete_file'
export const RENAME_FILE = 'rename_file'

// Execution / dev server
export const EXECUTE_COMMAND = 'execute_command'
export const EXECUTE_COMMAND_BACKGROUND = 'execute_command_background'
export const CHECK_BACKGROUND_COMMANDS = 'check_background_commands'
export const AGENT_SHELL_START = 'agent_shell_start'
export const AGENT_SHELL_WRITE = 'agent_shell_write'
export const AGENT_SHELL_READ = 'agent_shell_read'
export const AGENT_SHELL_STOP = 'agent_shell_stop'
export const START_DEV_SERVER = 'start_dev_server'
export const STOP_DEV_SERVER = 'stop_dev_server'

// Web / research
export const WEB_SEARCH = 'web_search'
export const WEB_FETCH = 'web_fetch'
/** Navigate + screenshot a URL and return a vision design handoff. */
export const CAPTURE_URL_DESIGN = 'capture_url_design'
export const SEND_AGENT_MESSAGE = 'send_agent_message'
export const GET_PROJECT_STATE_DIR = 'get_project_state_dir'

// Sub-agent delegation (v0.7.0 — replaces research, verify, spawn_background_agent)
// A tool `verify` legacy foi finalmente REMOVIDA (2026-07-30): coexistia com o
// sub-agente Verify — dois prompts de sistema a divergir, tetos de 200 vs 100
// turnos, e só o sub-agente tinha UI, store, wall-clock, stale detection e
// marcação de resultado parcial. O caminho único é `delegate('Verify', …)`.
export const DELEGATE = 'delegate'
export const COLLECT_RESULTS = 'collect_results'

// Worktree session (claude-vaz parity) — ONLY when the user explicitly asks
export const ENTER_WORKTREE = 'enter_worktree'
export const EXIT_WORKTREE = 'exit_worktree'

// Internal task tracking
export const UPDATE_TASKS = 'update_tasks'

// User interaction
// (provision_auth/database/files/deploy were removed in the dev-only-IDE
// pivot, 2026-07 — the managed layer lives in TM Code Web.)
export const REQUEST_CREDENTIALS = 'request_credentials'
export const ASK_USER_QUESTION = 'ask_user_question'

// Verify sub-agent — removed in v0.7.0, replaced by task(subagent_type='Verify')

// Persistent memory (memdir) — see services/agent/memdir.ts
export const SAVE_MEMORY = 'save_memory'
export const FORGET_MEMORY = 'forget_memory'
export const READ_MEMORY = 'read_memory'
export const DISTILL_MEMORY = 'distill_memory'
export const UPDATE_SESSION_MEMORY = 'update_session_memory'
export const READ_SESSION_MEMORY = 'read_session_memory'

/**
 * Every tool name registered by ToolExecutor. Walked by
 * `scripts/verify-skills.ts` to assert that every tool-name reference
 * inside a SKILL.md still points at a real tool — a removed or renamed
 * tool that's still mentioned in markdown becomes a CI failure rather
 * than a silent prompt regression.
 *
 * Keep in sync with `ToolExecutor.tools.set(...)` registrations: the
 * verifier walks both surfaces and reports drift in either direction.
 */
export const TOOL_NAMES = [
  READ_FILE, READ_AROUND, LIST_DIRECTORY, SEARCH_FILES, GLOB,
  READ_ALIAS, GREP_ALIAS, GLOB_ALIAS, LS_ALIAS,
  READ_SKILL, READ_LARGE_RESULT, READ_DEV_SERVER_LOGS, LSP,
  WRITE_FILE, CREATE_FILE, EDIT_FILE, CREATE_DIRECTORY, DELETE_FILE, RENAME_FILE,
  EXECUTE_COMMAND, EXECUTE_COMMAND_BACKGROUND, CHECK_BACKGROUND_COMMANDS,
  AGENT_SHELL_START, AGENT_SHELL_WRITE, AGENT_SHELL_READ, AGENT_SHELL_STOP,
  START_DEV_SERVER, STOP_DEV_SERVER,
  WEB_SEARCH, WEB_FETCH, CAPTURE_URL_DESIGN,
  DELEGATE, COLLECT_RESULTS, SEND_AGENT_MESSAGE,
  ENTER_WORKTREE, EXIT_WORKTREE,
  UPDATE_TASKS, GET_PROJECT_STATE_DIR,
  REQUEST_CREDENTIALS, ASK_USER_QUESTION,
  SAVE_MEMORY, FORGET_MEMORY, READ_MEMORY, DISTILL_MEMORY, UPDATE_SESSION_MEMORY, READ_SESSION_MEMORY,
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

const TOOL_NAMES_SET: ReadonlySet<string> = new Set(TOOL_NAMES)

/** True iff `name` is a registered tool. Used by the SKILL verifier
 *  (`scripts/verify-skills.ts`) to detect stale tool-name references. */
export function isKnownToolName(name: string): name is ToolName {
  return TOOL_NAMES_SET.has(name)
}

/**
 * Nome CANÓNICO (chave do registo, gates, grants) → nome ANUNCIADO ao modelo.
 *
 * A renomeação para o dialecto de treino acontece AQUI e em mais lado nenhum.
 *
 * PORQUÊ ASSIM, e não renomeando as chaves: os nomes canónicos são a chave de
 * ~55 literais internos — SAFE_TOOLS, DESTRUCTIVE_TOOLS, FILE_SCOPE_TOOLS,
 * SHELL_COMMAND_TOOLS, o selo do .env, os tectos por tool — e, o que é pior,
 * de `approvedTools` no permissions.json. Mover as chaves obrigava a migrar
 * disco do utilizador para não lhe invalidar em silêncio tudo o que já
 * autorizou. Mover só a ETIQUETA dá ao modelo exactamente o mesmo resultado
 * (ele só vê `Read`) sem tocar em nada disso: o caminho de volta já existe e
 * está testado — `canonicalToolName` traduz o que ele envia.
 *
 * Só entram aqui os contratos COMPATÍVEIS campo a campo. `update_tasks` fica
 * de fora de propósito: o `TodoWrite` do claude-vaz tem outra forma, e
 * anunciar o nome dele obrigaria a aceitar `todos: [...]` — está em
 * DIVERGENT_TRAINED_TOOLS, que ensina a forma certa.
 */
export const ADVERTISED_TOOL_NAMES: Readonly<Record<string, string>> = {
  [READ_FILE]: READ_ALIAS,
  [SEARCH_FILES]: GREP_ALIAS,
  [GLOB]: GLOB_ALIAS,
  [LIST_DIRECTORY]: LS_ALIAS,
  [EXECUTE_COMMAND]: BASH_ALIAS,
  [EDIT_FILE]: EDIT_ALIAS,
  [WRITE_FILE]: WRITE_ALIAS,
  [DELEGATE]: TASK_ALIAS,
  [WEB_FETCH]: WEB_FETCH_ALIAS,
  [WEB_SEARCH]: WEB_SEARCH_ALIAS,
}

/** Como o modelo vê esta tool. Identidade quando não há nome de treino. */
export function advertisedToolName(canonical: string): string {
  return ADVERTISED_TOOL_NAMES[canonical] ?? canonical
}

/**
 * Encaminhamento que depende dos ARGUMENTOS, não só do nome.
 *
 * Adoptar um nome de treino adopta também as EXPECTATIVAS desse nome. O `Bash`
 * do claude-vaz tem `run_in_background`; o nosso equivalente é uma tool
 * separada. Sem esta regra, o parâmetro era ignorado em silêncio: o comando
 * corria a bloquear, o modelo fechava o turno convencido de que tinha ficado
 * em background e esperava um auto-wake que nunca chegava.
 *
 * Repare-se que isto foi CRIADO pela renomeação — antes, `Bash` dava
 * "Unknown tool", que é uma falha honesta. Trocar um erro visível por uma
 * mentira silenciosa teria sido um mau negócio.
 */
/**
 * Famílias `--type` do ripgrep → globs. Só as que o modelo pede na prática;
 * um `type` desconhecido não filtra nada (melhor devolver a mais do que
 * inventar um filtro que engole resultados em silêncio).
 */
const RG_TYPE_GLOBS: Readonly<Record<string, string[]>> = {
  ts: ['*.ts', '*.tsx'],
  tsx: ['*.tsx'],
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  jsx: ['*.jsx'],
  rust: ['*.rs'],
  py: ['*.py'],
  python: ['*.py'],
  go: ['*.go'],
  java: ['*.java'],
  json: ['*.json'],
  yaml: ['*.yaml', '*.yml'],
  toml: ['*.toml'],
  md: ['*.md', '*.mdx'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  html: ['*.html', '*.htm'],
  sh: ['*.sh', '*.bash', '*.zsh'],
  sql: ['*.sql'],
}

export function routeTrainedToolCall(
  requestedName: string,
  canonical: string,
  input: Record<string, unknown>,
): string {
  if (requestedName === BASH_ALIAS && input.run_in_background === true) {
    return EXECUTE_COMMAND_BACKGROUND
  }
  return canonical
}

/**
 * Nomes ANTIGOS → nomes actuais, para dados JÁ GRAVADOS.
 *
 * Separado dos aliases de propósito. Um alias existe porque o MODELO escreve
 * outro nome; isto existe porque o DISCO tem outro nome. As duas tabelas
 * mudam por razões diferentes e em momentos diferentes — fundi-las faria com
 * que apagar um alias corrompesse grants antigos.
 *
 * Onde é obrigatório passar por aqui:
 *   - `permissions.json` → `approvedTools` (o utilizador clicou "permitir
 *     sempre" com o nome antigo; sem tradução volta a ser interrogado por
 *     tudo — a regressão mais cara desta migração, e silenciosa);
 *   - transcripts persistidos, ao reconstruir histórico e ao renderizar.
 *
 * Vazio enquanto os nomes canónicos não mudarem: a função existe desde já para
 * os call sites serem escritos uma vez só.
 */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {}

/** Traduz um nome vindo de dados gravados. Identidade quando não há entrada. */
export function normalizePersistedToolName(name: string): string {
  return LEGACY_TOOL_NAMES[name] ?? name
}

export function canonicalToolName(name: string): string {
  switch (name) {
    case READ_ALIAS: return READ_FILE
    case GREP_ALIAS: return SEARCH_FILES
    case GLOB_ALIAS: return GLOB
    case LS_ALIAS: return LIST_DIRECTORY
    // Contratos compatíveis — Edit/Write são idênticos aos nossos campo a
    // campo (file_path/old_string/new_string/replace_all e file_path/content),
    // WebFetch/WebSearch partilham `url`/`query`, e o `delegate` já aceita
    // `subagent_type` porque foi desenhado para receber o dialecto do Task.
    case BASH_ALIAS: return EXECUTE_COMMAND
    case EDIT_ALIAS: return EDIT_FILE
    case WRITE_ALIAS: return WRITE_FILE
    case TASK_ALIAS: return DELEGATE
    case WEB_FETCH_ALIAS: return WEB_FETCH
    case WEB_SEARCH_ALIAS: return WEB_SEARCH
    default: return name
  }
}

/**
 * Nomes de treino cujo CONTRATO diverge do nosso ao ponto de uma tradução
 * automática ser pior do que um erro: os argumentos não se mapeiam campo a
 * campo e aceitá-los produziria uma chamada silenciosamente errada.
 *
 * Devolvem uma mensagem que NOMEIA o substituto e a forma — o que transforma
 * um beco sem saída ("Unknown tool") numa recuperação de um turno.
 */
export const DIVERGENT_TRAINED_TOOLS: Readonly<Record<string, string>> = {
  TodoWrite: `${UPDATE_TASKS} — same purpose, different shape: send { tasks: [{ id, description, status, evidence }] } and merge by id (no need to resend the whole list).`,
  MultiEdit: `${EDIT_FILE} — apply the edits one call at a time, or pass replace_all: true when every occurrence of the same string changes.`,
  NotebookEdit: `${EDIT_FILE}/${WRITE_FILE} — there is no notebook-aware tool here; edit the .ipynb as a text file.`,
  BashOutput: `${CHECK_BACKGROUND_COMMANDS} — pass the id returned by ${EXECUTE_COMMAND_BACKGROUND}.`,
  KillBash: `${CHECK_BACKGROUND_COMMANDS} to inspect; background commands are cancelled from the chat UI, not by the agent.`,
}

export function normalizeToolInputForCanonical(
  requestedToolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (requestedToolName) {
    case READ_ALIAS:
      return {
        ...input,
        file_path: input.file_path ?? input.path,
      }
    case GREP_ALIAS: {
      // `type: "js"` é a forma abreviada do ripgrep para famílias de ficheiros.
      // Sem tradução, o modelo pedia `type` e recebia a árvore INTEIRA — o
      // filtro que ele julgava ter aplicado não existia.
      const typeGlobs = RG_TYPE_GLOBS[String(input.type ?? '').toLowerCase()]
      const glob = input.glob
      const includePatterns = Array.isArray(input.includePatterns)
        ? input.includePatterns
        : typeof glob === 'string' && glob.trim()
          ? [glob]
          : typeGlobs
      return {
        ...input,
        query: input.query ?? input.pattern,
        directory: input.directory ?? input.path ?? '.',
        ...(includePatterns ? { includePatterns } : {}),
        // Paridade com o Grep do Claude Code: o pattern é SEMPRE regex
        // (ripgrep). Com o default antigo (literal), `a|b` procurava a
        // string com os pipes e devolvia um "No matches found" FALSO — o
        // modelo (treinado no Claude Code) usa alternação sem hesitar e
        // era enganado em silêncio. useRegex explícito continua a mandar.
        useRegex: input.useRegex ?? true,
        // Dialecto claude-vaz: output_mode/head_limit (snake) → os nossos.
        ...(input.output_mode !== undefined && input.outputMode === undefined
          ? { outputMode: input.output_mode } : {}),
        ...(input.head_limit !== undefined && input.maxResults === undefined
          ? { maxResults: input.head_limit } : {}),
        // Flags de contexto do grep (-A depois, -B antes, -C ambos). O nosso
        // contextLines é simétrico, portanto fica o MAIOR dos pedidos — dar
        // menos contexto do que o pedido faria o modelo repetir a busca.
        ...(input.contextLines === undefined
          ? (() => {
              const n = Math.max(
                typeof input['-A'] === 'number' ? input['-A'] : 0,
                typeof input['-B'] === 'number' ? input['-B'] : 0,
                typeof input['-C'] === 'number' ? input['-C'] : 0,
              )
              return n > 0 ? { contextLines: n } : {}
            })()
          : {}),
        // `-i` (case-insensitive) é o nosso DEFAULT; só o caso explícito
        // sensível precisa de ser transmitido.
        ...(input['-i'] === true ? { caseSensitive: false } : {}),
      }
    }
    case BASH_ALIAS:
      return {
        ...input,
        // O `timeout` do Bash é em MILISSEGUNDOS; o nosso timeout_secs é em
        // segundos. Copiar o número cru dava 120000s de teto.
        ...(typeof input.timeout === 'number' && input.timeout_secs === undefined
          ? { timeout_secs: Math.max(1, Math.round(input.timeout / 1000)) }
          : {}),
      }
    case EDIT_ALIAS:
    case WRITE_ALIAS:
      // Campo a campo idênticos — nada a traduzir.
      return input
    case TASK_ALIAS:
      return {
        ...input,
        // `delegate` aceita subagent_type/description/prompt tal como o Task.
        subagent_type: input.subagent_type ?? input.member ?? input.team_member,
      }
    case WEB_FETCH_ALIAS:
      // O `prompt` do WebFetch (extracção server-side) não existe aqui: o
      // conteúdo volta inteiro e é o MODELO que o lê. Passa como está.
      return input
    case WEB_SEARCH_ALIAS:
      return input
    case GLOB_ALIAS:
      return {
        ...input,
        directory: input.directory ?? input.path,
      }
    case LS_ALIAS:
      return {
        ...input,
        file_path: input.file_path ?? input.path ?? input.directory ?? '.',
      }
    default:
      return input
  }
}
