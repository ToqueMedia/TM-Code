/**
 * Hooks — comandos do developer executados à volta das tool calls.
 *
 * PORTE de `cli-vaz/utils/hooks.ts` + `types/hooks.ts`. Porquê portar em vez
 * de resolver caso a caso: está medido neste repo, três vezes, que prosa não
 * fecha buracos de comportamento (ver o cabeçalho de `editDiagnostics.ts`, e a
 * nota em `sharedSections.ts` sobre as duas experiências de 2026-08-06). O
 * cli-vaz — a referência — NÃO tem detector de convenções nenhum: tem
 * `CLAUDE.md` para o developer declarar as regras e HOOKS para lhes dar
 * dentes. O TM Code já tinha a primeira metade (TMS.md, injectado inteiro);
 * faltava esta.
 *
 * ── O CONTRATO é o do cli-vaz, de propósito ────────────────────────────────
 * Um hook escrito para o Claude Code corre aqui sem alterações. É a lição de
 * 2026-07-28 (renomear as tools para o dialecto de treino importou o contrato
 * junto): adoptar o mecanismo sem adoptar a interface deixa o developer a
 * escrever duas versões da mesma coisa.
 *
 *   - Config: `.toquemedia/hooks.json` no projecto
 *     { "PostToolUse": [ { "matcher": "Write|Edit",
 *                          "hooks": [ { "type": "command", "command": "…" } ] } ] }
 *   - `matcher` é uma REGEX contra o nome da tool COMO O MODELO A VÊ (o alias
 *     de treino: `Write`, `Edit`, `Bash`), não o id interno.
 *   - Payload: JSON no STDIN — `hook_event_name`, `tool_name`, `tool_input`,
 *     `tool_response` (só no Post), `session_id`, `cwd`.
 *   - Saída: JSON no stdout com `decision`/`reason` e/ou
 *     `hookSpecificOutput.additionalContext`. Exit code 2 = BLOQUEIA, com o
 *     stderr como razão (convenção do cli-vaz, utils/hooks.ts:2647).
 *   - Qualquer outro exit code ≠ 0 é ruído: regista-se e ignora-se. Um hook
 *     partido não pode parar o agente.
 *
 * ── ESTADO: medido fim-a-fim no runner headless (2026-08-06) ───────────────
 *   - Disparo, payload no stdin, matcher-regex, exit 2 e additionalContext:
 *     todos PROVADOS contra o eval `ui-design-tokens`.
 *   - BLOQUEIO PROVADO: com exit 2 em todas as tools, 13 chamadas recusadas
 *     (incluindo as de contorno — `Bash`, `create_file`) e o ficheiro NÃO
 *     chega ao disco.
 *   - `additionalContext` (exit 0) é CONSELHO e não muda comportamento: 5/10,
 *     igual à linha de base sem hook. Quem quiser IMPOR usa exit 2 — no
 *     PreToolUse impede a escrita, no PostToolUse devolve o resultado como
 *     ERRO (a escrita já aconteceu e não se desfaz, mas o modelo tem de a
 *     corrigir em vez de a poder ignorar).
 *   - EFEITO MEDIDO no problema real (usar os design tokens do projecto):
 *     37% de falha SEM hook (n=40, com e sem as secções de prompt) → 0 em 10
 *     com um PreToolUse de 12 linhas a recusar a escrita. É o que três
 *     experiências de PROSA não conseguiram mover.
 *
 *   - PostToolUse com exit 2 IMPÕE (2026-08-06): 3 rejeições em 10 corridas,
 *     todas corrigidas pelo modelo → 10/10. Sem este ramo o `blocked` era
 *     calculado e deitado fora, e um hook de Post com exit 2 não fazia nada.
 *
 * ── DUAS ARMADILHAS para quem escrever hooks ───────────────────────────────
 * 1. O agente CONTORNA. Bloqueado no `Write`, o trace mostrou-o a tentar
 *    `Bash`, `create_file` e `Edit`. Um matcher só com `Write` deixa a porta
 *    do lado aberta.
 * 2. No PostToolUse de uma tool de ESCRITA, o ficheiro AINDA NÃO ESTÁ NO
 *    DISCO. Diverge do cli-vaz: aqui `toolExecutor.execute` devolve um diff e
 *    a escrita real acontece depois, no fluxo de aprovação. Um hook que faça
 *    `[ -f "$FILE" ]` sai em silêncio e não faz nada — medido, e quase
 *    reportado como sucesso. Lê `tool_input.content` do payload.
 */

import { invoke } from '@/utils/invokeMetrics'
import { logger } from '@/utils/logger'

export type HookEvent = 'PreToolUse' | 'PostToolUse'

interface HookCommand {
  type?: 'command'
  command: string
  timeout?: number
}

interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

export interface HookOutcome {
  /** O hook mandou parar a tool. Só honrado no PreToolUse. */
  blocked: boolean
  /** Razão do bloqueio, entregue ao modelo como resultado da tool. */
  blockReason?: string
  /** Texto a entregar ao modelo em `<system-reminder>` — o canal do editDiagnostics. */
  additionalContext?: string
}

const EMPTY: HookOutcome = { blocked: false }

/**
 * Contexto de PreToolUse à espera de ser colado ao resultado da tool. O Pre
 * corre ANTES de haver resultado; guardar por `toolUseId` é o que permite
 * entregar Pre e Post no mesmo bloco, em vez de um deles se perder.
 */
const pendingContext = new Map<string, string[]>()

export function appendHookContext(toolUseId: string, text: string): void {
  const list = pendingContext.get(toolUseId) ?? []
  list.push(text)
  pendingContext.set(toolUseId, list)
}

export function takeHookContext(toolUseId: string): string | null {
  const list = pendingContext.get(toolUseId)
  if (!list?.length) return null
  pendingContext.delete(toolUseId)
  return list.join('\n\n')
}

/** Teto por hook. O cli-vaz usa 60s; aqui o mesmo, com o timeout do Rust. */
const HOOK_TIMEOUT_SECS = 60

const CONFIG_RELATIVE_PATH = '.toquemedia/hooks.json'

/**
 * Cache por projecto+fsVersion. Sem isto lia-se o ficheiro duas vezes por tool
 * call num loop que faz dezenas — e o custo não é o disco, é o IPC.
 */
let configCache: { key: string; config: HooksConfig | null } | null = null

async function loadConfig(projectPath: string, fsVersion: number): Promise<HooksConfig | null> {
  const key = `${projectPath}|${fsVersion}`
  if (configCache?.key === key) return configCache.config
  let config: HooksConfig | null = null
  try {
    const raw = await invoke<string | null>('read_file', {
      path: `${projectPath}/${CONFIG_RELATIVE_PATH}`,
    })
    config = raw ? (JSON.parse(raw) as HooksConfig) : null
  } catch {
    // Ausente é o caso normal; ilegível/JSON inválido não pode parar o agente.
    config = null
  }
  // Config no sítio errado é o pior modo de falha: o developer (ou o agente)
  // escreve uma config perfeita, nada corre, e nada o diz. Medido a 2026-08-06
  // num eval — `hooks.json` na raiz, ao lado de um exemplo. Não a carregamos
  // daqui (adivinhar o sítio seria inventar contrato), mas deixamos de o
  // esconder.
  if (!config) {
    for (const stray of ['hooks.json', '.tms/hooks.json', '.claude/hooks.json']) {
      try {
        const found = await invoke<string | null>('read_file', {
          path: `${projectPath}/${stray}`,
        })
        if (found) {
          logger.info(
            'agent',
            `[hooks] existe um ${stray} mas os hooks só são lidos de ${CONFIG_RELATIVE_PATH} — este ficheiro está a ser IGNORADO.`,
          )
          break
        }
      } catch { /* não existe: o caso normal */ }
    }
  }
  configCache = { key, config }
  return config
}

/** Só para os testes: o cache é módulo-global. */
export function __resetHooksConfigCacheForTests(): void {
  configCache = null
}

function matchingCommands(
  config: HooksConfig | null,
  event: HookEvent,
  toolName: string,
): HookCommand[] {
  const matchers = config?.[event]
  if (!Array.isArray(matchers)) return []
  const out: HookCommand[] = []
  for (const entry of matchers) {
    if (!entry || !Array.isArray(entry.hooks)) continue
    // Sem matcher = casa com tudo (mesma regra do cli-vaz).
    if (entry.matcher) {
      let re: RegExp
      try {
        re = new RegExp(entry.matcher)
      } catch {
        // Regex inválida na config do developer: ignora-se ESTA entrada, e
        // avisa-se — silêncio aqui seria um hook que parece activo e não está.
        logger.info('agent', `[hooks] matcher inválido ignorado: ${entry.matcher}`)
        continue
      }
      if (!re.test(toolName)) continue
    }
    for (const h of entry.hooks) {
      if (h && typeof h.command === 'string' && h.command.trim()) out.push(h)
    }
  }
  return out
}

interface HookJsonOutput {
  decision?: 'approve' | 'block'
  reason?: string
  hookSpecificOutput?: { additionalContext?: string }
}

function parseHookStdout(stdout: string): HookJsonOutput | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as HookJsonOutput
  } catch {
    // stdout que não é JSON é legítimo (um hook que só imprime): não é erro.
    return null
  }
}

async function runOne(
  hook: HookCommand,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<HookOutcome> {
  // `exitCode`, NÃO `exit_code`: o `CommandResult` do Rust é serializado com
  // `#[serde(rename_all = "camelCase")]`. A primeira versão deste ficheiro leu
  // snake_case, o campo vinha `undefined`, o fallback transformava o exit 2 num
  // 1 — e NENHUM hook bloqueava. Custou uma tarde a encontrar porque os testes
  // unitários mockavam `exit_code`: escritos a partir da implementação em vez
  // do contrato, confirmaram o engano em vez de o apanhar.
  let result: { stdout?: string; stderr?: string; exitCode?: number; success?: boolean }
  try {
    result = await invoke('execute_command', {
      command: hook.command,
      cwd,
      timeoutSecs: hook.timeout ?? HOOK_TIMEOUT_SECS,
      stdin: JSON.stringify(payload),
    })
  } catch (err) {
    logger.info('agent', `[hooks] falhou a executar "${hook.command}": ${String(err)}`)
    return EMPTY
  }

  const exitCode = result.exitCode ?? (result.success === false ? 1 : 0)
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''

  // Exit 2 = bloqueio com feedback (cli-vaz utils/hooks.ts:2647). O stderr é a
  // razão; sem stderr, dizê-lo à mesma em vez de bloquear em silêncio.
  if (exitCode === 2) {
    return {
      blocked: true,
      blockReason: `[${hook.command}]: ${stderr.trim() || 'sem stderr'}`,
    }
  }

  const json = parseHookStdout(stdout)
  if (json?.decision === 'block') {
    return { blocked: true, blockReason: json.reason ?? `[${hook.command}]: bloqueado` }
  }

  const ctx = json?.hookSpecificOutput?.additionalContext
  if (ctx && ctx.trim()) return { blocked: false, additionalContext: ctx.trim() }

  if (exitCode !== 0) {
    // Erro que não é bloqueio: regista e segue. O agente não pára por um hook
    // partido — mas também não finge que correu bem.
    logger.info('agent', `[hooks] "${hook.command}" saiu com ${exitCode}: ${stderr.slice(0, 200)}`)
  }
  return EMPTY
}

/**
 * Corre os hooks de um evento em SÉRIE e agrega. Série e não paralelo: um hook
 * de PreToolUse pode escrever no projecto (formatar, gerar), e o seguinte tem
 * de ver esse estado. O primeiro bloqueio ganha e interrompe os restantes.
 */
export async function runHooks(
  event: HookEvent,
  args: {
    toolName: string
    toolInput: unknown
    toolResponse?: unknown
    projectPath: string
    sessionId?: string
    fsVersion: number
  },
): Promise<HookOutcome> {
  const config = await loadConfig(args.projectPath, args.fsVersion)
  const commands = matchingCommands(config, event, args.toolName)
  if (commands.length === 0) return EMPTY

  const payload: Record<string, unknown> = {
    hook_event_name: event,
    tool_name: args.toolName,
    tool_input: args.toolInput,
    session_id: args.sessionId ?? '',
    cwd: args.projectPath,
  }
  if (event === 'PostToolUse') payload.tool_response = args.toolResponse

  const contexts: string[] = []
  for (const hook of commands) {
    const outcome = await runOne(hook, payload, args.projectPath)
    if (outcome.blocked) return outcome
    if (outcome.additionalContext) contexts.push(outcome.additionalContext)
  }
  return contexts.length
    ? { blocked: false, additionalContext: contexts.join('\n\n') }
    : EMPTY
}
