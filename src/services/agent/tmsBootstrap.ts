import { invoke } from '@/utils/invokeMetrics'
import { setTmsTurnTelemetry } from './tmsContext'
import type { TranslationKey } from '../../i18n'

const REQUIRED_SECTION_ALIASES = [
  ['overview', 'visao geral'],
  ['stack'],
  ['commands', 'comandos'],
  ['structure', 'estrutura'],
  ['entrypoints'],
  ['project patterns', 'padroes do projecto'],
  ['agent rules', 'regras para o agente'],
  ['confirmed'],
  ['inferred'],
  ['pending confirmation'],
  ['lastgeneratedat'],
  ['sourcefilesused'],
]

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

export interface TmsPreflightResult {
  tmsFound: boolean
  valid: boolean
  stale: boolean
  created: false
  path: string
  shouldBootstrap: boolean
  reason: 'missing' | 'invalid' | 'stale' | 'ok'
}

export function getTmsBootstrapStartMessageKey(result: TmsPreflightResult): TranslationKey {
  if (result.reason === 'missing') return 'common.tmsBootstrapMissingStart'
  if (result.reason === 'stale') return 'common.tmsBootstrapStaleStart'
  return 'common.tmsBootstrapRepairStart'
}

export function getTmsBootstrapCompleteMessageKey(tmsCreated: boolean): TranslationKey {
  return tmsCreated ? 'common.tmsBootstrapCreatedComplete' : 'common.tmsBootstrapUpdatedComplete'
}

function formatOriginalRequestForBootstrap(originalUserMessage?: string): string {
  const trimmed = originalUserMessage?.trim()
  if (!trimmed) return 'Original user request: (not included in this preflight).'
  const compact = trimmed.length > 1200
    ? `${trimmed.slice(0, 1200).trimEnd()}\n...[truncated]`
    : trimmed
  return `Original user request, pending for the next phase:\n${compact}`
}

function normalizeSectionName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function parseSectionNames(content: string): string[] {
  return content
    .split('\n')
    .filter(line => /^#{1,3}\s+/.test(line.trim()))
    .map(line => normalizeSectionName(line.replace(/^#{1,3}\s+/, '').trim()))
}

function validateTms(content: string): boolean {
  return missingTmsSections(content).length === 0
}

/**
 * Quais secções obrigatórias faltam a este TMS.md.
 *
 * PORQUÊ ISTO É PÚBLICO (auditoria 2026-07-30): a validação existia, corria, e
 * o resultado morria numa flag de telemetria (`already_exists_invalid`). O
 * `shouldBootstrap` é `false` por decisão de produto — /init é o único caminho
 * de criação, paridade com o claude-vaz — portanto um TMS inválido não é
 * reparado, e como o FICHEIRO existe o aviso de "/init" (gated em
 * `projectStore.noTmsFile`) também não aparece. Resultado: o mapa parcial é
 * injetado como se estivesse completo.
 *
 * Medido na sessão yyyy (momenu-fact, 2026-07-30): o TMS declarava "Firebase
 * Cloud Functions" no enquadramento mas a sua "Visão Geral do Diretório" só
 * listava `src/**`. Faltavam-lhe `structure`, `entrypoints`, `commands` e
 * `agent rules` — exactamente o que diria onde vivem as rotas do backend. O
 * modelo gastou 12 das 20 tool calls a descobrir `functions/src/routes/` à
 * força, e o prompt ainda lhe mandava "Follow Agent Rules, Commands, and
 * Confirmed facts below" — três secções inexistentes.
 *
 * Nomear o que falta transforma uma armadilha silenciosa num desconhecido
 * conhecido: o modelo deixa de tratar o mapa como completo.
 */
export function missingTmsSections(content: string): string[] {
  const sections = parseSectionNames(content)
  return REQUIRED_SECTION_ALIASES.filter(
    aliases => !aliases.some(required => sections.some(section => section.includes(required))),
  ).map(aliases => aliases[0])
}

function parseLastGeneratedAt(content: string): string | null {
  const match =
    content.match(/lastGeneratedAt\s*:\s*([^\n]+)/i) ??
    content.match(/##\s+lastGeneratedAt\s*\n+([^\n]+)/i)
  return match?.[1]?.trim().replace(/^[-*]\s*/, '') ?? null
}

function parseSourceFilesUsed(content: string): string[] {
  const section = content.match(/##\s+sourceFilesUsed\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i)?.[1] ?? ''
  const lines = section
    .split('\n')
    .map(line => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean)
  return lines.filter(line =>
    !line.startsWith('list_directory:') &&
    !line.startsWith('glob:') &&
    !line.startsWith('search_files:') &&
    !line.startsWith('LS:') &&
    !line.startsWith('Glob:') &&
    !line.startsWith('Grep:') &&
    !line.startsWith('Read:'),
  )
}

async function isTmsStale(projectPath: string, content: string): Promise<boolean> {
  const generatedRaw = parseLastGeneratedAt(content)
  if (!generatedRaw) return false
  const generatedMs = Date.parse(generatedRaw)
  if (!Number.isFinite(generatedMs)) return false
  const sourceFiles = parseSourceFilesUsed(content)
  if (sourceFiles.length === 0) return false

  // PARALELO, não em série (auditoria 2026-07-28): eram até 40 IPC seriais
  // ENTRE o Enter e a montagem do prompt, em TODAS as mensagens — dezenas de
  // round-trips de latência pura antes de o modelo receber o primeiro byte.
  // As sondagens são independentes; o custo passa a ser o do stat mais lento.
  const stats = await Promise.all(
    sourceFiles.slice(0, 40).map(async (rel) => {
      try {
        const stat = await invoke<{ modifiedMs: number | null }>('file_stat', {
          path: `${projectPath}/${rel}`,
        })
        return stat.modifiedMs ?? null
      } catch {
        // Missing source files do not block the user's task.
        return null
      }
    }),
  )
  return stats.some((modifiedMs) => modifiedMs !== null && modifiedMs > generatedMs)
}

export function buildTmsBootstrapOnlyPrompt(result: TmsPreflightResult, originalUserMessage?: string): string {
  if (!result.shouldBootstrap) return ''

  const reasonText =
    result.reason === 'missing'
      ? 'TMS.md was not found'
      : result.reason === 'invalid'
        ? 'TMS.md exists but is incomplete or invalid'
        : 'TMS.md appears stale based on lastGeneratedAt/sourceFilesUsed metadata'
  const detectedText =
    result.reason === 'missing'
      ? 'You, as the coding agent, detected that the project memory/map is missing before executing the original request.'
      : result.reason === 'invalid'
        ? 'You, as the coding agent, detected that an existing TMS.md needs repair before executing the original request.'
        : 'You, as the coding agent, detected that an existing TMS.md appears stale before executing the original request.'
  const operationalDecision =
    result.reason === 'missing'
      ? 'First map the project and create TMS.md; then handle the original user request with that context.'
      : 'First read and preserve the existing TMS.md, refresh/repair it with a focused project map, then handle the original user request with that context.'
  const writeVerb = result.reason === 'missing' ? 'created' : 'updated'

  return `TM Code internal preflight: ${reasonText}.

The user did NOT ask you to create TMS.md. The user asked for a different task.
${detectedText}

${formatOriginalRequestForBootstrap(originalUserMessage)}

Operational decision:
${operationalDecision}

Current phase: project_bootstrap.

Mandatory rules:
- Do not treat TMS.md creation as the user's request.
- Do not solve the original task in this phase.
- Do not use execute_command.
- Use only LS, Glob, Grep, and Read to map the project.
- If TMS.md already exists, read it first with Read and preserve human-authored sections.
- Read focused key files only: package.json, README, configs, and src/app entrypoints.
- Avoid mass-reading the repository.
- Create or repair ${result.path} with these sections:
  - overview
  - stack
  - commands
  - structure
  - entrypoints
  - project patterns
  - agent rules
  - confirmed
  - inferred
  - pending confirmation
  - lastGeneratedAt
  - sourceFilesUsed
- After write_file/create_file confirms the file was ${writeVerb}, stop the bootstrap phase.
- The host will display the localized completion status and resume the original request in a separate call.`
}

export async function runTmsPreflight(options: {
  projectPath: string
  originalUserMessageDisplayed: boolean
  originalUserMessage?: string
}): Promise<TmsPreflightResult> {
  const tmsPath = `${options.projectPath}/TMS.md`
  let existing: string | null = null
  try {
    existing = await invoke<string>('read_file', { path: tmsPath })
  } catch {
    existing = null
  }

  if (existing === null) {
    // A missing TMS.md NEVER hijacks the user's message into a bootstrap run
    // (user decision 2026-07-16, claude-vaz parity: a missing CLAUDE.md there
    // changes nothing about the run — the system prompt simply omits project
    // memory and the UI suggests /init). The forced two-phase
    // project_bootstrap used to fire here for EVERY first message in a
    // TMS-less project, even an empty folder; /init is now the ONLY creation
    // path. The one-time "/init" hint is shown by the dispatch call sites
    // (usePromptBar + agentRunner), gated on projectStore.noTmsFile.
    const shouldBootstrap = false
    const result: TmsPreflightResult = {
      tmsFound: false,
      valid: false,
      stale: false,
      created: false,
      path: tmsPath,
      shouldBootstrap,
      reason: 'missing',
    }
    setTmsTurnTelemetry({
      executionPhase: shouldBootstrap ? 'project_bootstrap' : 'original_task',
      bootstrapCompleted: false,
      originalTaskStarted: false,
      originalTaskCompleted: false,
      originalTaskFailedReason: undefined,
      tmsFound: false,
      tmsFoundAtStart: false,
      tmsAvailable: false,
      tmsAvailableAfterBootstrap: false,
      tmsBootstrapCompleted: false,
      tmsBootstrapTriggered: shouldBootstrap,
      tmsCreated: false,
      tmsAlreadyExists: false,
      tmsBootstrapFailed: false,
      tmsPath,
      tmsBootstrapInputTokens: shouldBootstrap ? estimateTokens(buildTmsBootstrapOnlyPrompt(result, options.originalUserMessage)) : 0,
      tmsBootstrapOutputTokens: 0,
      tmsBootstrapPhase: shouldBootstrap ? 'preflight_missing' : 'missing_skipped',
      tmsBootstrapToolset: shouldBootstrap ? 'project_bootstrap' : undefined,
      tmsWriteAttempted: false,
      tmsWriteToolCallId: undefined,
      tmsBootstrapFailedReason: undefined,
      tmsContextSentFullThisTurn: false,
      tmsContextStubTokens: 0,
      tmsStubTokens: 0,
      tmsSectionsAvailable: [],
      tmsSectionsLoaded: [],
      tmsRequestedSections: [],
      tmsSectionsRequested: [],
      originalUserMessageDisplayed: options.originalUserMessageDisplayed,
      originalTaskResumedAfterBootstrap: false,
      originalTaskResumeRequestId: undefined,
      mutableTask: false,
      originalTaskWriteActionCount: 0,
      originalTaskFirstWriteTurn: undefined,
      noEditGuardTriggered: false,
      noEditGuardReason: undefined,
      noEditRecoveryAction: undefined,
      readBeforeWriteBlocked: false,
      readBeforeWriteBlockCount: 0,
      readBeforeWriteBlockedTools: [],
      readBeforeWriteBlockedReasons: [],
      symbolIndexRequested: false,
      symbolIndexFilesConsidered: 0,
      symbolIndexFilesScanned: 0,
      symbolIndexEntries: 0,
      symbolIndexTruncated: false,
      symbolIndexTokensEstimate: 0,
      shellReadBlocked: false,
      shellReadConvertedToFileTool: false,
      executeCommandPurpose: undefined,
    })
    return result
  }

  const valid = validateTms(existing)
  const stale = await isTmsStale(options.projectPath, existing)
  const reason: TmsPreflightResult['reason'] = !valid ? 'invalid' : stale ? 'stale' : 'ok'
  const shouldBootstrap = false
  const result: TmsPreflightResult = {
    tmsFound: true,
    valid,
    stale,
    created: false,
    path: tmsPath,
    shouldBootstrap,
    reason,
  }

  setTmsTurnTelemetry({
    executionPhase: shouldBootstrap ? 'project_bootstrap' : 'original_task',
    bootstrapCompleted: !shouldBootstrap,
    originalTaskStarted: false,
    originalTaskCompleted: false,
    originalTaskFailedReason: undefined,
    tmsFound: true,
    tmsFoundAtStart: true,
    tmsAvailable: true,
    tmsAvailableAfterBootstrap: true,
    tmsBootstrapCompleted: true,
    tmsBootstrapTriggered: shouldBootstrap,
    tmsCreated: false,
    tmsAlreadyExists: !shouldBootstrap,
    tmsBootstrapFailed: false,
    tmsPath,
    tmsBootstrapInputTokens: shouldBootstrap ? estimateTokens(buildTmsBootstrapOnlyPrompt(result, options.originalUserMessage)) : 0,
    tmsBootstrapOutputTokens: 0,
    tmsBootstrapPhase: reason === 'ok' ? 'already_exists' : `already_exists_${reason}`,
    tmsBootstrapToolset: undefined,
    tmsWriteAttempted: false,
    tmsWriteToolCallId: undefined,
    tmsBootstrapFailedReason: undefined,
    tmsContextSentFullThisTurn: false,
    tmsContextStubTokens: 0,
    tmsStubTokens: 0,
    tmsSectionsAvailable: [],
    tmsSectionsLoaded: [],
    tmsRequestedSections: [],
    tmsSectionsRequested: [],
    originalUserMessageDisplayed: options.originalUserMessageDisplayed,
    originalTaskResumedAfterBootstrap: false,
    originalTaskResumeRequestId: undefined,
    mutableTask: false,
    originalTaskWriteActionCount: 0,
    originalTaskFirstWriteTurn: undefined,
    noEditGuardTriggered: false,
    noEditGuardReason: undefined,
    noEditRecoveryAction: undefined,
    readBeforeWriteBlocked: false,
    readBeforeWriteBlockCount: 0,
    readBeforeWriteBlockedTools: [],
    readBeforeWriteBlockedReasons: [],
    symbolIndexRequested: false,
    symbolIndexFilesConsidered: 0,
    symbolIndexFilesScanned: 0,
    symbolIndexEntries: 0,
    symbolIndexTruncated: false,
    symbolIndexTokensEstimate: 0,
    shellReadBlocked: false,
    shellReadConvertedToFileTool: false,
    executeCommandPurpose: undefined,
  })
  return result
}
