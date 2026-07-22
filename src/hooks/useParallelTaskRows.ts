/**
 * Row models das tarefas paralelas para as superfícies de UI (WelcomeSidebar
 * tree + ProjectMenu dropdown) — UMA fonte para as duas, para nunca mais
 * divergirem (a 1ª iteração só tinha o dock; a 2ª só o menu; o user perdeu
 * tarefas de vista duas vezes).
 *
 * Fusão de duas fontes:
 *  - VIVAS: parallelTaskStore (este processo) — running/queued + terminadas
 *    ainda em memória. Têm runId (Stop) e prompt completo (tooltip).
 *  - PERSISTIDAS: sessões com isParallelTask no índice de sumários do projecto
 *    (sessionService.listSessions). É por ISTO que as tarefas não desaparecem
 *    — o chat de cada tarefa é uma sessão real em disco, consultável sempre
 *    (pedido do user 2026-07-16). Dedup por sessionId; a viva ganha.
 *
 * `needsAuth`: há um pedido de permissão pendente/na fila cujo origin aponta
 * a esta tarefa — as rows sinalizam com badge "Autorização" e o diálogo
 * identifica a tarefa (ver permissionStore.PermissionOrigin).
 */

import { useEffect, useMemo, useState } from 'react'
import { useParallelTaskStore } from '@/stores/parallelTaskStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useAskUserQuestionStore } from '@/stores/askUserQuestionStore'
import { useCredentialRequestStore } from '@/stores/credentialRequestStore'
import { useChatStore } from '@/stores/chatStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { sessionService } from '@/services/agent/sessionService'
import { t } from '@/i18n'
import type { ParallelTaskSessionStatus, SessionSummary } from '@/types/chat'

export interface ParallelTaskRowModel {
  key: string
  /** Live run id (parallelTaskStore) — presente só em tarefas deste processo. */
  runId?: string
  sessionId?: string
  label: string
  /** Prompt completo (tooltip) — só disponível nas vivas. */
  prompt?: string
  status: ParallelTaskSessionStatus | 'queued'
  /** true = está no parallelTaskStore (pode ser parada com Stop). */
  live: boolean
  /** Branch do worktree onde ESTA tarefa trabalha (só nas vivas; o run
   *  principal trabalha no checkout — par do developer, sem worktree). */
  worktreeBranch?: string
  /** Um pedido desta tarefa espera resposta do user. */
  needsAuth: boolean
  /** O que espera: autorização (permissão), pergunta ou credenciais. */
  attentionKind: 'permission' | 'question' | 'credentials' | null
  createdAt: number
}

/** 'running' persistido é fidedigno enquanto o heartbeat do runner (30s)
 *  mantém o updatedAt fresco — mesma doutrina do agent-status.json. Um
 *  'running' velho é um crash/quit: mostra como parada. */
const PERSISTED_RUNNING_STALE_MS = 90_000

export function useParallelTaskRows(
  projectPath: string | null | undefined,
  enabled: boolean,
  opts?: {
    /** Re-lê o índice periodicamente — usado para projetos de OUTRAS janelas
     *  (o parallelTaskStore é por-processo; o disco é o canal partilhado). */
    pollMs?: number
    /** Mudança força re-fetch imediato (ex.: fecho de tarefa). */
    refreshKey?: number
  },
): ParallelTaskRowModel[] {
  const runs = useParallelTaskStore(s => s.runs)
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const permissionQueue = usePermissionStore(s => s.permissionQueue)
  const pendingQuestions = useAskUserQuestionStore(s => s.pending)
  const pendingCredentials = useCredentialRequestStore(s => s.pending)
  const [persisted, setPersisted] = useState<SessionSummary[]>([])

  const liveList = useMemo(
    () =>
      Array.from(runs.values())
        // SÓ as tarefas DESTE projecto — o hook renderiza para todos os
        // projetos da lista (cross-window) e sem o filtro a mesma run viva
        // aparecia debaixo de todos eles (feedback do user 2026-07-16).
        .filter(r => r.projectPath === projectPath)
        .sort((a, b) => a.createdAt - b.createdAt),
    [runs, projectPath],
  )
  // Refetch do índice quando uma tarefa viva TERMINA (o estado final acabou de
  // ser carimbado na sessão) — não a cada tool-event.
  const finishedCount = liveList.filter(r => r.status !== 'running' && r.status !== 'queued').length

  const pollMs = opts?.pollMs
  const refreshKey = opts?.refreshKey
  useEffect(() => {
    if (!enabled || !projectPath) return
    let cancelled = false
    const load = () => {
      void sessionService
        .listSessions(projectPath)
        .then(all => {
          // Cinto-e-suspensórios: o índice já é por-projecto, mas o summary
          // carrega projectPath — filtra também aqui.
          if (!cancelled) setPersisted(all.filter(s => s.isParallelTask === true && s.projectPath === projectPath))
        })
        .catch(() => { /* índice ausente (projecto novo) — sem histórico */ })
    }
    load()
    const timer = pollMs ? setInterval(load, pollMs) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [enabled, projectPath, finishedCount, pollMs, refreshKey])

  return useMemo(() => {
    if (!enabled) return []
    // Fase 1 do modelo foreground: permissões, perguntas E credenciais de
    // tarefas chegam etiquetadas — o mapa taskId→tipo alimenta o badge.
    const attention = new Map<string, 'permission' | 'question' | 'credentials'>()
    for (const entry of pendingCredentials.values()) {
      if (entry.origin) attention.set(entry.origin.taskId, 'credentials')
    }
    for (const entry of pendingQuestions.values()) {
      if (entry.origin) attention.set(entry.origin.taskId, 'question')
    }
    if (pendingPermission?.origin) attention.set(pendingPermission.origin.taskId, 'permission')
    for (const queued of permissionQueue) {
      if (queued.origin) attention.set(queued.origin.taskId, 'permission')
    }

    // UMA SESSÃO = UM AGENTE = UMA ROW (modelo da indústria: o agent view
    // lista CONVERSAS, não runs). Uma CONTINUAÇÃO cria um run novo com o
    // MESMO sessionId — sem este colapso, a sessão aparecia DUPLICADA: a row
    // antiga "Concluída" + a continuação "A trabalhar" com outro label, e o
    // user via estados trocados entre "duas tarefas" que eram uma só
    // (report 2026-07-17). O run mais RECENTE é o estado atual do agente.
    const bySession = new Map<string, typeof liveList[number]>()
    const sessionless: typeof liveList = []
    for (const r of liveList) {
      if (!r.sessionId) { sessionless.push(r); continue }
      const prev = bySession.get(r.sessionId)
      if (!prev || r.createdAt > prev.createdAt) bySession.set(r.sessionId, r)
    }
    const collapsedLive = [...bySession.values(), ...sessionless]
    const liveSessionIds = new Set(collapsedLive.map(r => r.sessionId).filter(Boolean))
    // Título ESTÁVEL: o nome persistido da sessão (o título original da
    // tarefa) vence a descrição derivada da mensagem de continuação — senão
    // o follow-up "renomeava" a tarefa e parecia outra.
    const nameBySession = new Map(persisted.map(s => [s.id, s.name || '']))
    // Posição estável: ordena pela criação da SESSÃO — uma continuação não
    // faz a row saltar para o fim da lista.
    const createdBySession = new Map(persisted.map(s => [s.id, s.createdAt]))
    const liveRows: ParallelTaskRowModel[] = collapsedLive.map(run => ({
      key: run.id,
      runId: run.id,
      sessionId: run.sessionId,
      label: (run.sessionId && nameBySession.get(run.sessionId)) || run.description,
      prompt: run.prompt,
      status: run.status === 'queued' ? 'queued' : run.status,
      worktreeBranch: run.worktree?.branch,
      live: true,
      needsAuth: attention.has(run.id),
      attentionKind: attention.get(run.id) ?? null,
      createdAt: (run.sessionId && createdBySession.get(run.sessionId)) || run.createdAt,
    }))

    const historicalRows: ParallelTaskRowModel[] = persisted
      .filter(s => !liveSessionIds.has(s.id))
      .map(s => ({
        key: `session:${s.id}`,
        sessionId: s.id,
        label: s.name || s.lastMessage || s.id,
        status:
          // 'running' persistido: fidedigno enquanto FRESCO (heartbeat 30s de
          // outra janela — limitação #3 eliminada); velho = crash → parada.
          !s.parallelTaskStatus || s.parallelTaskStatus === 'running'
            ? (s.parallelTaskStatus === 'running' && Date.now() - s.updatedAt < PERSISTED_RUNNING_STALE_MS
                ? 'running'
                : 'aborted')
            : s.parallelTaskStatus,
        live: false,
        needsAuth: false,
        attentionKind: null,
        createdAt: s.createdAt,
      }))

    return [...liveRows, ...historicalRows].sort((a, b) => a.createdAt - b.createdAt)
  }, [enabled, liveList, persisted, pendingPermission, permissionQueue, pendingQuestions, pendingCredentials])
}

/**
 * Volta ao chat PRINCIPAL do projecto (a "porta" da hierarquia): a sessão do
 * run vivo do main quando existe, senão a sessão NÃO-tarefa mais recente em
 * memória. Sem isto, entrar no chat de uma tarefa era sem-retorno — a row do
 * chat principal era um no-op de abrir-projecto (feedback do user 2026-07-17:
 * "fica tudo preso no segundo chat").
 */
export async function openMainSessionChat(projectPath: string): Promise<void> {
  const chat = useChatStore.getState()
  let target: string | null = null
  const streaming = chat.streamingSessionId
  if (streaming && chat.sessions.get(streaming)?.isParallelTask !== true) {
    target = streaming
  } else {
    let bestUpdatedAt = -1
    for (const [id, s] of chat.sessions) {
      if (s.projectPath !== projectPath || s.isParallelTask === true) continue
      if (s.updatedAt > bestUpdatedAt) {
        bestUpdatedAt = s.updatedAt
        target = id
      }
    }
  }
  if (target) {
    if (target !== chat.activeSessionId) chat.setActiveSession(target)
    useLayoutStore.getState().setViewMode('chat')
    return
  }
  // Nada em memória (reload que só restaurou uma sessão de tarefa, ou o ramo
  // "nuke" do delete) — procura no DISCO a sessão principal mais recente.
  try {
    const summaries = await sessionService.listSessions(projectPath)
    const main = summaries.find(s => s.isParallelTask !== true)
    if (main) await chat.loadSessionFromDisk(projectPath, main.id)
  } catch { /* sem índice — fica na vista de chat vazia */ }
  useLayoutStore.getState().setViewMode('chat')
}

/**
 * FECHO pelo developer ("a tarefa só desaparece se o user fechar" — decisão
 * 2026-07-16): apaga o chat da tarefa (sessão em disco) e a entrada viva
 * terminada. O worktree/branch, se existir, FICA no disco — trabalho nunca
 * é destruído por fechar um chat. Confirmação incluída.
 */
export async function closeParallelTask(projectPath: string, sessionId: string): Promise<boolean> {
  const chat = useChatStore.getState()
  // Um run PRINCIPAL pode estar a stremar PARA esta sessão (o user conversou
  // no chat da tarefa terminada) — apagar o alvo vivo deixaria o run a
  // escrever no vazio. Recusa com nota; fecha quando o run acabar.
  if (chat.streamingSessionId === sessionId) {
    chat.addSystemMessage(t('parallel.closeBlockedStreaming'), 'warn')
    return false
  }
  // Row de CONTINUAÇÃO sobre um chat NORMAL (não-tarefa): fechar remove só a
  // entrada viva — o chat é uma conversa normal do user e fica intacto.
  const sessionKind = useChatStore.getState().sessions.get(sessionId)
  if (sessionKind && sessionKind.isParallelTask !== true) {
    const store0 = useParallelTaskStore.getState()
    for (const r of store0.runs.values()) {
      if (r.sessionId === sessionId) { store0.removeClosed(r.id); break }
    }
    return true
  }
  if (!window.confirm(t('parallel.closeConfirm'))) return false
  // Fechar a sessão ATIVA cai no ramo "nuke" do deleteSessionFromDisk (limpa
  // o mapa inteiro em memória). Sai primeiro para o chat principal — o fecho
  // passa a ser o caminho barato de sessão não-ativa.
  if (chat.activeSessionId === sessionId) {
    await openMainSessionChat(projectPath)
    if (useChatStore.getState().activeSessionId === sessionId) {
      // Sem sessão principal para onde ir — segue pelo ramo ativo mesmo.
    }
  }
  const store = useParallelTaskStore.getState()
  for (const r of store.runs.values()) {
    if (r.sessionId === sessionId) {
      store.removeClosed(r.id)
      break
    }
  }
  await useChatStore.getState().deleteSessionFromDisk(projectPath, sessionId)
  return true
}

/**
 * Abre o chat de uma tarefa: sessão em memória → activa já; senão carrega do
 * disco (histórico pós-reload). Seguro DURANTE um run do agente principal —
 * o streaming escreve na sessão captada em startAssistantMessage
 * (streamingSessionId), não na sessão visível.
 */
export async function openParallelTaskChat(projectPath: string, sessionId: string): Promise<void> {
  // Fase 6 (inbox): abrir o chat da tarefa = ver o resultado.
  for (const r of useParallelTaskStore.getState().runs.values()) {
    if (r.sessionId === sessionId) {
      useParallelTaskStore.getState().markResultSeen(r.id)
      break
    }
  }
  const chat = useChatStore.getState()
  if (chat.activeSessionId !== sessionId) {
    if (chat.sessions.has(sessionId)) {
      chat.setActiveSession(sessionId)
    } else {
      await chat.loadSessionFromDisk(projectPath, sessionId)
    }
  }
  useLayoutStore.getState().setViewMode('chat')
}
