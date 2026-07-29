import type { RequestUsageEntry } from '../../types/chat'

const APPROX_CHARS_PER_TOKEN = 4

export interface TmsTurnTelemetry {
  executionPhase?: 'project_bootstrap' | 'original_task'
  bootstrapCompleted: boolean
  originalTaskStarted: boolean
  originalTaskCompleted: boolean
  originalTaskFailedReason?: string
  tmsFound: boolean
  tmsFoundAtStart: boolean
  tmsAvailable: boolean
  tmsAvailableAfterBootstrap: boolean
  tmsBootstrapCompleted: boolean
  tmsBootstrapTriggered: boolean
  tmsCreated: boolean
  tmsAlreadyExists: boolean
  tmsBootstrapFailed: boolean
  tmsPath?: string
  tmsBootstrapInputTokens: number
  tmsBootstrapOutputTokens: number
  tmsBootstrapPhase?: string
  tmsBootstrapToolset?: string
  tmsWriteAttempted: boolean
  tmsWriteToolCallId?: string
  tmsBootstrapFailedReason?: string
  tmsContextSentFullThisTurn: boolean
  tmsContextStubTokens: number
  tmsStubTokens: number
  tmsSectionsAvailable: string[]
  tmsSectionsLoaded: string[]
  tmsRequestedSections: string[]
  tmsSectionsRequested: string[]
  originalUserMessageDisplayed: boolean
  originalTaskResumedAfterBootstrap: boolean
  originalTaskResumeRequestId?: string
  mutableTask: boolean
  originalTaskWriteActionCount: number
  originalTaskFirstWriteTurn?: number
  noEditGuardTriggered: boolean
  noEditGuardReason?: string
  noEditRecoveryAction?: string
  readBeforeWriteBlocked: boolean
  readBeforeWriteBlockCount: number
  readBeforeWriteBlockedTools: string[]
  readBeforeWriteBlockedReasons: string[]
  symbolIndexRequested: boolean
  symbolIndexFilesConsidered: number
  symbolIndexFilesScanned: number
  symbolIndexEntries: number
  symbolIndexTruncated: boolean
  symbolIndexTokensEstimate: number
  shellReadBlocked: boolean
  shellReadConvertedToFileTool: boolean
  executeCommandPurpose?: 'validation' | 'file_read' | 'unknown'
}

let currentTelemetry: TmsTurnTelemetry = {
  bootstrapCompleted: false,
  originalTaskStarted: false,
  originalTaskCompleted: false,
  tmsFound: false,
  tmsFoundAtStart: false,
  tmsAvailable: false,
  tmsAvailableAfterBootstrap: false,
  tmsBootstrapCompleted: false,
  tmsBootstrapTriggered: false,
  tmsCreated: false,
  tmsAlreadyExists: false,
  tmsBootstrapFailed: false,
  tmsBootstrapInputTokens: 0,
  tmsBootstrapOutputTokens: 0,
  tmsWriteAttempted: false,
  tmsContextSentFullThisTurn: false,
  tmsContextStubTokens: 0,
  tmsStubTokens: 0,
  tmsSectionsAvailable: [],
  tmsSectionsLoaded: [],
  tmsRequestedSections: [],
  tmsSectionsRequested: [],
  originalUserMessageDisplayed: false,
  originalTaskResumedAfterBootstrap: false,
  mutableTask: false,
  originalTaskWriteActionCount: 0,
  noEditGuardTriggered: false,
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
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / APPROX_CHARS_PER_TOKEN) : 0
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function setTmsTurnTelemetry(patch: Partial<TmsTurnTelemetry>): void {
  currentTelemetry = {
    ...currentTelemetry,
    ...patch,
    tmsSectionsAvailable: patch.tmsSectionsAvailable
      ? unique(patch.tmsSectionsAvailable)
      : currentTelemetry.tmsSectionsAvailable,
    tmsSectionsLoaded: patch.tmsSectionsLoaded
      ? unique(patch.tmsSectionsLoaded)
      : currentTelemetry.tmsSectionsLoaded,
    tmsRequestedSections: patch.tmsRequestedSections
      ? unique(patch.tmsRequestedSections)
      : currentTelemetry.tmsRequestedSections,
    tmsSectionsRequested: patch.tmsSectionsRequested
      ? unique(patch.tmsSectionsRequested)
      : currentTelemetry.tmsSectionsRequested,
    readBeforeWriteBlockedTools: patch.readBeforeWriteBlockedTools
      ? unique(patch.readBeforeWriteBlockedTools)
      : currentTelemetry.readBeforeWriteBlockedTools,
    readBeforeWriteBlockedReasons: patch.readBeforeWriteBlockedReasons
      ? unique(patch.readBeforeWriteBlockedReasons)
      : currentTelemetry.readBeforeWriteBlockedReasons,
  }
}


export function markTmsFullContextSent(section: string): void {
  const requested = unique([...currentTelemetry.tmsRequestedSections, section])
  currentTelemetry = {
    ...currentTelemetry,
    tmsContextSentFullThisTurn: true,
    tmsSectionsLoaded: unique([...currentTelemetry.tmsSectionsLoaded, section]),
    tmsRequestedSections: requested,
    tmsSectionsRequested: requested,
  }
}

export function markTmsCreated(path: string): void {
  const updatedExisting = currentTelemetry.tmsFoundAtStart || currentTelemetry.tmsFound
  currentTelemetry = {
    ...currentTelemetry,
    executionPhase: 'project_bootstrap',
    bootstrapCompleted: true,
    tmsCreated: !updatedExisting,
    tmsAlreadyExists: updatedExisting,
    tmsBootstrapFailed: false,
    tmsAvailable: true,
    tmsAvailableAfterBootstrap: true,
    tmsBootstrapCompleted: true,
    tmsPath: path,
    tmsBootstrapPhase: updatedExisting ? 'updated' : 'created',
    tmsBootstrapFailedReason: undefined,
  }
}

export function markTmsWriteAttempt(toolCallId: string, path?: string): void {
  currentTelemetry = {
    ...currentTelemetry,
    tmsWriteAttempted: true,
    tmsWriteToolCallId: toolCallId,
    tmsPath: path ?? currentTelemetry.tmsPath,
    tmsBootstrapPhase: 'writing',
  }
}

export function markTmsBootstrapFailed(reason: string): void {
  if (currentTelemetry.tmsCreated || currentTelemetry.tmsAlreadyExists) return
  currentTelemetry = {
    ...currentTelemetry,
    tmsBootstrapFailed: true,
    tmsBootstrapPhase: 'failed',
    tmsBootstrapFailedReason: reason,
  }
}

export function markOriginalTaskStarted(mutableTask: boolean): void {
  currentTelemetry = {
    ...currentTelemetry,
    executionPhase: 'original_task',
    originalTaskStarted: true,
    mutableTask,
  }
}

export function markOriginalTaskCompleted(): void {
  currentTelemetry = {
    ...currentTelemetry,
    executionPhase: 'original_task',
    originalTaskStarted: true,
    originalTaskCompleted: true,
    originalTaskFailedReason: undefined,
  }
}

export function markOriginalTaskFailed(reason: string): void {
  currentTelemetry = {
    ...currentTelemetry,
    executionPhase: 'original_task',
    originalTaskStarted: true,
    originalTaskCompleted: false,
    originalTaskFailedReason: reason,
  }
}

export function markOriginalTaskWriteStats(writeActionCount: number, firstWriteTurn?: number): void {
  currentTelemetry = {
    ...currentTelemetry,
    originalTaskWriteActionCount: writeActionCount,
    originalTaskFirstWriteTurn: firstWriteTurn,
  }
}

export function markNoEditGuard(reason: string, recoveryAction: string): void {
  currentTelemetry = {
    ...currentTelemetry,
    noEditGuardTriggered: true,
    noEditGuardReason: reason,
    noEditRecoveryAction: recoveryAction,
  }
}

export function markReadBeforeWriteBlocked(
  tool: 'write_file' | 'edit_file',
  reason: 'not_read' | 'partial_view' | 'modified_since_read',
): void {
  currentTelemetry = {
    ...currentTelemetry,
    readBeforeWriteBlocked: true,
    readBeforeWriteBlockCount: currentTelemetry.readBeforeWriteBlockCount + 1,
    readBeforeWriteBlockedTools: unique([...currentTelemetry.readBeforeWriteBlockedTools, tool]),
    readBeforeWriteBlockedReasons: unique([...currentTelemetry.readBeforeWriteBlockedReasons, reason]),
  }
}

export function markProjectSymbolIndexRequested(stats: {
  filesConsidered: number
  filesScanned: number
  entries: number
  truncated: boolean
  tokensEstimate: number
}): void {
  currentTelemetry = {
    ...currentTelemetry,
    symbolIndexRequested: true,
    symbolIndexFilesConsidered: stats.filesConsidered,
    symbolIndexFilesScanned: stats.filesScanned,
    symbolIndexEntries: stats.entries,
    symbolIndexTruncated: stats.truncated,
    symbolIndexTokensEstimate: stats.tokensEstimate,
  }
}

export function markExecuteCommandPurpose(purpose: 'validation' | 'file_read' | 'unknown'): void {
  currentTelemetry = {
    ...currentTelemetry,
    executeCommandPurpose: purpose,
  }
}

export function markShellReadBlocked(converted = false): void {
  currentTelemetry = {
    ...currentTelemetry,
    shellReadBlocked: true,
    shellReadConvertedToFileTool: currentTelemetry.shellReadConvertedToFileTool || converted,
    executeCommandPurpose: 'file_read',
  }
}

export function getTmsTurnTelemetry(): TmsTurnTelemetry {
  return {
    ...currentTelemetry,
    tmsSectionsAvailable: [...currentTelemetry.tmsSectionsAvailable],
    tmsSectionsLoaded: [...currentTelemetry.tmsSectionsLoaded],
    tmsRequestedSections: [...currentTelemetry.tmsRequestedSections],
    tmsSectionsRequested: [...currentTelemetry.tmsSectionsRequested],
    readBeforeWriteBlockedTools: [...currentTelemetry.readBeforeWriteBlockedTools],
    readBeforeWriteBlockedReasons: [...currentTelemetry.readBeforeWriteBlockedReasons],
  }
}


export function decorateTmsRequestUsage<T extends RequestUsageEntry>(
  entry: T,
  systemPrompt: string,
): T {
  const stubMatch = systemPrompt.match(/# Project memory \(TMS\.md stub\)[\s\S]*?(?=\n# |\n__TM_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__|$)/)
  const systemPromptSentFullTms =
    /\n# TMS\.md\n/.test(systemPrompt) ||
    /\n# Project memory\n[\s\S]*TMS\.md/.test(systemPrompt)

  if (stubMatch && currentTelemetry.tmsContextStubTokens === 0) {
    const tokens = estimateTokens(stubMatch[0])
    currentTelemetry = {
      ...currentTelemetry,
      tmsContextStubTokens: tokens,
      tmsStubTokens: tokens,
    }
  }

  if (systemPromptSentFullTms) {
    currentTelemetry = {
      ...currentTelemetry,
      tmsContextSentFullThisTurn: true,
    }
  }

  if (
    currentTelemetry.tmsBootstrapTriggered &&
    currentTelemetry.tmsCreated &&
    !currentTelemetry.originalTaskResumeRequestId
  ) {
    currentTelemetry = {
      ...currentTelemetry,
      originalTaskResumedAfterBootstrap: true,
      originalTaskResumeRequestId: entry.requestId,
    }
  }

  return {
    ...currentTelemetry,
    ...entry,
    tmsSectionsAvailable: [...currentTelemetry.tmsSectionsAvailable],
    tmsSectionsLoaded: [...currentTelemetry.tmsSectionsLoaded],
    tmsRequestedSections: [...currentTelemetry.tmsRequestedSections],
    tmsSectionsRequested: [...currentTelemetry.tmsSectionsRequested],
    readBeforeWriteBlockedTools: [...currentTelemetry.readBeforeWriteBlockedTools],
    readBeforeWriteBlockedReasons: [...currentTelemetry.readBeforeWriteBlockedReasons],
  }
}
