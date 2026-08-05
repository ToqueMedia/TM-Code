// === Chat Types ===

export type AttachmentType = 'image' | 'file' | 'folder'

export interface Attachment {
  id: string
  type: AttachmentType
  name: string
  path: string
  mimeType?: string
  sizeBytes?: number
  /** Base64 data URI — only for images (populated at attach-time for thumbnail preview) */
  base64?: string
  /**
   * Número do chip `[Image #N]` (paridade claude-vaz, history.ts:59) —
   * atribuído quando uma imagem é colada/anexada no prompt local. O mesmo texto
   * é inserido no input; no submit, a imagem só é enviada se o placeholder
   * ainda estiver no texto (apagar o texto remove a imagem — claude-vaz
   * handlePromptSubmit.ts:178). Estável após atribuição: remoções de outros
   * anexos não renumeram.
   */
  pasteMarker?: number
}

/** Ordered content block — tracks interleaving of reasoning, text and tool
 *  calls in assistant messages. Used by the chat bubble for inline rendering.
 *  Reasoning is its own block type (not the message-level reasoningContent
 *  field) so multiple thinking passes within one assistant message render in
 *  the correct positions: e.g. `[reasoning, tool_call, tool_call, reasoning]`
 *  rather than collapsing every thinking pass into a single block at the top. */
export type ContentBlock =
  | {
      type: 'text'
      text: string
      /**
       * Visible in the transcript UI, but excluded when rebuilding model
       * history from legacy UI state. Used for app-generated progress text
       * that is not provider output.
       */
      uiOnly?: boolean
    }
  | { type: 'tool_call'; toolCallId: string }
  | {
      type: 'reasoning'
      text: string
      /** Set when the reasoning block ends (subsequent tool/text/reasoning arrives). */
      durationMs?: number
      /** Internal: epoch ms when the block was first created. Used to derive durationMs. */
      startedAt?: number
      /** Per-block expansion state. When undefined, falls back to the
       *  message-level `isReasoningVisible` flag (legacy behaviour).
       *  When defined, this overrides the message flag — set by
       *  `toggleReasoningBlock` so each reasoning block can be
       *  expanded independently of its siblings. */
      isVisible?: boolean
    }

/** Ordered prompt block — tracks the interleaving of user text and
 *  attachments in a SINGLE user message (or coalesced batch). The
 *  message queue carries this as `value`; the chat bubble derives
 *  `(text, attachments)` from it for display, and the agent boundary
 *  derives either an interleaved text prompt or an OpenAI content
 *  parts array depending on model capability. Defined here so both
 *  the queue layer and the chat store can produce/consume it without
 *  cross-imports. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: Attachment }

/** Message format for OpenAI-compatible conversation history */
/**
 * OpenAI / OpenAI-compatible content parts for multimodal user messages.
 *
 * Mirrors the shape consumed by vision-capable providers (Qwen3 Plus,
 * Kimi K2.5, Step3.5, etc.) via the backend proxy. Used wherever a
 * message's content can carry images interleaved with text — chiefly
 * the queue → agent boundary and the conversationHistory shape so
 * follow-up turns continue to see images from earlier turns.
 *
 * Defined in types/chat.ts (rather than agentService.ts) so the
 * stores layer can construct it without importing from a service.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

/**
 * OpenAI Chat Completion tool call — matches the format returned by
 * OpenAI-compatible providers.
 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Unified content block format for conversation history.
 * Supports both text-only and structured content (tool calls, reasoning, images).
 * This replaces the previous AnthropicContentBlock format.
 */
export type ContentBlockAPI =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string; thoughtSignature?: string }
  | { type: 'tool_result'; toolCallId: string; content: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

/** @deprecated Use ContentBlockAPI directly. Kept as alias for backward compatibility. */
export type AnthropicContentBlock = ContentBlockAPI

/**
 * Opaque provider-native state captured at turn completion.
 * Preserved for exact round-trip in subsequent turns — never
 * transformed into text or stripped of unknown fields.
 */
export interface ProviderState {
  /** Provider identifier (e.g. "dashscope", "mimo", "gemini") */
  provider: string
  /** Protocol family detected at request time */
  protocol: 'openai-chat' | 'anthropic' | 'openai-responses' | 'custom'
  /**
   * OpenAI Chat-compatible: complete assistant message as returned by the
   * provider. Includes role, content, reasoning_content, reasoning_details,
   * tool_calls, and any unknown fields. Deep copy — safe to serialize.
   */
  nativeAssistantMessage?: Record<string, unknown>
  /**
   * Anthropic: native content blocks including thinking, signature,
   * redacted_thinking, text, tool_use with IDs and unknown fields.
   * Reserved for future Anthropic protocol support.
   */
  nativeContentBlocks?: unknown[]
  /**
   * OpenAI Responses API: native output items including reasoning,
   * encrypted_content, function_call/output linkage, IDs.
   * Reserved for future Responses API support.
   */
  nativeResponseOutputItems?: unknown[]
  /** Epoch ms when captured */
  capturedAt?: number
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  /** String for text-only messages, ContentBlockAPI[] for structured messages
   *  (tool_call blocks, tool_result blocks, thinking blocks, image parts). */
  content: string | ContentBlockAPI[] | null
  /**
   * Provider-native fields for exact round-trip (assistant messages only).
   * Spread into the API request body by query.ts instead of reconstructing
   * from reasoningContent/contentBlocks. Undefined on legacy sessions.
   */
  _native?: Record<string, unknown>
}

export interface ToolCallDisplay {
  id: string
  toolName: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  status: 'running' | 'completed' | 'failed'
  /**
   * True once the tool actually BEGAN executing (set on onToolCallStart, which
   * fires right before toolExecutor.execute() in the serial tool loop). Tool
   * calls are added with status:'running' when they stream in, but execution
   * starts one at a time and can pause on user gates such as diff approval.
   * Without this flag, waiting calls would render active "editing" spinners,
   * which reads as parallel writes. `started !== true` while status==='running'
   * means "queued, not yet started" → rendered as a calm queued row instead of
   * the active spinner.
   */
  started?: boolean
  timestamp: number
  // Diff data (populated for write_file and edit_file)
  diffOldContent?: string
  diffNewContent?: string
  isNewFile?: boolean
  diffStatus?: 'pending' | 'approved' | 'denied'
  diffResultId?: string
  /** Live progress text shown while tool is running (e.g., sub-agent status). */
  progressText?: string
  /** Accumulated log output from streaming commands (build, test, install, scripts).
   *  Rendered as a scrollable terminal-style log viewer. */
  commandLogs?: string[]
  /** Id of the parent tool call that spawned this one (research / verify / bg agent).
   *  When set, the UI renders this tool call with a nested indent + marker so the
   *  user sees the full sub-agent activity, not just a progress string. */
  spawnedBy?: string
  /** Permission decision recorded when the tool ran. Lets the session export
   *  distinguish auto-approved tools, user-approved tools, and denied tools.
   *  Without this, forensic review mistakes user-approved destructive commands
   *  for skill violations (the export only shows the final tool result, not
   *  the dialog the user actually saw). */
  permission?: {
    approved: boolean
    prompted: boolean
    source: 'safe_tool' | 'has_own_approval' | 'approved_scope' | 'user'
    promptKind?: import('../stores/permissionStore').PromptReason
    denyReason?: string
  }
}

export interface CredentialFieldDescriptor {
  id: string
  label: string
  type: 'text' | 'password'
  required: boolean
  helperText?: string
}

export interface ChatMessageCard {
  type: 'plan_approval' | 'todo_list' | 'credential_request' | 'permission_request' | 'ask_user_question'
  projectPath: string
  status: 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'submitted' | 'cancelled' | 'expired'
  /** plan_approval only: concrete plan file path when not the default project PLAN.md */
  planPath?: string
  /** plan_approval only: display/file basename for the concrete plan artefact */
  planFileName?: string
  /** credential_request only: identifies the pending entry in credentialRequestStore */
  requestId?: string
  /** credential_request only: service name (e.g. "OpenAI", "Stripe") shown in the form header */
  serviceName?: string
  /** credential_request only: fields to collect */
  fields?: CredentialFieldDescriptor[]
  /** credential_request only: keys actually submitted (no values) — populated after submit */
  submittedKeys?: string[]
  /** ask_user_question only: the questions to display */
  questions?: import('../stores/askUserQuestionStore').Question[]
  /** ask_user_question only: answers submitted by the user */
  answers?: Record<string, string | string[]>
  /** permission_request only: identifies the pending entry in permissionStore.
   *  When the user clicks Allow/Deny after a reload, the in-memory entry is
   *  gone — we use this id to detect the "stale card" path and instruct the
   *  user to resume via "Continue" instead of silently no-op'ing. */
  permissionId?: string
  /** permission_request only: tool whose execution is being gated. */
  toolName?: string
  /** permission_request only: snapshot of the tool args, truncated for display. */
  argsSummary?: string
  /** permission_request only: extra friction signal (sensitive file, dangerous
   *  command, browser action). Drives the UI emphasis ("requires approval"). */
  promptReason?: 'sensitive_file' | 'dangerous_command' | 'browser_action' | null
}

export type SystemMessageLevel = 'info' | 'success' | 'error' | 'warn'

/**
 * Discriminator for special system messages whose rendering differs from the
 * default bullet+text layout (compact boundary, future kinds).
 *
 * - `compact_boundary`: marks the point where the agent compressed the
 *   conversation. Renders as a claude-vaz-style horizontal rule with the
 *   "✻ Conversa comprimida" label, and the ChatView hides every message
 *   above the latest boundary (pre-compression history stays in storage
 *   but is folded away from the transcript — same as claude-vaz).
 */
export type SystemMessageKind = 'compact_boundary'

/** Metadata stored on compact_boundary messages for richer rendering. */
export interface CompactMetadata {
  trigger: 'auto' | 'manual' | 'reactive'
  beforeTokens: number
  messagesSummarized?: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  /** For role === 'system': semantic level used for colour-coding in the terminal UI */
  level?: SystemMessageLevel
  /** For role === 'system': discriminator for special rendering (e.g., compact boundary). */
  kind?: SystemMessageKind
  /** Optional pre-compression token count, set on compact_boundary messages. */
  compactBeforeTokens?: number
  /** Richer metadata for compact_boundary messages (trigger, token count, messages summarized). */
  compactMetadata?: CompactMetadata
  /**
   * The model-ready summary of the compacted-away turns, carried ON the
   * compact_boundary marker. `rebuildConversationHistory` re-emits it into the
   * outgoing prompt (as a user message) so the model RETAINS the prior context
   * after auto-compaction. Without it the in-loop summary was discarded and the
   * model lost everything before the boundary. UI-only system messages stay
   * skipped; only a boundary WITH this field re-emits.
   */
  compactSummary?: string
  /**
   * Estado de TRABALHO recuperado na compactação — conteúdo dos ficheiros
   * recentes, texto das skills invocadas, log de operações (ver
   * contextManager.buildPostCompactRecoveryBlock).
   *
   * Campo separado de `compactSummary` porque são duas coisas diferentes com
   * dois destinos: o sumário é NARRATIVA (legível, mostrado ao developer no
   * cartão expansível da fronteira), a recuperação é MATERIAL (despejo de
   * ficheiros que ninguém quer ver na UI). Ambos são re-emitidos para o modelo
   * por rebuildConversationHistory, o sumário primeiro.
   */
  compactRecovery?: string
  /** Terminal-mode local command result, rendered like a shell command block. */
  terminalCommand?: {
    command: string
    output?: string
    exitCode: number
  }
  content: string
  timestamp: number
  codeBlocks?: CodeBlock[]
  toolCalls?: ToolCallDisplay[]
  /** Ordered sequence of text and tool-call blocks for interleaved rendering */
  contentBlocks?: ContentBlock[]
  isStreaming?: boolean
  // Reasoning (collapsible)
  reasoningContent?: string
  isReasoningVisible?: boolean
  /** Epoch ms when first reasoning delta arrived */
  reasoningStartedAt?: number
  /** Duration in ms of the reasoning phase */
  reasoningDurationMs?: number
  /**
   * Did the developer ask for reasoning on the request that produced this
   * assistant message?
   *
   * - `true`  → user toggled thinking ON (non-BYOK plans) OR fired a
   *             reasoning command (/plan, /debug, /review, /te2e). The
   *             reasoning blocks render normally.
   * - `false` → BYOK in play OR toggle OFF AND no reasoning command. Even
   *             if the model produces reasoning (BYOK reasoning models often
   *             always think regardless of `reasoning_effort: 'minimal'`),
   *             the IDE suppresses the blocks in the UI — the developer
   *             asked for code, not for a chain-of-thought dump.
   * - `undefined` → legacy session from before the flag existed. Render as
   *             before (no behavioural change for old data).
   */
  thinkingRequested?: boolean
  /**
   * Effort EFETIVO deste turno (managed path). Valor nativo enviado no header
   * `X-TM-Reasoning-Effort` (ex.: `high`, `max`, `none`). Persistido com a
   * mensagem para o user ver no bubble o que cada pedido usou — a preferência
   * do seletor é global, mas o histórico da sessão carimba o valor por turno.
   * Undefined = mensagens legadas (antes desta captura).
   */
  reasoningEffort?: string
  /**
   * `true` se o header foi de facto anexado ao pedido (modelo mapeado +
   * known). `false` se o seletor mostrou um effort mas o header NÃO saiu
   * (modelo desconhecido / unmapped → provider default). Ajuda a diagnosticar
   * "mudei o seletor e não mudou nada".
   */
  reasoningEffortSent?: boolean
  /**
   * Opaque provider-native state captured at turn completion. When present,
   * rebuildConversationHistory uses this as the source of truth for the
   * assistant message in subsequent turns instead of reconstructing from
   * reasoningContent/contentBlocks. Undefined on legacy sessions — the
   * legacy reasoningContent fallback path is used instead.
   */
  providerState?: ProviderState
  /**
   * One ProviderState per INTERNAL turn of the agent loop, in order. A single
   * user request can produce N assistant turns (text→tools→text→tools→final),
   * all collapsed into one ChatMessage bubble; `providerState` alone keeps
   * only the LAST turn, so rebuilding history from it advertises only the
   * last turn's tool_calls while toolCalls[] holds every turn's calls — the
   * mismatch silently dropped intermediate tool results and reasoning from
   * the model's context (context pollution audit, 2026-06-12). When present,
   * rebuildConversationHistory emits one assistant+tool_results pair per
   * entry. `providerState` is kept as the last entry for back-compat with
   * sessions persisted before this field existed.
   */
  providerStates?: ProviderState[]
  /** Inline card (plan approval, todo list) */
  card?: ChatMessageCard
  /** Attachments included with this message (metadata only — content is resolved into message.content at send-time) */
  attachments?: Attachment[]
  /**
   * Synthetic tool-call context resolved from @-mentions (and the
   * external-modification sweep) on this USER message — the
   * `<system-reminder>` blocks appended after the prompt at send-time.
   * Persisted so rebuildConversationHistory re-emits it on follow-up turns;
   * claude-vaz keeps attachment messages in the transcript and without this
   * field the mentioned-file content would evaporate from the model's view
   * after the first turn. Never rendered in the chat bubble.
   */
  mentionContext?: string
  /** Absolute paths of the file-content snapshots frozen in mentionContext.
   *  rebuildConversationHistory voids the snapshot for any path a later tool
   *  call superseded, so the model never sees a stale @-mention body
   *  contradicting a fresh tool result (context pollution audit, 2026-06-12). */
  mentionedPaths?: string[]
  /**
   * Original interleaved order of text and attachments at enqueue/send
   * time. When present, this is the canonical source for reconstructing
   * the message: rebuildConversationHistory walks promptBlocks in order
   * to produce content parts that preserve the user's original sequence
   * (vs the lossy text-then-attachments fallback derived from
   * `content` + `attachments`). Stripped of base64 at disk persistence;
   * in-memory image blocks carry base64 for follow-up turn fidelity.
   */
  promptBlocks?: PromptBlock[]
  /** Per-turn footer stats — captured at finalize time on assistant
   *  messages so the UI can show "how long did this turn take, and how
   *  many tokens did it consume" below the message. */
  turnDurationMs?: number
  turnInputTokens?: number
  turnOutputTokens?: number
  /**
   * `true` when the user aborted the run that was producing this assistant
   * message (Stop / ESC). rebuildConversationHistory emits a
   * "[Request interrupted by user]" user message right after it so the model
   * KNOWS the previous turn ended by interruption, not by its own choice —
   * without this it reads its truncated reply as a completed answer
   * (cli-vaz parity: utils/messages INTERRUPT_MESSAGE).
   */
  wasInterrupted?: boolean
  /**
   * Ephemeral system messages: appear momentarily in the transcript, scroll
   * up as new messages arrive, and auto-remove after a short timeout. Used
   * for transient status (permission grants, "session saved", dev-server
   * lifecycle) where the event itself is interesting but not worth keeping
   * in the conversation history. Not persisted to disk (sanitizer drops them).
   */
  ephemeral?: boolean
  /** Sub-agent run IDs spawned by task() tool calls in this message. SubAgentCard renders for each. */
  subAgentRunIds?: string[]
}

export interface CodeBlock {
  id: string
  language: string
  code: string
  filePath?: string
  status: 'pending' | 'applied' | 'rejected'
}

export interface ChatSession {
  id: string
  /**
   * Título da tarefa/sessão. Fixado UMA vez com o primeiro texto da primeira
   * mensagem do user (chatStore.addMessage) e nunca reescrito automaticamente
   * — só o próprio user o muda (updateSessionMeta). É este o título que a
   * árvore paralela da sidebar e o dropdown de sessões mostram.
   */
  name?: string
  /**
   * Descrição opcional escrita pelo USER (updateSessionMeta) — nunca gerada
   * automaticamente. Aparece como tooltip/linha secundária nas superfícies
   * de tarefas e viaja para outras janelas via agent-status.json.
   */
  description?: string
  projectPath: string
  messages: ChatMessage[]
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  createdAt: number
  updatedAt: number
  /**
   * Sessão criada como transcript de uma tarefa paralela ("Nova tarefa").
   * Persistido: as rows de tarefas na sidebar/ProjectMenu derivam das sessões
   * com esta flag, por isso sobrevivem a reload — o user consulta o chat da
   * tarefa a qualquer momento.
   */
  isParallelTask?: boolean
  /** Último estado conhecido da tarefa (carimbado pelo runner no fim). */
  parallelTaskStatus?: ParallelTaskSessionStatus
  /** BYOK snapshot taken at session creation. Frozen for the lifetime of
   *  the session — switching the global active provider in Settings does
   *  NOT migrate active sessions. Null when the session was created
   *  without BYOK (TMS-routed). */
  byokSnapshot?: ByokSessionSnapshot | null
  /** Last known input-token count for the next turn, captured from the
   *  most recent assistant response's usage header. Persisted with the
   *  session so the context-window indicator restores correct pressure
   *  when the user reopens the session in a future app run.
   *  Missing on legacy sessions (pre-v0.6.2) — the loader falls back to
   *  a char-based estimate from the message history. */
  lastPromptTokens?: number
  lastResponseTokens?: number
  /** Maior prompt já visto nesta sessão. Existe SÓ como informação secundária
   *  no tooltip do pill — nunca como o valor que desenha a barra.
   *
   *  HISTÓRIA (2026-08-05): `lastPromptTokens` era ele próprio um pico de
   *  sessão (`Math.max`), o que congelava o indicador: um turno de 500K punha
   *  o pill em 49% e nenhum turno seguinte, por mais pequeno, o movia — só uma
   *  compactação completa. O utilizador via a percentagem parada e não
   *  conseguia distinguir "o contexto estagnou" de "o indicador avariou". Pior,
   *  divergia do runtime: o autoCompact decide pela ocupação REAL do turno
   *  anterior, que sobe e desce. Agora `lastPromptTokens` guarda essa mesma
   *  ocupação real e o pico mudou-se para aqui. */
  peakPromptTokens?: number
  /** Session-scoped memory notes maintained by the agent via
   *  `update_session_memory`. Survives context compaction but resets on
   *  new session creation. The agent uses these to track in-progress work,
   *  decisions made, and pending next steps. */
  sessionMemory?: string
  /**
   * Incomplete /plan run that should be resumed in architect mode on the next
   * user message. This prevents a plain "continue" after an interrupted plan
   * from falling through to the default coding agent and implementing files.
   */
  planResumePending?: PlanResumePending | null
  /** Per-request usage log — one entry per provider call. */
  requestUsageLog?: RequestUsageEntry[]
}

export interface PlanResumePending {
  projectPath: string
  originalArgs: string
  planPath: string
  planFileName: string
  updatedAt: number
}

/** Per-session frozen reference to the BYOK selection at creation time.
 *  Stored on disk alongside the session so reloads use the same provider/
 *  model that the conversation started with. */
export interface ByokSessionSnapshot {
  providerId: string
  modelId: string
  /** Resolved baseURL (override or provider default) at snapshot time. */
  baseURL: string
  /** Whether the provider is `custom`. Drives the X-BYOK-Capabilities
   *  header inclusion on each request. */
  custom: boolean
  /** Whether the provider is `local` (Ollama, LM Studio). Critical for the
   *  agentService routing decision: local providers MUST be called direct
   *  from the IDE — the worker proxy refuses local routes (proxy.ts:1111).
   *  Without this flag, a session re-hydrated after a restart would lose
   *  the local-routing decision and try the worker. Optional for backward
   *  compatibility with sessions persisted before this field existed —
   *  agentService re-derives via byokStore lookup when absent. */
  local?: boolean
  /** For custom providers: declared capabilities frozen at snapshot. */
  capabilities?: {
    images: boolean
    audio: boolean
    video: boolean
    tools: boolean
  }
  /** Whether the BYOK model supports a thinking/reasoning toggle. When
   *  true, the request body's thinking parameter is built using
   *  `thinkingShape`, NOT the plan profile shape. Optional for backwards
   *  compatibility with older persisted sessions — when absent, the
   *  agent service falls back to looking up the live byokStore. */
  supportsThinking?: boolean
  /** Shape of the thinking parameter the upstream provider expects.
   *  - `anthropic`: `thinking: { type: 'adaptive' }` + `output_config.effort`
   *    on Claude 4.6+/Fable 5; older models use
   *    `thinking: { type: 'enabled', budget_tokens }`
   *  - `openai_reasoning_effort`: `reasoning_effort: 'minimal' | 'medium'`
   *  - `qwen_enable_thinking`: `enable_thinking: boolean`
   *  - `gemini_thinking_budget`: `thinking_budget: number` (0 = off)
   *  Plan-profile shapes (`enable_thinking` / `reasoning.enabled`) are
   *  silently ignored by Anthropic/OpenAI/Gemini upstreams, which is why
   *  the toggle was a no-op for BYOK before this field existed. */
  thinkingShape?: 'anthropic' | 'openai_reasoning_effort' | 'qwen_enable_thinking' | 'gemini_thinking_budget' | 'openrouter_reasoning' | 'mimo_chat_template_kwargs' | 'moonshot_thinking'
  /** User-selected BYOK reasoning depth, frozen with the session. Providers
   *  that only support boolean thinking ignore this. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Model context window frozen at snapshot time (from the hardcoded catalog).
   *  Under BYOK the request bypasses the worker, so the IDE can't learn the
   *  window from X-Model-Context-Window — it seeds the auto-compact limit from
   *  here instead. `0`/absent → agentService falls back to FALLBACK_CONTEXT_WINDOW. */
  contextWindow?: number
}

export interface SessionContext {
  files: string[]
  fileTreeSummary: string
  projectType: string
  activeFile: string | null
  customInstructions?: string
}

export interface SessionSummary {
  id: string
  name?: string
  /** Descrição escrita pelo user — ver ChatSession.description. */
  description?: string
  projectPath: string
  messageCount: number
  lastMessage: string
  status: ChatSession['status']
  createdAt: number
  updatedAt: number
  /** Sessão criada por uma tarefa paralela ("Nova tarefa") — ver ChatSession. */
  isParallelTask?: boolean
  parallelTaskStatus?: ParallelTaskSessionStatus
}

/**
 * Estado final de uma tarefa paralela carimbado na SESSÃO (não só no
 * parallelTaskStore, que é memória): as tarefas não podem desaparecer — o
 * user consulta o chat delas em qualquer altura, mesmo depois de reload
 * (pedido 2026-07-16). 'running' só existe transientemente (crash a meio
 * deixa 'running' órfão; a UI trata sessão-sem-run-vivo como histórico).
 */
export type ParallelTaskSessionStatus = 'running' | 'completed' | 'error' | 'aborted'

/** Per-request usage record — one entry per `chat.completions.create` call.
 *  Captured in query.ts right after each provider response and persisted on
 *  the session so an exported session shows real consumption per request
 *  (eliminates inferring from compacted transcripts or in-memory-only totals).
 *  Best-effort: cache fields are undefined when the provider/adapter doesn't
 *  report them; estimatedInputTokens + breakdown come from the payloadInspector. */
export interface RequestUsageEntry {
  /** Stable unique id for the request (crypto.randomUUID). */
  requestId: string
  /** Agent-loop turn number (1-based, matches state.turnCount). */
  turn: number
  /** Provider id (BYOK providerId, or 'tms' for data-plane-routed). */
  provider?: string
  /** Model id the request was sent to. */
  model: string
  /** Model id that ACTUALLY served the response (X-TM-Model do data-plane).
   *  `model` é o placeholder pedido ("tm-active-model"); sem este campo o
   *  export de sessão não permite análise por modelo real (custo/qualidade
   *  por modelo — pré-requisito da auto-análise). Ausente em BYOK directo
   *  (o provider não emite o header) e em respostas sem headers. */
  servedModel?: string
  /** Provider real que serviu a resposta (X-TM-Provider). */
  servedProvider?: string
  /** Tempo de parede do pedido, do envio à última chunk — INCLUI as esperas
   *  de retry. Sem isto, um post-mortem não distingue "modelo lento" de
   *  "rate limited" de "ferramentas lentas": na sessão de 05-08 (turno de 49
   *  min) 46 min eram intervalos ENTRE tool calls e não havia como saber
   *  quanto era geração e quanto era escada de 429. */
  requestLatencyMs?: number
  /** Quantos 429 do provider este turno apanhou (0 = nenhum). */
  rateLimitRetries?: number
  /** Tempo total dormido na escada de 429 deste turno, em ms. */
  rateLimitWaitMs?: number
  /** Real input tokens from the provider's usage chunk. */
  inputTokens: number
  /** Real output tokens from the provider's usage chunk. */
  outputTokens: number
  /** Whether inputTokens/outputTokens came from a provider usage chunk. */
  usageAvailable?: boolean
  /** TMS.md bootstrap/context telemetry for this request. */
  executionPhase?: 'project_bootstrap' | 'original_task'
  bootstrapCompleted?: boolean
  originalTaskStarted?: boolean
  originalTaskCompleted?: boolean
  originalTaskFailedReason?: string
  tmsFound?: boolean
  tmsFoundAtStart?: boolean
  tmsAvailable?: boolean
  tmsAvailableAfterBootstrap?: boolean
  tmsBootstrapCompleted?: boolean
  tmsBootstrapTriggered?: boolean
  tmsCreated?: boolean
  tmsAlreadyExists?: boolean
  tmsBootstrapFailed?: boolean
  tmsPath?: string
  tmsBootstrapInputTokens?: number
  tmsBootstrapOutputTokens?: number
  tmsBootstrapPhase?: string
  /** Secções obrigatórias em falta quando tmsBootstrapPhase termina em
   *  `_invalid` (2026-08-03). O prompt já avisa o modelo ("INCOMPLETE
   *  (missing: …)"); sem este campo o export dizia "invalid" sem dizer
   *  PORQUÊ e a auto-análise lia-o como estado contraditório. */
  tmsMissingSections?: string[]
  tmsBootstrapToolset?: string
  tmsWriteAttempted?: boolean
  tmsWriteToolCallId?: string
  tmsBootstrapFailedReason?: string
  tmsContextSentFullThisTurn?: boolean
  tmsContextStubTokens?: number
  tmsStubTokens?: number
  tmsSectionsAvailable?: string[]
  tmsSectionsLoaded?: string[]
  tmsRequestedSections?: string[]
  tmsSectionsRequested?: string[]
  originalUserMessageDisplayed?: boolean
  originalTaskResumedAfterBootstrap?: boolean
  originalTaskResumeRequestId?: string
  originalTaskWriteActionCount?: number
  originalTaskFirstWriteTurn?: number
  readBeforeWriteBlocked?: boolean
  readBeforeWriteBlockCount?: number
  readBeforeWriteBlockedTools?: string[]
  readBeforeWriteBlockedReasons?: string[]
  symbolIndexRequested?: boolean
  symbolIndexFilesConsidered?: number
  symbolIndexFilesScanned?: number
  symbolIndexEntries?: number
  symbolIndexTruncated?: boolean
  symbolIndexTokensEstimate?: number
  /** ATENÇÃO — CUMULATIVO NA RUN, não deste pedido. A telemetria do TMS é um
   *  singleton de módulo carimbado em cada entrada, por isso estes campos, uma
   *  vez ligados, aparecem `true` em TODAS as entradas seguintes. Contar
   *  entradas com `shellReadBlocked === true` NÃO conta incidentes (um post-
   *  mortem de 05-08 leu 67 "incidentes" onde houve um). Para saber quando
   *  aconteceu, procurar a PRIMEIRA entrada que o traz. O mesmo vale para
   *  readBeforeWrite* e symbolIndex* acima. */
  shellReadBlocked?: boolean
  shellReadConvertedToFileTool?: boolean
  executeCommandPurpose?: 'validation' | 'file_read' | 'unknown'
  /** Anthropic prompt-cache creation tokens, when reported. */
  cacheCreationInputTokens?: number
  /** Anthropic prompt-cache read tokens, when reported. */
  cacheReadInputTokens?: number
  /** payloadInspector's pre-request estimate (ceil(chars/3)). Compare
   *  against the real inputTokens per request to gauge estimator accuracy. */
  estimatedInputTokens: number
  /** Decomposition of estimatedInputTokens by category (system, userText,
   *  mentionContext, assistantText, toolCall, toolResult, thinking, toolDefs,
   *  total). Proves the estimate doesn't double-count the system prompt. */
  estimatedInputTokensBreakdown?: {
    system: number
    userText: number
    mentionContext: number
    assistantText: number
    toolCall: number
    toolResult: number
    thinking: number
    toolDefs: number
    total: number
  }
  /** Number of messages sent to the provider in this request. */
  totalMessages?: number
  /** Number of tool definitions sent in this request. */
  toolCount?: number
  /** Number of tool definitions available before lazy selection. */
  toolCountTotal?: number
  /** Names of tool definitions sent in this request. */
  toolNames?: string[]
  /** Estimated tokens spent on tool definitions. */
  toolDefsTokens?: number
  /**
   * FNV-1a do segmento cacheável (tools + system). Muda entre turnos = prefixo
   * do provider invalidado por inteiro.
   */
  /**
   * Como a ocupação de contexto foi calculada: 'anchored' (real do turno
   * anterior + estimativa só do que veio depois), 'max-fallback' (âncora
   * inutilizável → o maior dos dois, comportamento pré-2026-07-31) ou
   * 'estimate-only' (primeiro turno). Um run cheio de 'max-fallback' está a
   * decidir compactação com o estimador sozinho.
   */
  occupancySource?: 'anchored' | 'max-fallback' | 'estimate-only'
  promptPrefixHash?: string
  /**
   * FNV-1a por mensagem, na ordem do pedido. Diagnostica quedas de cache read:
   * o primeiro índice que diverge face ao turno anterior é onde o prefixo
   * deixou de dar match. Divergir num índice ANTIGO significa histórico
   * reescrito — a única coisa que parte um prefixo de forma irrecuperável.
   */
  messageHashes?: string[]
  /** Why this request continued past the simple-bugfix turn target, if known. */
  continuationReason?: string
  /** Estimated tokens from @mention synthetic context specifically. */
  mentionContextTokens?: number
  /** ── Mention context redundancy (Correção B) ──
   *  When the mention context is sent as a short reference stub instead of
   *  the full outline (turns > 1), this is the token SAVING vs the full body.
   *  0 on the first turn (full outline sent) and whenever there's no mention. */
  mentionContextRepeatedTokens?: number
  /** Cumulative token saving from mention-context stubbing. */
  mentionContextRepeatedTokensCumulative?: number
  /** Full mention-context tokens used as baseline for the saving. */
  mentionContextFullTokens?: number
  /** Stub mention-context tokens actually sent in this request. */
  mentionContextStubTokens?: number
  /** True when the FULL mention outline was sent this turn; false when only a
   *  short reference stub was sent (follow-up turns). Lets an export prove the
   *  stub-path actually kicked in. */
  mentionContextSentFullThisTurn?: boolean
  /** Stable id for the mention context block, so the export can correlate the
   *  stub reference back to the turn that carried the full outline. */
  mentionContextRefId?: string
  /** ── Read Range Tracker (Correção C) ──
   *  Per-file read ranges the agent has read so far this session (offset/limit,
   *  1-indexed). Missing limit means read-to-EOF, not a hidden default page
   *  size; readToEnd marks that semantic explicitly in exports. */
  readRanges?: Array<{ path: string; offset?: number; limit?: number; readToEnd?: boolean }>
  /** Number of read_file calls skipped this turn because the requested range
   *  was already fully covered by a previous read. */
  skippedOverlappingReads?: number
  /** Number of read_file calls adjusted this turn because the requested range
   *  was partially covered — the call was narrowed to the missing sub-range. */
  adjustedReadRanges?: number
  /** payloadInspector's per-category breakdown (system, tool_result,
   *  tool_call, text, etc.) — blocks/tokens/chars each. */
  breakdown: Record<string, { blocks: number; tokens: number; chars: number }>
  /** Largest system-prompt sections for this exact provider request. */
  systemPromptSections?: Array<{
    name: string
    location: 'static' | 'dynamic'
    tokens: number
    chars: number
    auxiliaryCandidate?: boolean
    reason?: string
  }>
  /** Subset of systemPromptSections that look safe to investigate for
   *  lazy/on-demand loading. Heuristic only; changing prompt behavior still
   *  requires eval/real-session validation. */
  auxiliaryPromptCandidates?: Array<{
    name: string
    location: 'static' | 'dynamic'
    tokens: number
    chars: number
    reason?: string
  }>
  /** ── Lazy System Prompt + Tighter Toolset (Phase 1) ──
   *  Populated from payloadReport + the Intent Router classification + the
   *  ToolsetSelector state. Lets an exported session prove the tighter
   *  toolset actually reached the provider (toolCount, toolNames) AND show
   *  the auxiliary/on-demand savings (core/auxiliary split, savings). */
  /** Perfil de prompt. NÃO há Intent Router (removido) — é uma heurística
   *  local de um bit: `vision` se houver imagem, `default_task` no resto,
   *  `project_bootstrap` no /init. Chamava-se `bugfix_local`, herança do
   *  router morto, e fazia qualquer leitor do log concluir que uma feature
   *  tinha sido classificada como correcção de bug. */
  selectedPromptProfile?: string
  /** Tool profile applied by the selector (= profile; kept separate so the
   *  export can later distinguish prompt-profile from tool-profile). */
  selectedToolProfile?: string
  /** System-prompt tokens attributed to the always-loaded core context. */
  coreContextTokens?: number
  /** Alias for coreContextTokens in newer exports. */
  coreSystemTokens?: number
  /** System-prompt tokens attributed to the on-demand auxiliaries loaded inline. */
  auxiliaryContextTokens?: number
  /** Auxiliary ids LOADED inline in the system prompt. */
  auxiliaryLoaded?: string[]
  /** Alias for auxiliaryLoaded in newer exports. */
  loadedSystemSections?: string[]
  /** Auxiliary ids OMITTED (available via request_context). */
  auxiliaryOmitted?: string[]
  /** Alias for auxiliaryOmitted in newer exports. */
  omittedSystemSections?: string[]
  /** Sections loaded inline automatically by profile/trigger. */
  autoLoadedSystemSections?: string[]
  /**
   * Secções BOUNDED retidas pelo portão de evidência do projecto (achado #9).
   * Ao contrário de `auxiliaryOmitted` (que junta as unbounded), estas teriam
   * ido inline se o projecto tivesse a superfície correspondente — é este par
   * de campos que torna auditável "porque é que este projecto perdeu as
   * secções de design system".
   */
  evidenceOmittedSections?: string[]
  evidenceOmitReason?: Record<string, string>
  /** Sinais de evidência detectados (`dep:react`, `dir:ui-like`, …). */
  evidenceSignals?: string[]
  /** Context planner candidate sections for this task. */
  contextPlanCandidateSections?: string[]
  /** Tokens saved by omitting the auxiliaries (vs loading everything). */
  auxiliarySavingsTokens?: number
  /** Alias for auxiliarySavingsTokens in newer exports. */
  systemPromptSavingsTokens?: number
  /** Human-readable reason for the selected prompt/system profile. */
  systemPromptProfileReason?: string
  /** Whether the run is read-only (no file edits) per the Intent Router. */
  readOnlyRun?: boolean
  /** Why the Intent Router chose this profile (for audit). */
  toolsetReason?: string
  /** ── Intent Router diagnostics ── */
  /** 'model' = LLM router classified; 'fallback' = router failed; 'keyword' = no router. */
  routerSource?: 'model' | 'fallback' | 'keyword'
  /** Router self-reported confidence; 'none' on fallback/keyword. */
  routerConfidence?: 'high' | 'medium' | 'low' | 'none'
  /** When the router failed, the failure reason (token/HTTP/timeout/…). */
  routerError?: string
  /** Full diagnostics (raw body, headers, parse error) — exported so a failed
   *  router run is diagnosable from the session export alone. */
  routerDiagnostics?: {
    url: string
    appCheckPresent: boolean
    httpStatus: number
    servedModel?: string
    configKey?: string
    contentType?: string
    rawBodyPreview?: string
    contentPreview?: string
    parseError?: string
  }
  /** ── Context Planner telemetry ──
   *  Mirrors the ContextPlanClassification so the session export proves
   *  whether the utility-model planner produced a valid plan ('parsed') or
   *  fell back ('fallback'), with the raw output / error for diagnosis. */
  /** 'parsed' = planner returned valid JSON; 'fallback' = invalid/missing and
   *  a deterministic per-profile plan was used instead. */
  contextPlannerStatus?: 'parsed' | 'deterministic' | 'fallback'
  /** 'model' when the context plan came from a model. 'fallback' exists for legacy exports only. */
  contextPlannerSource?: 'model' | 'deterministic' | 'fallback'
  /** Which model layer produced the plan. 'code' means utility planner retries failed and the code model returned valid JSON. */
  contextPlannerModel?: 'utility' | 'code'
  /** When status === 'fallback', the failure reason (schema/parse/HTTP/…). */
  contextPlannerError?: string
  /** The raw planner output (model JSON or HTTP body preview) for audit. */
  contextPlannerRawOutput?: string
  /** Why the planner escalated to the code model, when applicable. */
  contextPlannerFallbackReason?: string
  /** Task domain the planner assigned (e.g. 'design_system_ui'). */
  contextPlannerTaskDomain?: string
  /** Capabilities the planner declared as required. */
  contextPlannerRequiredCapabilities?: string[]
  /** Contexts the planner selected to load inline. */
  contextPlannerSelectedContexts?: string[]
  /** Contexts considered but NOT selected (candidates minus selected). */
  contextPlannerRejectedContexts?: string[]
  /** The planner's selection rationale. */
  contextPlannerSelectionReason?: string
  /** Tool names requested on demand during the run. This is an audit trail,
   *  not proof those tools are still active on later model steps. */
  expandedToolNames?: string[]
  /** Tools the model requested but an explicit policy denied. */
  deniedToolNames?: string[]
  /** ── Write-action telemetry ──
   *  Populated from the query loop's run-level tracking. */
  /** Whether any file-mutating tool (edit_file, write_file, …) ran
   *  successfully during this run, as of this request. */
  runHasEdited?: boolean
  /** Turn number of the first successful file mutation (1-indexed). */
  firstWriteTurn?: number
  /** Total count of successful file-mutating tool calls this run. */
  writeActionCount?: number
  /** ── Delegate/sub-agent telemetry ──
   *  Populated when the delegate tool was called this run. Lets the session
   *  export prove the member field was resolved (or why it was blocked). */
  delegateRequestedMember?: string | null
  delegateResolvedMember?: string | null
  delegateBlocked?: boolean
  delegateBlockedReason?: string | null
  delegateInputSchemaVersion?: string
  delegateRecoveryAttempted?: boolean
}

export interface SessionTokenUsage {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTurns: number
}

/** Snapshot of the last on-wire turn's token counters + model identity.
 *  Persisted so the context-window indicator survives a session reload —
 *  without this, every reopen flashes the bar to 0% until the user sends
 *  a new message and the next turn handshake re-populates the live state. */
export interface SessionTurnSnapshot {
  /** Last turn's input tokens — drives the pressure bar. */
  promptTokens: number
  /** Last turn's output tokens — tooltip breakdown only. */
  responseTokens: number
  /** Maior prompt da sessão. Persistido para a linha "Pico da sessão" do
   *  tooltip não desaparecer ao reabrir a sessão. Ausente em sessões
   *  gravadas antes de 2026-08-05. */
  peakPromptTokens?: number
  /** Server-reported model context window (X-Model-Context-Window) at the
   *  last turn. Null when the session was saved before any turn ran. */
  contextWindow: number | null
  /** Friendly model name (X-Model-Name) at the last turn, restored so the
   *  tooltip reads correctly until the next turn handshakes. */
  modelName: string | null
}

export interface PersistedSession {
  id: string
  projectPath: string
  status: ChatSession['status']
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  context?: SessionContext
  tokenUsage?: SessionTokenUsage
  lastTurnSnapshot?: SessionTurnSnapshot
  byokSnapshot?: ByokSessionSnapshot | null
  sessionMemory?: string
  planResumePending?: PlanResumePending | null
  /** Per-request usage log — persisted so an exported session shows real
   *  consumption per request (eliminates manual inference). */
  requestUsageLog?: RequestUsageEntry[]
  /** Sessão de tarefa paralela — ver ChatSession.isParallelTask. */
  isParallelTask?: boolean
  parallelTaskStatus?: ParallelTaskSessionStatus
}
